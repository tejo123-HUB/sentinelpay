// Computed once per outbound transaction in the route handler and handed to the outbound-only
// rule detectors (server/rules/refundWithoutPurchase.js, payoutToNewReceiver.js,
// outboundRatioAnomaly.js, outboundFanOutBurst.js) -- mirrors how userProfile.js's
// getUserHistory is computed once and shared across the existing 5 rules, keeping those
// detectors pure (data in, decision out) rather than each querying the DB independently.
//
// Uses a 90-day lookback for most fields, deliberately longer than getUserHistory's 24h window:
// a refund or a recurring vendor relationship can legitimately reference a purchase/payout from
// weeks ago, so a short window would make the "no matching purchase" / "new receiver" checks
// false-positive on completely ordinary activity.
const OUTBOUND_LONG_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
// Separate, much shorter window for the fast fan-out-burst check -- that one is deliberately
// about *sudden* activity, not the long-horizon "have I ever paid this receiver" question the
// other fields answer.
const OUTBOUND_BURST_WINDOW_MS = 10 * 60 * 1000;
// A purchase only counts as "prior purchase" credit for refundWithoutPurchase.js once it's at
// least this old -- otherwise an attacker who can call POST /transaction could insert a
// fabricated inbound "purchase" and immediately reference it in a matching outbound "refund",
// defeating the check with a same-request-burst forgery. This doesn't stop a patient attacker
// willing to wait it out, but it closes the immediate/scripted version of the attack, which is
// the one an automated drain would actually use. priorRefundTotal (below) has no such gate --
// a refund just issued must reduce available credit immediately, or the same purchase could be
// refunded repeatedly (see the priorRefundTotal comment).
const OUTBOUND_MIN_PURCHASE_AGE_MS = 5 * 60 * 1000;

// Section 15.16 (Features 1/2/3/7/9): refund-integrity fields, computed alongside the fields
// above so every outbound detector shares one context object and one calling convention
// (check(transaction, outboundContext)) rather than each rule querying the DB independently.
const { REFUND_INTEGRITY } = require('./config');
const { computeMuleScore } = require('./muleScore');

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sender_id: string, receiver_id: string, timestamp: string }} transaction
 * @param {number} nowMs
 * @returns {{
 *   priorPurchaseTotal: number,
 *   priorRefundTotal: number,
 *   priorOutboundCount: number,
 *   knownOutboundReceiverIds: string[],
 *   rollingInboundTotal: number,
 *   rollingOutboundTotal: number,
 *   recentBurstReceiverIds: string[],
 * }}
 */
function getOutboundContext(db, transaction, nowMs) {
  const businessId = transaction.sender_id;
  const counterpartyId = transaction.receiver_id;
  const longSince = new Date(nowMs - OUTBOUND_LONG_LOOKBACK_MS).toISOString();
  const burstSince = new Date(nowMs - OUTBOUND_BURST_WINDOW_MS).toISOString();
  const purchaseCutoff = new Date(nowMs - OUTBOUND_MIN_PURCHASE_AGE_MS).toISOString();

  // Every upper bound below is "<=", not "<": timestamps are server-assigned at millisecond
  // resolution (server/routes/transactions.js's new Date().toISOString()), so two requests for
  // the same account fired fast enough can legitimately land on the same millisecond. A strict
  // "<" would silently drop an earlier same-millisecond row from every one of these totals --
  // exactly the rapid/scripted-attack scenario these checks exist to catch, so the boundary
  // must not be the thing that lets it through. There's no risk of a row matching itself: this
  // function always runs before the current transaction's own row is inserted.
  const priorPurchase = db
    .prepare(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE sender_id = ? AND receiver_id = ? AND timestamp >= ? AND timestamp <= ?'
    )
    .get(counterpartyId, businessId, longSince, purchaseCutoff);

  // Refunds already issued against this customer's purchases at this business account --
  // subtracted from priorPurchaseTotal by refundWithoutPurchase.js so the same purchase can't
  // be used to justify refund after refund. No age gate: a refund issued a millisecond ago must
  // still reduce available credit right now.
  const priorRefund = db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE sender_id = ? AND receiver_id = ? AND LOWER(purpose) LIKE '%refund%' AND timestamp >= ? AND timestamp <= ?"
    )
    .get(businessId, counterpartyId, longSince, transaction.timestamp);

  const priorOutbound = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE sender_id = ? AND timestamp >= ? AND timestamp <= ?')
    .get(businessId, longSince, transaction.timestamp);

  const knownReceiverRows = db
    .prepare('SELECT DISTINCT receiver_id FROM transactions WHERE sender_id = ? AND timestamp >= ? AND timestamp <= ?')
    .all(businessId, longSince, transaction.timestamp);

  const rollingInbound = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE receiver_id = ? AND timestamp >= ? AND timestamp <= ?')
    .get(businessId, longSince, transaction.timestamp);

  const rollingOutbound = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE sender_id = ? AND timestamp >= ? AND timestamp <= ?')
    .get(businessId, longSince, transaction.timestamp);

  const burstReceiverRows = db
    .prepare('SELECT DISTINCT receiver_id FROM transactions WHERE sender_id = ? AND timestamp >= ? AND timestamp <= ?')
    .all(businessId, burstSince, transaction.timestamp);

  // Feature 2 (multiple refunds) / Feature 9 (refund velocity): refund counts in their own,
  // shorter, config-driven windows -- distinct from the 90-day priorRefundTotal above, which
  // exists to reduce refundWithoutPurchase.js's "available credit," not to bound a rate.
  const multiRefundSince = new Date(nowMs - REFUND_INTEGRITY.MULTIPLE_REFUND_WINDOW_MS).toISOString();
  const refundVelocitySince = new Date(nowMs - REFUND_INTEGRITY.REFUND_VELOCITY_WINDOW_MS).toISOString();

  const refundsToCustomer = db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE sender_id = ? AND receiver_id = ? AND LOWER(purpose) LIKE '%refund%' AND timestamp >= ? AND timestamp <= ?"
    )
    .get(businessId, counterpartyId, multiRefundSince, transaction.timestamp);

  const refundVelocity = db
    .prepare(
      "SELECT COUNT(*) AS n FROM transactions WHERE sender_id = ? AND LOWER(purpose) LIKE '%refund%' AND timestamp >= ? AND timestamp <= ?"
    )
    .get(businessId, refundVelocitySince, transaction.timestamp);

  // Feature 1 (account mismatch) / Feature 3 (purchase validation) / Feature 7 (split refund):
  // when this transaction explicitly references the purchase it refunds, look that purchase up
  // and total what's already been refunded against it specifically -- a sharper, per-purchase
  // check than the customer-aggregate priorPurchaseTotal/priorRefundTotal above.
  let referencedPurchase = null;
  let referencedPurchaseRefundedTotal = 0;
  let referencedPurchaseRefundCount = 0;
  if (transaction.reference_transaction_id) {
    referencedPurchase = db
      .prepare('SELECT transaction_id, sender_id, receiver_id, amount, merchant_id FROM transactions WHERE transaction_id = ?')
      .get(transaction.reference_transaction_id) || null;

    const priorRefundsOnPurchase = db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE reference_transaction_id = ? AND timestamp <= ?'
      )
      .get(transaction.reference_transaction_id, transaction.timestamp);
    referencedPurchaseRefundedTotal = priorRefundsOnPurchase.total;
    referencedPurchaseRefundCount = priorRefundsOnPurchase.n;
  }

  // Feature 12 (dormant account): the most recent transaction touching this business account in
  // either direction, before this one -- no lookback cap, since a long gap is exactly what this
  // check is looking for and capping the window would hide it.
  const lastSenderActivity = db
    .prepare('SELECT MAX(timestamp) AS t FROM transactions WHERE sender_id = ? AND timestamp <= ?')
    .get(businessId, transaction.timestamp);
  const lastReceiverActivity = db
    .prepare('SELECT MAX(timestamp) AS t FROM transactions WHERE receiver_id = ? AND timestamp <= ?')
    .get(businessId, transaction.timestamp);
  const lastActivityTimestamp = [lastSenderActivity.t, lastReceiverActivity.t]
    .filter(Boolean)
    .sort()
    .pop() || null;

  // Feature 13 (mule detection): does this transaction's receiver look like a mule account,
  // based on its own lifetime receive-then-quickly-drain history? Computed here (not inside a
  // rule file) since it needs direct DB access, same reasoning as every other field above.
  const receiverMuleScore = computeMuleScore(db, counterpartyId, nowMs);

  return {
    priorPurchaseTotal: priorPurchase.total,
    priorRefundTotal: priorRefund.total,
    priorOutboundCount: priorOutbound.n,
    knownOutboundReceiverIds: knownReceiverRows.map((r) => r.receiver_id),
    rollingInboundTotal: rollingInbound.total,
    rollingOutboundTotal: rollingOutbound.total,
    recentBurstReceiverIds: burstReceiverRows.map((r) => r.receiver_id),
    refundCountToCustomer: refundsToCustomer.n,
    refundTotalToCustomer: refundsToCustomer.total,
    refundVelocityCount: refundVelocity.n,
    referencedPurchase,
    referencedPurchaseRefundedTotal,
    referencedPurchaseRefundCount,
    lastActivityTimestamp,
    receiverMuleScore,
  };
}

getOutboundContext.OUTBOUND_LONG_LOOKBACK_MS = OUTBOUND_LONG_LOOKBACK_MS;
getOutboundContext.OUTBOUND_BURST_WINDOW_MS = OUTBOUND_BURST_WINDOW_MS;
getOutboundContext.OUTBOUND_MIN_PURCHASE_AGE_MS = OUTBOUND_MIN_PURCHASE_AGE_MS;

module.exports = getOutboundContext;
