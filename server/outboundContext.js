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

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sender_id: string, receiver_id: string, timestamp: string }} transaction
 * @param {number} nowMs
 * @returns {{
 *   priorPurchaseTotal: number,
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

  const priorPurchase = db
    .prepare(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE sender_id = ? AND receiver_id = ? AND timestamp >= ? AND timestamp < ?'
    )
    .get(counterpartyId, businessId, longSince, transaction.timestamp);

  const priorOutbound = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE sender_id = ? AND timestamp >= ? AND timestamp < ?')
    .get(businessId, longSince, transaction.timestamp);

  const knownReceiverRows = db
    .prepare('SELECT DISTINCT receiver_id FROM transactions WHERE sender_id = ? AND timestamp >= ? AND timestamp < ?')
    .all(businessId, longSince, transaction.timestamp);

  const rollingInbound = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE receiver_id = ? AND timestamp >= ? AND timestamp < ?')
    .get(businessId, longSince, transaction.timestamp);

  const rollingOutbound = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE sender_id = ? AND timestamp >= ? AND timestamp < ?')
    .get(businessId, longSince, transaction.timestamp);

  const burstReceiverRows = db
    .prepare('SELECT DISTINCT receiver_id FROM transactions WHERE sender_id = ? AND timestamp >= ? AND timestamp < ?')
    .all(businessId, burstSince, transaction.timestamp);

  return {
    priorPurchaseTotal: priorPurchase.total,
    priorOutboundCount: priorOutbound.n,
    knownOutboundReceiverIds: knownReceiverRows.map((r) => r.receiver_id),
    rollingInboundTotal: rollingInbound.total,
    rollingOutboundTotal: rollingOutbound.total,
    recentBurstReceiverIds: burstReceiverRows.map((r) => r.receiver_id),
  };
}

getOutboundContext.OUTBOUND_LONG_LOOKBACK_MS = OUTBOUND_LONG_LOOKBACK_MS;
getOutboundContext.OUTBOUND_BURST_WINDOW_MS = OUTBOUND_BURST_WINDOW_MS;

module.exports = getOutboundContext;
