const { test } = require('node:test');
const assert = require('node:assert/strict');

const velocity = require('../server/rules/velocity');
const impossibleTravel = require('../server/rules/impossibleTravel');
const amountAnomaly = require('../server/rules/amountAnomaly');
const deviceMismatch = require('../server/rules/deviceMismatch');
const oddHour = require('../server/rules/oddHour');
const refundWithoutPurchase = require('../server/rules/refundWithoutPurchase');
const payoutToNewReceiver = require('../server/rules/payoutToNewReceiver');
const outboundRatioAnomaly = require('../server/rules/outboundRatioAnomaly');
const outboundFanOutBurst = require('../server/rules/outboundFanOutBurst');
const refundAccountMismatch = require('../server/rules/refundAccountMismatch');
const multipleRefundDetection = require('../server/rules/multipleRefundDetection');
const splitRefundDetection = require('../server/rules/splitRefundDetection');
const refundVelocity = require('../server/rules/refundVelocity');
const newVendorRisk = require('../server/rules/newVendorRisk');
const dormantAccountReactivation = require('../server/rules/dormantAccountReactivation');
const muleReceiverRisk = require('../server/rules/muleReceiverRisk');
const geoRisk = require('../server/rules/geoRisk');
const merchantAccountTakeover = require('../server/rules/merchantAccountTakeover');
const friendlyFraud = require('../server/rules/friendlyFraud');
const employeeFraud = require('../server/rules/employeeFraud');
const crossGatewayStructuring = require('../server/rules/crossGatewayStructuring');
const duplicateTransaction = require('../server/rules/duplicateTransaction');
const sharedIdentifierRisk = require('../server/rules/sharedIdentifierRisk');

const BASE_TIME = new Date('2026-07-18T12:00:00Z').getTime();

function isoAt(offsetMs) {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

// ---- velocity ----

test('velocity: flags a sender exceeding the transaction rate threshold', () => {
  const recentTransactions = Array.from({ length: 5 }, (_, i) => ({
    timestamp: isoAt(-(i + 1) * 5000), // 5 transactions in the last 25 seconds
  }));
  const transaction = { timestamp: isoAt(0) };

  const result = velocity(transaction, { recentTransactions });

  assert.equal(result.flagged, true);
  assert.match(result.reason, /transactions in/);
  assert.ok(result.weight > 0);
});

test('velocity: does not flag normal transaction frequency', () => {
  const recentTransactions = [{ timestamp: isoAt(-45000) }];
  const transaction = { timestamp: isoAt(0) };

  const result = velocity(transaction, { recentTransactions });

  assert.equal(result.flagged, false);
  assert.equal(result.weight, 0);
});

test('velocity (Dynamic Risk Engine): the exact same burst is NOT flagged for an account whose own learned baseline is already this fast (adaptive, not a fixed count)', () => {
  // Same 6-transactions-in-25s burst as the "flags a sender" test above, but this account's own
  // interval baseline says ~5s apart is completely normal for them (a high-throughput storefront,
  // say) -- the whole point of an adaptive baseline over a fixed "5 in 60s" rule.
  const recentTransactions = Array.from({ length: 5 }, (_, i) => ({
    timestamp: isoAt(-(i + 1) * 5000),
  }));
  const transaction = { timestamp: isoAt(0) };
  const intervalBaseline = { count: 500, mean: 5000, m2: 500 * (1000 * 1000) }; // ~5s mean, ~1s stddev, well-established

  const result = velocity(transaction, { recentTransactions, intervalBaseline });

  assert.equal(result.flagged, false);
});

test('velocity (Dynamic Risk Engine): a burst well within this account\'s own normal variance is not flagged, even if it would look fast in isolation', () => {
  const recentTransactions = Array.from({ length: 5 }, (_, i) => ({
    timestamp: isoAt(-(i + 1) * 10000), // 5 in 50s
  }));
  const transaction = { timestamp: isoAt(0) };
  // This account's own history: averages one every ~11s with a wide spread (high variance) --
  // a ~10s burst is unremarkable for them specifically.
  const intervalBaseline = { count: 200, mean: 11000, m2: 200 * (4000 * 4000) };

  const result = velocity(transaction, { recentTransactions, intervalBaseline });

  assert.equal(result.flagged, false);
});

test('velocity (Dynamic Risk Engine): a burst far faster than this account\'s own established baseline is flagged, even at a low absolute count', () => {
  // Only 3 total transactions in the burst (below the old fixed "5" threshold entirely) -- but
  // this account's own baseline says one every ~10 minutes, tightly, so three in under a minute
  // is a real behavioral deviation for *them* specifically.
  const recentTransactions = [{ timestamp: isoAt(-20000) }, { timestamp: isoAt(-40000) }];
  const transaction = { timestamp: isoAt(0) };
  const intervalBaseline = { count: 100, mean: 10 * 60 * 1000, m2: 100 * (30 * 1000) ** 2 };

  const result = velocity(transaction, { recentTransactions, intervalBaseline });

  assert.equal(result.flagged, true);
  assert.match(result.reason, /σ faster than this account's own typical pace/);
});

test('velocity (Dynamic Risk Engine): a burst below the minimum count is never flagged regardless of z-score', () => {
  const recentTransactions = [{ timestamp: isoAt(-5000) }];
  const transaction = { timestamp: isoAt(0) };
  // An extremely tight, fast baseline that would otherwise make even this pair look "slow" --
  // irrelevant, since a single prior transaction can't establish a burst at all.
  const intervalBaseline = { count: 100, mean: 3 * 60 * 60 * 1000, m2: 100 * (1000) ** 2 };

  const result = velocity(transaction, { recentTransactions, intervalBaseline });

  assert.equal(result.flagged, false);
});

// ---- impossibleTravel ----

test('impossibleTravel: flags a location jump implying implausible speed', () => {
  const userHistory = {
    recentTransactions: [
      { timestamp: isoAt(-30000), location: { lat: 16.5062, lng: 80.6480 } }, // Vijayawada
    ],
  };
  const transaction = {
    timestamp: isoAt(0),
    location: { lat: 19.0760, lng: 72.8777 }, // Mumbai, ~700km away, 30s later
  };

  const result = impossibleTravel(transaction, userHistory);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /km location jump/);
});

test('impossibleTravel: does not flag a small, plausible location change', () => {
  const userHistory = {
    recentTransactions: [
      { timestamp: isoAt(-600000), location: { lat: 16.5062, lng: 80.6480 } },
    ],
  };
  const transaction = {
    timestamp: isoAt(0),
    location: { lat: 16.5100, lng: 80.6500 }, // a couple km away, 10 minutes later
  };

  const result = impossibleTravel(transaction, userHistory);

  assert.equal(result.flagged, false);
});

// ---- amountAnomaly (Dynamic Risk Engine: z-score against the sender's own amount baseline) ----

test('amountAnomaly: flags an amount far above the user average', () => {
  // count=10, mean=200, modest spread (stddev=50) -- 4000 is a real, extreme outlier for this
  // specific account's own history, not just a fixed "3x the average" rule.
  const userHistory = { user: { avg_transaction_amount: 200 }, amountBaseline: { count: 10, mean: 200, m2: 10 * 50 * 50 } };
  const transaction = { amount: 4000 };

  const result = amountAnomaly(transaction, userHistory);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /average spend/);
  assert.match(result.reason, /σ above/);
});

test('amountAnomaly: does not flag an amount close to the user average', () => {
  const userHistory = { user: { avg_transaction_amount: 200 }, amountBaseline: { count: 10, mean: 200, m2: 10 * 50 * 50 } };
  const transaction = { amount: 250 };

  const result = amountAnomaly(transaction, userHistory);

  assert.equal(result.flagged, false);
});

test('amountAnomaly: skips users without meaningful history', () => {
  const userHistory = { user: { avg_transaction_amount: 50 }, amountBaseline: { count: 1, mean: 50, m2: 0 } };
  const transaction = { amount: 5000 };

  const result = amountAnomaly(transaction, userHistory);

  assert.equal(result.flagged, false);
});

test('amountAnomaly (Dynamic Risk Engine): the same amount is flagged for a low-variance spender but not for a high-variance one (adaptive, not a fixed multiplier)', () => {
  // Both accounts average ₹500 and this transaction is ₹1800 (3.6x average) -- the exact kind of
  // amount the old fixed "3x the average" rule would have flagged for *both* accounts identically.
  const transaction = { amount: 1800 };

  const tightSpender = {
    user: { avg_transaction_amount: 500 },
    amountBaseline: { count: 20, mean: 500, m2: 20 * 100 * 100 }, // stddev=100 -- consistently spends close to ₹500
  };
  const wideSpender = {
    user: { avg_transaction_amount: 500 },
    amountBaseline: { count: 20, mean: 500, m2: 20 * 600 * 600 }, // stddev=600 -- routinely spends anywhere from ₹0 to ₹2000+
  };

  assert.equal(amountAnomaly(transaction, tightSpender).flagged, true);
  assert.equal(amountAnomaly(transaction, wideSpender).flagged, false);
});

test('amountAnomaly: the stddev floor scales with the account\'s own average, not a flat currency amount', () => {
  // A high-average business account (₹50,000 typical) whose amounts happen to be nearly
  // identical so far (m2≈0, a tiny real stddev) must not become absurdly sensitive to any
  // deviation -- the floor scales to 10% of its own average, not a flat ₹10.
  const userHistory = { user: { avg_transaction_amount: 50000 }, amountBaseline: { count: 5, mean: 50000, m2: 5 * 1 * 1 } };
  // 15% above average -- unremarkable for a business this size, must not flag against a flat
  // near-zero floor the way it would have without the relative floor.
  const transaction = { amount: 57500 };

  const result = amountAnomaly(transaction, userHistory);

  assert.equal(result.flagged, false);
});

// ---- deviceMismatch ----

test('deviceMismatch: flags a previously unseen device', () => {
  const userHistory = { knownDeviceIds: ['d_1', 'd_2'] };
  const transaction = { device_id: 'd_new' };

  const result = deviceMismatch(transaction, userHistory);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /unseen device/);
});

test('deviceMismatch: does not flag a known device', () => {
  const userHistory = { knownDeviceIds: ['d_1', 'd_2'] };
  const transaction = { device_id: 'd_1' };

  const result = deviceMismatch(transaction, userHistory);

  assert.equal(result.flagged, false);
});

test('deviceMismatch: does not flag a brand-new user\'s first device', () => {
  const userHistory = { knownDeviceIds: [] };
  const transaction = { device_id: 'd_1' };

  const result = deviceMismatch(transaction, userHistory);

  assert.equal(result.flagged, false);
});

// ---- oddHour ----

test('oddHour: flags a transaction outside typical active hours', () => {
  const userHistory = { user: { typical_active_hours: [[8, 22]] } };
  const transaction = { timestamp: '2026-07-18T03:00:00Z' };

  const result = oddHour(transaction, userHistory);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /outside this user's typical active hours/);
});

test('oddHour: does not flag a transaction inside typical active hours', () => {
  const userHistory = { user: { typical_active_hours: [[8, 22]] } };
  const transaction = { timestamp: '2026-07-18T13:00:00Z' };

  const result = oddHour(transaction, userHistory);

  assert.equal(result.flagged, false);
});

test('oddHour: skips users without an established baseline', () => {
  const userHistory = { user: { typical_active_hours: null } };
  const transaction = { timestamp: '2026-07-18T03:00:00Z' };

  const result = oddHour(transaction, userHistory);

  assert.equal(result.flagged, false);
});

// ---- refundWithoutPurchase ----

test('refundWithoutPurchase: flags a refund with no matching prior purchase', () => {
  const transaction = { amount: 500, purpose: 'Refund - order #123' };
  const result = refundWithoutPurchase(transaction, { priorPurchaseTotal: 0 });

  assert.equal(result.flagged, true);
  assert.match(result.reason, /no matching prior purchase/);
});

test('refundWithoutPurchase: flags a refund exceeding total prior purchases', () => {
  const transaction = { amount: 500, purpose: 'Refund - order #123' };
  const result = refundWithoutPurchase(transaction, { priorPurchaseTotal: 200 });

  assert.equal(result.flagged, true);
  assert.match(result.reason, /exceeds this customer's total prior purchases/);
});

test('refundWithoutPurchase: does not flag a refund backed by sufficient prior purchases', () => {
  const transaction = { amount: 500, purpose: 'Refund - order #123' };
  const result = refundWithoutPurchase(transaction, { priorPurchaseTotal: 500 });

  assert.equal(result.flagged, false);
});

test('refundWithoutPurchase: ignores non-refund transactions entirely (e.g. vendor payouts)', () => {
  const transaction = { amount: 5000, purpose: 'Payout - settlement to business bank account' };
  const result = refundWithoutPurchase(transaction, { priorPurchaseTotal: 0 });

  assert.equal(result.flagged, false);
});

test('refundWithoutPurchase: flags a second refund against a purchase already fully refunded (regression)', () => {
  // A single ₹500 purchase must not justify refund after refund -- priorRefundTotal (the first
  // ₹500 refund already issued) has to reduce the available credit to 0 for the second one.
  const transaction = { amount: 500, purpose: 'Refund - order #2' };
  const result = refundWithoutPurchase(transaction, { priorPurchaseTotal: 500, priorRefundTotal: 500 });

  assert.equal(result.flagged, true);
  assert.match(result.reason, /remaining purchase credit/);
  assert.match(result.reason, /500\.00 already refunded/);
});

test('refundWithoutPurchase: allows a refund within what remains after a partial prior refund', () => {
  const transaction = { amount: 200, purpose: 'Refund - order #2' };
  const result = refundWithoutPurchase(transaction, { priorPurchaseTotal: 500, priorRefundTotal: 300 });

  assert.equal(result.flagged, false);
});

// ---- refundWithoutPurchase: reference_transaction_id path (Section 15.16, Feature 3) ----

test('refundWithoutPurchase: flags a refund referencing a purchase that does not exist', () => {
  const transaction = { amount: 500, purpose: 'Refund - order #9', sender_id: 'm_1', reference_transaction_id: 't_missing' };
  const result = refundWithoutPurchase(transaction, { referencedPurchase: null });

  assert.equal(result.flagged, true);
  assert.match(result.reason, /does not exist/);
  assert.equal(result.severity, 'High');
});

test('refundWithoutPurchase: flags a referenced purchase not made to this business account', () => {
  const transaction = { amount: 500, purpose: 'Refund', sender_id: 'm_1', reference_transaction_id: 't_1' };
  const context = { referencedPurchase: { transaction_id: 't_1', sender_id: 'u_1', receiver_id: 'm_other', amount: 500, merchant_id: null } };
  const result = refundWithoutPurchase(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /not made to this business account/);
});

test('refundWithoutPurchase: flags a referenced purchase made through a different gateway', () => {
  const transaction = { amount: 500, purpose: 'Refund', sender_id: 'm_1', merchant_id: 'gw_b', reference_transaction_id: 't_1' };
  const context = {
    referencedPurchase: { transaction_id: 't_1', sender_id: 'u_1', receiver_id: 'm_1', amount: 500, merchant_id: 'gw_a' },
    referencedPurchaseRefundedTotal: 0,
  };
  const result = refundWithoutPurchase(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /different gateway|gw_a/);
});

test('refundWithoutPurchase: flags a refund against an already-fully-refunded referenced purchase', () => {
  const transaction = { amount: 100, purpose: 'Refund', sender_id: 'm_1', reference_transaction_id: 't_1' };
  const context = {
    referencedPurchase: { transaction_id: 't_1', sender_id: 'u_1', receiver_id: 'm_1', amount: 500, merchant_id: null },
    referencedPurchaseRefundedTotal: 500,
  };
  const result = refundWithoutPurchase(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /already been fully refunded/);
});

test('refundWithoutPurchase: flags a refund exceeding what remains on the referenced purchase', () => {
  const transaction = { amount: 300, purpose: 'Refund', sender_id: 'm_1', reference_transaction_id: 't_1' };
  const context = {
    referencedPurchase: { transaction_id: 't_1', sender_id: 'u_1', receiver_id: 'm_1', amount: 500, merchant_id: null },
    referencedPurchaseRefundedTotal: 300,
  };
  const result = refundWithoutPurchase(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /exceeds the remaining refundable amount/);
});

test('refundWithoutPurchase: allows a valid referenced refund within the remaining amount', () => {
  const transaction = { amount: 200, purpose: 'Refund', sender_id: 'm_1', merchant_id: 'gw_a', reference_transaction_id: 't_1' };
  const context = {
    referencedPurchase: { transaction_id: 't_1', sender_id: 'u_1', receiver_id: 'm_1', amount: 500, merchant_id: 'gw_a' },
    referencedPurchaseRefundedTotal: 300,
  };
  const result = refundWithoutPurchase(transaction, context);

  assert.equal(result.flagged, false);
});

// ---- refundAccountMismatch (Section 15.16, Feature 1) ----

test('refundAccountMismatch: flags a refund sent to a different account than the original payer', () => {
  const transaction = { purpose: 'Refund - order #1', receiver_id: 'u_evil', reference_transaction_id: 't_1' };
  const context = { referencedPurchase: { sender_id: 'u_1', receiver_id: 'm_1', amount: 500 } };
  const result = refundAccountMismatch(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /Refund destination does not match original payment account\./);
  assert.match(result.reason, /original: u_1/);
  assert.match(result.reason, /refund: u_evil/);
  assert.equal(result.severity, 'High');
});

test('refundAccountMismatch: does not flag a refund back to the original payer', () => {
  const transaction = { purpose: 'Refund - order #1', receiver_id: 'u_1', reference_transaction_id: 't_1' };
  const context = { referencedPurchase: { sender_id: 'u_1', receiver_id: 'm_1', amount: 500 } };
  const result = refundAccountMismatch(transaction, context);

  assert.equal(result.flagged, false);
});

test('refundAccountMismatch: does not flag when there is no reference_transaction_id', () => {
  const transaction = { purpose: 'Refund - order #1', receiver_id: 'u_evil', reference_transaction_id: null };
  const result = refundAccountMismatch(transaction, { referencedPurchase: null });

  assert.equal(result.flagged, false);
});

test('refundAccountMismatch: ignores non-refund transactions', () => {
  const transaction = { purpose: 'Payout', receiver_id: 'u_evil', reference_transaction_id: 't_1' };
  const context = { referencedPurchase: { sender_id: 'u_1' } };
  const result = refundAccountMismatch(transaction, context);

  assert.equal(result.flagged, false);
});

// ---- multipleRefundDetection (Dynamic Risk Engine: adaptive refund-pacing baseline) ----

test('multipleRefundDetection: flags a refund arriving much faster than this pair\'s own established refund pacing', () => {
  const transaction = { amount: 100, purpose: 'Refund', timestamp: isoAt(0) };
  const context = {
    lastRefundToCustomerAt: isoAt(-3600 * 1000), // 1 hour ago
    // This customer/business pair's own history: refunds roughly every 30 days, tightly (~2 day stddev).
    refundIntervalBaseline: { count: 10, mean: 30 * 24 * 60 * 60 * 1000, m2: 10 * (2 * 24 * 60 * 60 * 1000) ** 2 },
  };
  const result = multipleRefundDetection(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /Multiple refund attempts detected/);
  assert.match(result.reason, /faster than this customer's usual refund pacing/);
});

test('multipleRefundDetection: flags cumulative refunds exceeding the original purchase', () => {
  const transaction = { amount: 300, purpose: 'Refund', timestamp: isoAt(0) };
  // No lastRefundToCustomerAt -- this is their first-ever refund from this business, so the
  // pacing check has nothing to compare against and correctly falls through to the purchase check.
  const context = { referencedPurchase: { amount: 500 }, referencedPurchaseRefundedTotal: 300 };
  const result = multipleRefundDetection(transaction, context);

  assert.equal(result.flagged, true);
  assert.equal(result.reason, 'Refund amount exceeds original purchase.');
});

// Bug fix (post-merge audit): refundWithoutPurchase.js's referenced-purchase branch and
// multipleRefundDetection.js's purchase-exceeds branch previously both fired on the exact same
// underlying fact whenever a refund named the purchase it exceeded (outboundContext.js only ever
// populates referencedPurchase/referencedPurchaseRefundedTotal together with
// reference_transaction_id) -- double-counting one real signal as 55+50=105 weight, enough alone
// to force a block that neither detector's own severity would justify. Confirms only
// refundWithoutPurchase.js flags this case now, using a realistic context shape (a
// reference_transaction_id is set, matching how outboundContext.js actually wires this).
test('multipleRefundDetection + refundWithoutPurchase: do not double-count the same "exceeds original purchase" fact when a reference_transaction_id is given (regression)', () => {
  const transaction = {
    amount: 300,
    purpose: 'Refund',
    timestamp: isoAt(0),
    sender_id: 'biz_1',
    receiver_id: 'cust_1',
    reference_transaction_id: 't_original_purchase',
    merchant_id: null,
  };
  const context = {
    referencedPurchase: { transaction_id: 't_original_purchase', receiver_id: 'biz_1', amount: 500, merchant_id: null },
    referencedPurchaseRefundedTotal: 300,
  };

  const multipleResult = multipleRefundDetection(transaction, context);
  const withoutPurchaseResult = refundWithoutPurchase(transaction, context);

  assert.equal(multipleResult.flagged, false, 'multipleRefundDetection should defer to refundWithoutPurchase when a reference is given');
  assert.equal(withoutPurchaseResult.flagged, true);
  assert.match(withoutPurchaseResult.reason, /exceeds the remaining refundable amount/);
});

test('multipleRefundDetection: does not flag a single ordinary refund', () => {
  const transaction = { amount: 100, purpose: 'Refund', timestamp: isoAt(0) };
  const context = { referencedPurchase: { amount: 500 }, referencedPurchaseRefundedTotal: 0 };
  const result = multipleRefundDetection(transaction, context);

  assert.equal(result.flagged, false);
});

test('multipleRefundDetection (Dynamic Risk Engine): the same 1-hour refund gap is NOT flagged for a pair whose own baseline says frequent refunds are routine', () => {
  // Same interval as the "flags" test above, but this business/customer pair's own established
  // pattern already involves refunds roughly every few hours -- routine for *them*, not the same
  // fixed count/window that would apply identically to every pair.
  const transaction = { amount: 100, purpose: 'Refund', timestamp: isoAt(0) };
  const context = {
    lastRefundToCustomerAt: isoAt(-3600 * 1000),
    refundIntervalBaseline: { count: 20, mean: 2 * 3600 * 1000, m2: 20 * (3600 * 1000) ** 2 }, // ~2h mean, ~1h stddev
  };
  const result = multipleRefundDetection(transaction, context);

  assert.equal(result.flagged, false);
});

test('multipleRefundDetection: a pair with no established baseline yet falls back to a conservative default pace, not a hair-trigger', () => {
  const transaction = { amount: 100, purpose: 'Refund', timestamp: isoAt(0) };
  // Their second-ever refund, six days after the first -- close to the conservative default
  // (7 days) assumed for a pair with no real pacing history yet, so it reads as unremarkable
  // rather than getting compared against an overly tight assumption.
  const context = { lastRefundToCustomerAt: isoAt(-6 * 24 * 3600 * 1000), refundIntervalBaseline: { count: 1, mean: 6 * 24 * 3600 * 1000, m2: 0 } };
  const result = multipleRefundDetection(transaction, context);

  assert.equal(result.flagged, false);
});

// ---- splitRefundDetection (Section 15.16, Feature 7) ----

test('splitRefundDetection: flags a purchase refunded via several smaller transactions', () => {
  // 10000 purchase refunded as 5 x 2000 -- the 5th pushes count to 5 and cumulative to 10000.
  const transaction = { amount: 2000, purpose: 'Refund', reference_transaction_id: 't_1' };
  const context = {
    referencedPurchase: { amount: 10000 },
    referencedPurchaseRefundCount: 4,
    referencedPurchaseRefundedTotal: 8000,
  };
  const result = splitRefundDetection(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /split into 5 separate transactions/);
});

test('splitRefundDetection: does not flag a single partial refund', () => {
  const transaction = { amount: 2000, purpose: 'Refund', reference_transaction_id: 't_1' };
  const context = { referencedPurchase: { amount: 10000 }, referencedPurchaseRefundCount: 0, referencedPurchaseRefundedTotal: 0 };
  const result = splitRefundDetection(transaction, context);

  assert.equal(result.flagged, false);
});

test('splitRefundDetection: does not flag several small refunds that never reach the purchase total', () => {
  const transaction = { amount: 500, purpose: 'Refund', reference_transaction_id: 't_1' };
  const context = { referencedPurchase: { amount: 10000 }, referencedPurchaseRefundCount: 4, referencedPurchaseRefundedTotal: 2000 };
  const result = splitRefundDetection(transaction, context);

  assert.equal(result.flagged, false);
});

// ---- refundVelocity (Section 15.16, Feature 9) ----

test('refundVelocity: flags an unusually high refund rate', () => {
  const transaction = { purpose: 'Refund' };
  const result = refundVelocity(transaction, { refundVelocityCount: 19 });

  assert.equal(result.flagged, true);
  assert.equal(result.reason, 'Unusual refund velocity.');
});

test('refundVelocity: does not flag a normal refund rate', () => {
  const transaction = { purpose: 'Refund' };
  const result = refundVelocity(transaction, { refundVelocityCount: 2 });

  assert.equal(result.flagged, false);
});

// ---- payoutToNewReceiver ----

test('payoutToNewReceiver: flags a payout to a receiver never paid before', () => {
  const transaction = { receiver_id: 'u_new', purpose: null };
  const context = { priorOutboundCount: 5, knownOutboundReceiverIds: ['u_a', 'u_b'] };

  const result = payoutToNewReceiver(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /never paid before/);
});

test('payoutToNewReceiver: does not flag a payout to an already-known receiver', () => {
  const transaction = { receiver_id: 'u_a', purpose: null };
  const context = { priorOutboundCount: 5, knownOutboundReceiverIds: ['u_a', 'u_b'] };

  const result = payoutToNewReceiver(transaction, context);

  assert.equal(result.flagged, false);
});

test('payoutToNewReceiver: skips a business account with no baseline history yet', () => {
  const transaction = { receiver_id: 'u_new', purpose: null };
  const context = { priorOutboundCount: 1, knownOutboundReceiverIds: [] };

  const result = payoutToNewReceiver(transaction, context);

  assert.equal(result.flagged, false);
});

test('payoutToNewReceiver: ignores refund-purpose transactions (a first refund is normal)', () => {
  const transaction = { receiver_id: 'u_new', purpose: 'Refund - order #123' };
  const context = { priorOutboundCount: 10, knownOutboundReceiverIds: [] };

  const result = payoutToNewReceiver(transaction, context);

  assert.equal(result.flagged, false);
});

// ---- outboundRatioAnomaly ----

test('outboundRatioAnomaly: flags outbound total far exceeding inbound revenue', () => {
  const transaction = { amount: 1000 };
  const context = { rollingInboundTotal: 500, rollingOutboundTotal: 200 };

  const result = outboundRatioAnomaly(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /x inbound revenue/);
  // Regression: this branch's severity was silently dropped by an earlier replace_all edit
  // that only matched one of the file's two "flagged: true" return statements (see the
  // ratio-exceeds-threshold branch specifically, distinct from the zero-inbound branch below).
  assert.equal(result.severity, 'Medium');
});

test('outboundRatioAnomaly: flags outbound with zero recorded inbound once there is prior outbound history', () => {
  const transaction = { amount: 100 };
  const context = { rollingInboundTotal: 0, rollingOutboundTotal: 500 };

  const result = outboundRatioAnomaly(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /no recorded inbound revenue/);
});

test('outboundRatioAnomaly: does not flag a business account\'s very first transaction', () => {
  const transaction = { amount: 100 };
  const context = { rollingInboundTotal: 0, rollingOutboundTotal: 0 };

  const result = outboundRatioAnomaly(transaction, context);

  assert.equal(result.flagged, false);
});

test('outboundRatioAnomaly: does not flag outbound comfortably within inbound revenue', () => {
  const transaction = { amount: 100 };
  const context = { rollingInboundTotal: 5000, rollingOutboundTotal: 200 };

  const result = outboundRatioAnomaly(transaction, context);

  assert.equal(result.flagged, false);
  assert.equal(result.severity, null);
});

// ---- outboundFanOutBurst ----

test('outboundFanOutBurst: flags 3+ distinct new receivers within the burst window', () => {
  const transaction = { receiver_id: 'u_c' };
  const context = { knownOutboundReceiverIds: [], recentBurstReceiverIds: ['u_a', 'u_b'] };

  const result = outboundFanOutBurst(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /distinct new payout receivers/);
});

test('outboundFanOutBurst: does not count already-known receivers toward the threshold', () => {
  const transaction = { receiver_id: 'u_c' };
  const context = { knownOutboundReceiverIds: ['u_a', 'u_b'], recentBurstReceiverIds: ['u_a', 'u_b'] };

  const result = outboundFanOutBurst(transaction, context);

  assert.equal(result.flagged, false);
});

test('outboundFanOutBurst: does not flag fewer than the threshold of new receivers', () => {
  const transaction = { receiver_id: 'u_b' };
  const context = { knownOutboundReceiverIds: [], recentBurstReceiverIds: ['u_a'] };

  const result = outboundFanOutBurst(transaction, context);

  assert.equal(result.flagged, false);
});

// ---- newVendorRisk (Section 15.16, Feature 5) ----

test('newVendorRisk: force-blocks a very high value payment to a new vendor', () => {
  const transaction = { amount: 300000, receiver_id: 'u_new', purpose: null };
  const context = { priorOutboundCount: 5, knownOutboundReceiverIds: ['u_a'] };
  const result = newVendorRisk(transaction, context);

  assert.equal(result.flagged, true);
  assert.equal(result.reason, 'High value payment to new vendor.');
  assert.ok(result.weight >= 80, 'weight alone should be enough to force a block');
});

test('newVendorRisk: step-up tier for a moderately high value payment to a new vendor', () => {
  const transaction = { amount: 60000, receiver_id: 'u_new', purpose: null };
  const context = { priorOutboundCount: 5, knownOutboundReceiverIds: ['u_a'] };
  const result = newVendorRisk(transaction, context);

  assert.equal(result.flagged, true);
  assert.ok(result.weight >= 40 && result.weight < 80);
});

test('newVendorRisk: does not flag a small payment to a new vendor', () => {
  const transaction = { amount: 100, receiver_id: 'u_new', purpose: null };
  const context = { priorOutboundCount: 5, knownOutboundReceiverIds: ['u_a'] };
  const result = newVendorRisk(transaction, context);

  assert.equal(result.flagged, false);
});

test('newVendorRisk: does not flag a large payment to an already-known vendor', () => {
  const transaction = { amount: 300000, receiver_id: 'u_a', purpose: null };
  const context = { priorOutboundCount: 5, knownOutboundReceiverIds: ['u_a'] };
  const result = newVendorRisk(transaction, context);

  assert.equal(result.flagged, false);
});

test('newVendorRisk: ignores refund-purpose transactions', () => {
  const transaction = { amount: 300000, receiver_id: 'u_new', purpose: 'Refund' };
  const context = { priorOutboundCount: 5, knownOutboundReceiverIds: [] };
  const result = newVendorRisk(transaction, context);

  assert.equal(result.flagged, false);
});

// ---- dormantAccountReactivation (Section 15.16, Feature 12) ----

test('dormantAccountReactivation: flags a large transaction after 180+ days of inactivity', () => {
  const transaction = { amount: 20000, timestamp: '2026-07-18T00:00:00Z' };
  const context = { lastActivityTimestamp: '2026-01-01T00:00:00Z' };
  const result = dormantAccountReactivation(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /Dormant account reactivated with abnormal activity\./);
});

test('dormantAccountReactivation: does not flag a large transaction from a recently active account', () => {
  const transaction = { amount: 20000, timestamp: '2026-07-18T00:00:00Z' };
  const context = { lastActivityTimestamp: '2026-07-17T00:00:00Z' };
  const result = dormantAccountReactivation(transaction, context);

  assert.equal(result.flagged, false);
});

test('dormantAccountReactivation: does not flag a small transaction even after a long gap', () => {
  const transaction = { amount: 10, timestamp: '2026-07-18T00:00:00Z' };
  const context = { lastActivityTimestamp: '2026-01-01T00:00:00Z' };
  const result = dormantAccountReactivation(transaction, context);

  assert.equal(result.flagged, false);
});

test('dormantAccountReactivation: does not flag a brand-new account with no prior history', () => {
  const transaction = { amount: 20000, timestamp: '2026-07-18T00:00:00Z' };
  const context = { lastActivityTimestamp: null };
  const result = dormantAccountReactivation(transaction, context);

  assert.equal(result.flagged, false);
});

// ---- muleReceiverRisk (Section 15.16, Feature 13) ----

test('muleReceiverRisk: flags a receiver with a suspected-mule pattern', () => {
  const transaction = { receiver_id: 'u_mule' };
  const context = { receiverMuleScore: { isMule: true, qualifyingCycles: 3 } };
  const result = muleReceiverRisk(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /Suspected Mule Account/);
  assert.equal(result.severity, 'Critical');
});

test('muleReceiverRisk: does not flag a receiver with no mule pattern', () => {
  const transaction = { receiver_id: 'u_clean' };
  const context = { receiverMuleScore: { isMule: false, qualifyingCycles: 0 } };
  const result = muleReceiverRisk(transaction, context);

  assert.equal(result.flagged, false);
});

// ---- geoRisk (Section 15.16, Feature 14) ----

test('geoRisk: flags a transaction from a configured high-risk country', () => {
  const config = require('../server/config');
  const transaction = { country: config.GEO_RISK.HIGH_RISK_COUNTRIES[0], ip_address: null };
  const result = geoRisk(transaction);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /high-risk country/);
});

test('geoRisk: flags a transaction from a configured high-risk IP prefix', () => {
  const config = require('../server/config');
  const transaction = { country: null, ip_address: `${config.GEO_RISK.HIGH_RISK_IP_PREFIXES[0]}42` };
  const result = geoRisk(transaction);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /high-risk IP range/);
});

test('geoRisk: does not flag an ordinary country/IP', () => {
  const transaction = { country: 'US', ip_address: '10.0.0.1' };
  const result = geoRisk(transaction);

  assert.equal(result.flagged, false);
});

test('geoRisk: does not flag when country/ip_address are absent', () => {
  const transaction = { country: null, ip_address: null };
  const result = geoRisk(transaction);

  assert.equal(result.flagged, false);
});

// ---- merchantAccountTakeover (Section 15.16, Feature 4) ----

test('merchantAccountTakeover: flags a transaction following an unrecognized-device login', () => {
  const transaction = { purpose: 'Refund' };
  const context = {
    takeoverRisk: {
      loginTimestamp: '2026-07-18T10:00:00Z',
      currentDevice: 'd_new',
      previousDevice: 'd_old',
      currentCountry: 'RU',
      previousCountry: 'IN',
    },
  };
  const result = merchantAccountTakeover(transaction, context);

  assert.equal(result.flagged, true);
  assert.equal(result.severity, 'Critical');
  assert.match(result.reason, /previous device: d_old/);
  assert.match(result.reason, /current device: d_new/);
});

test('merchantAccountTakeover: does not flag when there is no takeover risk', () => {
  const transaction = { purpose: 'Refund' };
  const result = merchantAccountTakeover(transaction, { takeoverRisk: null });

  assert.equal(result.flagged, false);
});

// ---- friendlyFraud (Section 15.16, Feature 8) ----

test('friendlyFraud: flags a repeat-dispute customer more strongly than an elevated-risk one', () => {
  const transaction = { purpose: 'Refund' };
  const repeat = friendlyFraud(transaction, { disputeCount: 3 });
  const elevated = friendlyFraud(transaction, { disputeCount: 2 });

  assert.equal(repeat.flagged, true);
  assert.equal(elevated.flagged, true);
  assert.ok(repeat.weight > elevated.weight);
});

test('friendlyFraud: does not flag a customer with no dispute history', () => {
  const transaction = { purpose: 'Refund' };
  const result = friendlyFraud(transaction, { disputeCount: 0 });

  assert.equal(result.flagged, false);
});

test('friendlyFraud: ignores non-refund transactions', () => {
  const transaction = { purpose: 'Payout' };
  const result = friendlyFraud(transaction, { disputeCount: 10 });

  assert.equal(result.flagged, false);
});

// ---- employeeFraud (Section 15.16, Feature 10) ----

test('employeeFraud: flags an employee repeatedly refunding the same receiver', () => {
  const transaction = { purpose: 'Refund', employee_id: 'e_1' };
  const context = { employeeRefundCount: 1, employeeRefundCountToReceiver: 2 };
  const result = employeeFraud(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /repeatedly issued refunds to the same receiver/);
});

test('employeeFraud: flags an employee issuing an excessive number of refunds overall', () => {
  const transaction = { purpose: 'Refund', employee_id: 'e_1' };
  const context = { employeeRefundCount: 9, employeeRefundCountToReceiver: 0 };
  const result = employeeFraud(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /unusually high number of refunds/);
});

test('employeeFraud: does not flag without an employee_id', () => {
  const transaction = { purpose: 'Refund', employee_id: null };
  const context = { employeeRefundCount: 9, employeeRefundCountToReceiver: 2 };
  const result = employeeFraud(transaction, context);

  assert.equal(result.flagged, false);
});

test('employeeFraud: does not flag a normal, low-volume refund', () => {
  const transaction = { purpose: 'Refund', employee_id: 'e_2' };
  const context = { employeeRefundCount: 1, employeeRefundCountToReceiver: 0 };
  const result = employeeFraud(transaction, context);

  assert.equal(result.flagged, false);
});

// ---- crossGatewayStructuring (Section 15.16, Feature 11) ----

test('crossGatewayStructuring: flags a large cumulative payout to one receiver spread across gateways', () => {
  const transaction = { amount: 20000, merchant_id: 'gw_b' };
  const context = { crossGatewayIds: ['gw_a'], crossGatewayTotal: 15000 };
  const result = crossGatewayStructuring(transaction, context);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /Cross gateway transaction structuring detected\./);
});

test('crossGatewayStructuring: does not flag a single gateway even at high cumulative total', () => {
  const transaction = { amount: 20000, merchant_id: 'gw_a' };
  const context = { crossGatewayIds: ['gw_a'], crossGatewayTotal: 15000 };
  const result = crossGatewayStructuring(transaction, context);

  assert.equal(result.flagged, false);
});

test('crossGatewayStructuring: does not flag multiple gateways below the total threshold', () => {
  const transaction = { amount: 100, merchant_id: 'gw_b' };
  const context = { crossGatewayIds: ['gw_a'], crossGatewayTotal: 200 };
  const result = crossGatewayStructuring(transaction, context);

  assert.equal(result.flagged, false);
});

// ---- duplicateTransaction (Section 16, Category 2) ----

test('duplicateTransaction: flags a transaction duplicating one sent moments ago', () => {
  const transaction = { amount: 500 };
  const result = duplicateTransaction(transaction, { duplicateTransactionCount: 1 });

  assert.equal(result.flagged, true);
  assert.match(result.reason, /Duplicate of 1 other transaction/);
});

test('duplicateTransaction: does not flag a transaction with no recent duplicate', () => {
  const transaction = { amount: 500 };
  const result = duplicateTransaction(transaction, { duplicateTransactionCount: 0 });

  assert.equal(result.flagged, false);
});

// ---- sharedIdentifierRisk (Section 16, Category 4/10) ----

test('sharedIdentifierRisk: flags a device shared with other accounts', () => {
  const result = sharedIdentifierRisk({}, { sharedDeviceAccountIds: ['u_a', 'u_b'], sharedIpAccountIds: [] });

  assert.equal(result.flagged, true);
  assert.match(result.reason, /Device shared with 2 other account/);
});

test('sharedIdentifierRisk: flags an IP shared with other accounts', () => {
  const result = sharedIdentifierRisk({}, { sharedDeviceAccountIds: [], sharedIpAccountIds: ['u_a'] });

  assert.equal(result.flagged, true);
  assert.match(result.reason, /IP address shared with 1 other account/);
});

test('sharedIdentifierRisk: flags a shared phone number', () => {
  const result = sharedIdentifierRisk({}, { sharedDeviceAccountIds: [], sharedIpAccountIds: [], sharedPhoneAccountIds: ['u_a'] });

  assert.equal(result.flagged, true);
  assert.match(result.reason, /Phone number shared with 1 other account/);
  assert.equal(result.severity, 'Medium');
});

test('sharedIdentifierRisk: flags a shared email address', () => {
  const result = sharedIdentifierRisk({}, { sharedDeviceAccountIds: [], sharedIpAccountIds: [], sharedEmailAccountIds: ['u_a', 'u_b'] });

  assert.equal(result.flagged, true);
  assert.match(result.reason, /Email address shared with 2 other account/);
});

test('sharedIdentifierRisk: a shared identity-document hash is Critical-adjacent High severity and takes precedence over a shared device', () => {
  const result = sharedIdentifierRisk(
    {},
    { sharedDeviceAccountIds: ['u_a'], sharedIpAccountIds: [], sharedIdentityHashAccountIds: ['u_c'] }
  );

  assert.equal(result.flagged, true);
  assert.match(result.reason, /Identity document hash shared with 1 other account/);
  assert.equal(result.severity, 'High');
  assert.equal(result.weight, sharedIdentifierRisk.SHARED_IDENTITY_HASH_WEIGHT);
});

test('sharedIdentifierRisk: does not flag when neither device nor IP is shared', () => {
  const result = sharedIdentifierRisk({}, { sharedDeviceAccountIds: [], sharedIpAccountIds: [] });

  assert.equal(result.flagged, false);
});

// ---- Regression guard: every `return { flagged: ... }` in every rule file must include a
// `severity` key. Added after a live-verification pass found 5 detectors (amountAnomaly,
// deviceMismatch, oddHour, payoutToNewReceiver, outboundRatioAnomaly) where an earlier
// `replace_all` severity-backfill edit had silently matched only some of a file's multiple
// return statements (different indentation levels broke the exact-string match), leaving one
// branch's `severity` undefined instead of a real value or explicit `null`. None of the
// per-detector unit tests above caught it, because each only exercised the fixture path that
// happened to hit an already-fixed branch. This is a source-shape check, not a behavioral one --
// same category as tests/dashboard.test.js's `defer`-attribute check -- specifically so it
// can't be defeated the same way a per-branch unit test can (by simply not testing that branch).
const fs = require('node:fs');
const path = require('node:path');

test('every rule detector file: every return object literal includes a severity key', () => {
  const rulesDir = path.join(__dirname, '..', 'server', 'rules');
  const missing = [];

  for (const file of fs.readdirSync(rulesDir)) {
    if (!file.endsWith('.js')) continue;
    const rawSource = fs.readFileSync(path.join(rulesDir, file), 'utf-8');
    // Template-literal interpolations (`${multiple}x the average`) contain literal `{`/`}`
    // characters that are NOT object-literal braces -- a naive `[^{}]*` match stops at the
    // first one and silently produces a truncated, always-"passing" match. Verified this the
    // hard way: an earlier version of this exact test kept passing even with `severity`
    // deliberately deleted from a flagged branch, because the truncated match never reached far
    // enough to see it was missing. None of these files nest a nested object/array *inside* an
    // interpolation (verified by eye across all 23 files, and this is enforced structurally by
    // Section 14's "flat {flagged, reason, weight, severity} literal" convention), so replacing
    // every `${...}` span with a brace-free placeholder first is safe and makes plain `[^{}]*`
    // bracket-matching correct again.
    const source = rawSource.replace(/\$\{[^}]*\}/g, 'X');
    const returnObjectPattern = /return\s*\{[^{}]*\}/gs;
    let match;
    while ((match = returnObjectPattern.exec(source)) !== null) {
      // A real `severity:` key, not just the word "severity" appearing anywhere in the match
      // (e.g. inside a comment) -- caught the hard way while verifying this very test: a first
      // draft used a bare /severity/ check, which happily matched a `// severity removed for
      // test` comment left behind by the deliberate-bug reproduction below, so the test kept
      // passing with no real severity key present at all.
      if (!/severity\s*:/.test(match[0])) {
        const lineNumber = source.slice(0, match.index).split('\n').length;
        missing.push(`${file}:${lineNumber}`);
      }
    }
  }

  assert.deepEqual(missing, [], `expected every return object to include severity, but these are missing it: ${missing.join(', ')}`);
});
