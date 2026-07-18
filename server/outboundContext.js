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
const { REFUND_INTEGRITY, MERCHANT_TAKEOVER, FRIENDLY_FRAUD, EMPLOYEE_FRAUD, CROSS_GATEWAY, DUPLICATE_DETECTION, SHARED_IDENTIFIER_RISK, DEVICE_FINGERPRINT_RISK } = require('./config');
const { computeMuleScore } = require('./muleScore');
const { isBusinessAccount } = require('./businessAccounts');

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
  // Skipped for the business's own registered accounts: a merchant receiving customer payments
  // and paying them back out (refunds, settlements, vendor payouts) is normal business
  // operation, not the mule pattern this check exists to catch -- without this exclusion, any
  // business account with ordinary refund/payout activity technically satisfies the generic
  // receive-then-drain heuristic and gets mislabeled a "Suspected Mule Account."
  const receiverMuleScore = isBusinessAccount(db, counterpartyId)
    ? { qualifyingCycles: 0, receiptsScanned: 0, isMule: false }
    : computeMuleScore(db, counterpartyId, nowMs);

  // Feature 4 (merchant account takeover): the most recent login for this business account
  // within the takeover window -- and, if there was one, whether its device had ever logged in
  // for this merchant before that login (a genuinely new device, not just "not used recently").
  //
  // Every boundary below is "rowid" (SQLite's implicit, monotonically-increasing insertion
  // order), not just "timestamp", as the tiebreaker -- login timestamps are server-assigned at
  // millisecond resolution (same as transactions.timestamp elsewhere in this file), so two
  // POST /merchant-logins calls fired fast enough (a demo/seed script, or just a loaded test
  // suite) can legitimately land on the same millisecond. A plain "ORDER BY timestamp DESC"
  // would then pick a tied row nondeterministically, and a strict "timestamp < recentLogin's"
  // comparison for "previous login" would silently exclude a same-millisecond earlier login
  // entirely -- the same class of bug already fixed once in this file (Section 15.13, finding
  // #3) for the refund-context queries. rowid is unique even when timestamps tie, so ordering
  // and excluding "the recent login's own row" by rowid is exact where timestamp alone is not.
  const takeoverWindowSince = new Date(nowMs - MERCHANT_TAKEOVER.TAKEOVER_WINDOW_MS).toISOString();
  const recentLogin = db
    .prepare(
      'SELECT rowid AS rowid_, login_id, device_id, ip_address, location_lat, location_lng, country, timestamp FROM merchant_login_events WHERE merchant_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC, rowid DESC LIMIT 1'
    )
    .get(businessId, takeoverWindowSince, transaction.timestamp);

  let takeoverRisk = null;
  if (recentLogin) {
    const previousLogin = db
      .prepare(
        'SELECT device_id, country FROM merchant_login_events WHERE merchant_id = ? AND rowid != ? AND timestamp <= ? ORDER BY timestamp DESC, rowid DESC LIMIT 1'
      )
      .get(businessId, recentLogin.rowid_, recentLogin.timestamp);

    const isNewDevice =
      !!recentLogin.device_id &&
      (!previousLogin ||
        db
          .prepare('SELECT COUNT(*) AS n FROM merchant_login_events WHERE merchant_id = ? AND device_id = ? AND rowid != ? AND timestamp <= ?')
          .get(businessId, recentLogin.device_id, recentLogin.rowid_, recentLogin.timestamp).n === 0);

    if (isNewDevice && previousLogin) {
      takeoverRisk = {
        loginTimestamp: recentLogin.timestamp,
        currentDevice: recentLogin.device_id,
        previousDevice: previousLogin.device_id,
        currentCountry: recentLogin.country,
        previousCountry: previousLogin.country,
      };
    }
  }

  // Feature 8 (friendly fraud): how many disputes has this transaction's counterparty (the
  // customer, on a refund) filed in the lookback window -- feeds a customer risk score
  // independent of whether any single dispute was itself fraudulent.
  const disputeSince = new Date(nowMs - FRIENDLY_FRAUD.DISPUTE_WINDOW_MS).toISOString();
  const disputeCountRow = db
    .prepare('SELECT COUNT(*) AS n FROM disputes WHERE customer_id = ? AND created_at >= ? AND created_at <= ?')
    .get(counterpartyId, disputeSince, transaction.timestamp);

  // Feature 10 (employee fraud): how many refunds has this transaction's employee_id issued
  // recently, and how many of those went to this same receiver -- only meaningful when the
  // caller actually supplies employee_id, same optional-field pattern as reference_transaction_id.
  let employeeRefundCount = 0;
  let employeeRefundCountToReceiver = 0;
  if (transaction.employee_id) {
    const employeeWindowSince = new Date(nowMs - EMPLOYEE_FRAUD.EMPLOYEE_REFUND_WINDOW_MS).toISOString();
    const employeeRefunds = db
      .prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE employee_id = ? AND LOWER(purpose) LIKE '%refund%' AND timestamp >= ? AND timestamp <= ?"
      )
      .get(transaction.employee_id, employeeWindowSince, transaction.timestamp);
    employeeRefundCount = employeeRefunds.n;

    const employeeRefundsToReceiver = db
      .prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE employee_id = ? AND receiver_id = ? AND LOWER(purpose) LIKE '%refund%' AND timestamp >= ? AND timestamp <= ?"
      )
      .get(transaction.employee_id, counterpartyId, employeeWindowSince, transaction.timestamp);
    employeeRefundCountToReceiver = employeeRefundsToReceiver.n;
  }

  // Feature 11 (cross-gateway structuring): distinct merchant_id gateways this business account
  // has already used to pay this specific receiver within the cross-gateway window, and the
  // cumulative amount across all of them -- spreading payouts to the same receiver across
  // several gateways is the pattern this detects, mirroring how fan-out spreads across receivers.
  const crossGatewaySince = new Date(nowMs - CROSS_GATEWAY.CROSS_GATEWAY_WINDOW_MS).toISOString();
  const crossGatewayRows = db
    .prepare(
      'SELECT DISTINCT merchant_id FROM transactions WHERE sender_id = ? AND receiver_id = ? AND merchant_id IS NOT NULL AND timestamp >= ? AND timestamp <= ?'
    )
    .all(businessId, counterpartyId, crossGatewaySince, transaction.timestamp);
  const crossGatewayTotalRow = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE sender_id = ? AND receiver_id = ? AND timestamp >= ? AND timestamp <= ?')
    .get(businessId, counterpartyId, crossGatewaySince, transaction.timestamp);

  // Section 16, Category 2: has this business account sent an identical (same receiver, same
  // amount) transaction within the last minute? An accidental double-submit or a scripted
  // replay signature, distinct from every existing detector.
  const duplicateSince = new Date(nowMs - DUPLICATE_DETECTION.DUPLICATE_WINDOW_MS).toISOString();
  const duplicateCountRow =
    typeof transaction.amount === 'number'
      ? db
          .prepare(
            'SELECT COUNT(*) AS n FROM transactions WHERE sender_id = ? AND receiver_id = ? AND amount = ? AND timestamp >= ? AND timestamp <= ?'
          )
          .get(businessId, counterpartyId, transaction.amount, duplicateSince, transaction.timestamp)
      : { n: 0 };

  // Section 16, Category 4/10/11: other accounts that have used this transaction's device_id/
  // ip_address/phone/email/identity_hash recently -- the per-transaction reduction of "shared
  // device/IP/phone/email/identity graph" analysis, without a graph database or visualization
  // layer. identity_hash is a caller-computed hash of a government ID (PAN/Aadhaar/etc) -- this
  // system never sees or stores the raw document number, only the opaque token, so "shared
  // identity document" detection (Category 11) works without collecting the PII itself.
  const sharedSince = new Date(nowMs - SHARED_IDENTIFIER_RISK.SHARED_IDENTIFIER_LOOKBACK_MS).toISOString();
  // `column` is always one of the five hardcoded string literals passed below, never derived
  // from request input -- safe to interpolate directly, the same reasoning already applied to
  // this file's other dynamically-built IN (...) clauses elsewhere in this codebase.
  function findSharedAccountIds(column, value) {
    if (!value) return [];
    return db
      .prepare(`SELECT DISTINCT sender_id FROM transactions WHERE ${column} = ? AND sender_id != ? AND timestamp >= ? AND timestamp <= ?`)
      .all(value, businessId, sharedSince, transaction.timestamp)
      .map((r) => r.sender_id);
  }
  const sharedDeviceAccountIds = findSharedAccountIds('device_id', transaction.device_id);
  const sharedIpAccountIds = findSharedAccountIds('ip_address', transaction.ip_address);
  const sharedPhoneAccountIds = findSharedAccountIds('phone', transaction.phone);
  const sharedEmailAccountIds = findSharedAccountIds('email', transaction.email);
  const sharedIdentityHashAccountIds = findSharedAccountIds('identity_hash', transaction.identity_hash);

  // Section 16, Category 10: Device Reputation Engine. device_id is self-reported by the calling
  // gateway (same trust level as ip_address/country elsewhere in this file), so this can't detect
  // rooting/emulation -- but it can score two real, observable signals: has this exact device_id
  // been attached to a prior flagged (step_up/block) transaction, from *any* sender, recently? A
  // device genuinely tied to prior fraud is a materially stronger signal than "device is merely
  // shared" (sharedIdentifierRisk.js's job, above) -- this is "shared AND that other usage was
  // itself bad." No age gate beyond the lookback window: unlike the refund-credit fields above,
  // there's no forgery incentive here (an attacker can't retroactively un-flag a past transaction).
  const devicePriorFlagSince = new Date(nowMs - DEVICE_FINGERPRINT_RISK.DEVICE_PRIOR_FLAG_LOOKBACK_MS).toISOString();
  const devicePriorFlagCount = transaction.device_id
    ? db
        .prepare(
          "SELECT COUNT(*) AS n FROM transactions WHERE device_id = ? AND decision IN ('step_up', 'block') AND timestamp >= ? AND timestamp <= ?"
        )
        .get(transaction.device_id, devicePriorFlagSince, transaction.timestamp).n
    : 0;

  // Self-reported user_agent matching a known automation/scripting signature -- a weaker,
  // heuristic signal (an automation tool can lie about its UA just as easily as a real one), so
  // it's scored lower than devicePriorFlagCount above.
  const suspiciousUserAgent =
    typeof transaction.user_agent === 'string' && DEVICE_FINGERPRINT_RISK.SUSPICIOUS_UA_PATTERN.test(transaction.user_agent);

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
    takeoverRisk,
    disputeCount: disputeCountRow.n,
    employeeRefundCount,
    employeeRefundCountToReceiver,
    crossGatewayIds: crossGatewayRows.map((r) => r.merchant_id),
    crossGatewayTotal: crossGatewayTotalRow.total,
    duplicateTransactionCount: duplicateCountRow.n,
    sharedDeviceAccountIds,
    sharedIpAccountIds,
    sharedPhoneAccountIds,
    sharedEmailAccountIds,
    sharedIdentityHashAccountIds,
    devicePriorFlagCount,
    suspiciousUserAgent,
  };
}

getOutboundContext.OUTBOUND_LONG_LOOKBACK_MS = OUTBOUND_LONG_LOOKBACK_MS;
getOutboundContext.OUTBOUND_BURST_WINDOW_MS = OUTBOUND_BURST_WINDOW_MS;
getOutboundContext.OUTBOUND_MIN_PURCHASE_AGE_MS = OUTBOUND_MIN_PURCHASE_AGE_MS;

module.exports = getOutboundContext;
