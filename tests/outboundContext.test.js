const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { SCHEMA } = require('../server/db');
const getOutboundContext = require('../server/outboundContext');
const applyOutboundRestrictors = require('../server/outboundRestrictor');
const { isBusinessAccount } = require('../server/businessAccounts');

const NOW_MS = new Date('2026-07-18T12:00:00Z').getTime();

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function insertUser(db, userId) {
  db.prepare('INSERT OR IGNORE INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run(
    userId,
    new Date(NOW_MS).toISOString()
  );
}

function insertTransaction(db, { senderId, receiverId, amount, msAgo, purpose = null, merchantId = null, referenceTransactionId = null, transactionId, deviceId = null, decision = 'allow' }) {
  insertUser(db, senderId);
  insertUser(db, receiverId);
  const id = transactionId || `t_${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO transactions
      (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, fraud_score, decision, purpose, merchant_id, reference_transaction_id, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    senderId,
    receiverId,
    amount,
    new Date(NOW_MS - msAgo).toISOString(),
    'transfer',
    0,
    decision,
    purpose,
    merchantId,
    referenceTransactionId,
    deviceId
  );
  return id;
}

// ---- isBusinessAccount ----

test('isBusinessAccount: true once registered, false otherwise', () => {
  const db = buildTestDb();
  db.prepare('INSERT INTO business_accounts (account_id, created_at) VALUES (?, ?)').run(
    'm_store_x',
    new Date(NOW_MS).toISOString()
  );

  assert.equal(isBusinessAccount(db, 'm_store_x'), true);
  assert.equal(isBusinessAccount(db, 'u_customer'), false);
});

// ---- getOutboundContext ----

// Purchases must be older than OUTBOUND_MIN_PURCHASE_AGE_MS (5 minutes) to count as "prior
// purchase" credit -- everything in this test is well outside that window.
const OLD_ENOUGH_MS = 10 * 60 * 1000; // 10 minutes -- comfortably past the 5-minute purchase-age gate

test('getOutboundContext: priorPurchaseTotal sums only this customer\'s payments to this business account', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'u_1', receiverId: 'm_biz', amount: 100, msAgo: OLD_ENOUGH_MS + 60000 });
  insertTransaction(db, { senderId: 'u_1', receiverId: 'm_biz', amount: 50, msAgo: OLD_ENOUGH_MS + 30000 });
  insertTransaction(db, { senderId: 'u_1', receiverId: 'm_other', amount: 999, msAgo: OLD_ENOUGH_MS + 20000 }); // different business -- excluded
  insertTransaction(db, { senderId: 'u_2', receiverId: 'm_biz', amount: 999, msAgo: OLD_ENOUGH_MS + 10000 }); // different customer -- excluded

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.priorPurchaseTotal, 150);
});

test('getOutboundContext: a purchase younger than the minimum age does not count as prior-purchase credit yet', () => {
  const db = buildTestDb();
  // 2 minutes old -- inside the 90-day lookback, but younger than the 5-minute purchase-age gate.
  insertTransaction(db, { senderId: 'u_1', receiverId: 'm_biz', amount: 500, msAgo: 2 * 60 * 1000 });

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(
    context.priorPurchaseTotal,
    0,
    'a same-burst fabricated purchase should not be usable as immediate refund credit'
  );
});

test('getOutboundContext: priorRefundTotal sums refunds already issued to this customer, reducing available credit', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'u_1', receiverId: 'm_biz', amount: 500, msAgo: OLD_ENOUGH_MS + 60000 }); // purchase
  db.prepare(
    `INSERT INTO transactions
      (transaction_id, sender_id, receiver_id, amount, timestamp, purpose, transaction_type, fraud_score, decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    't_refund_1',
    'm_biz',
    'u_1',
    500,
    new Date(NOW_MS - 30000).toISOString(),
    'Refund - order #1',
    'transfer',
    0,
    'allow'
  );

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.priorPurchaseTotal, 500);
  assert.equal(context.priorRefundTotal, 500);
});

test('getOutboundContext: knownOutboundReceiverIds and priorOutboundCount reflect this business account\'s own history', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_a', amount: 10, msAgo: 60000 });
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_b', amount: 10, msAgo: 30000 });

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_c', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.priorOutboundCount, 2);
  assert.deepEqual(context.knownOutboundReceiverIds.sort(), ['u_a', 'u_b']);
});

test('getOutboundContext: rollingInboundTotal/rollingOutboundTotal are scoped to this business account', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'u_1', receiverId: 'm_biz', amount: 300, msAgo: 60000 }); // inbound
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_2', amount: 100, msAgo: 30000 }); // outbound

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_3', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.rollingInboundTotal, 300);
  assert.equal(context.rollingOutboundTotal, 100);
});

test('getOutboundContext: recentBurstReceiverIds only includes the short burst window, not the full lookback', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_old', amount: 10, msAgo: 60 * 60 * 1000 }); // 1h ago -- outside the 10-min burst window
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_recent', amount: 10, msAgo: 60 * 1000 }); // 1 minute ago -- inside it

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_new', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.deepEqual(context.recentBurstReceiverIds, ['u_recent']);
  assert.ok(context.knownOutboundReceiverIds.includes('u_old'), 'the long lookback should still include the older receiver');
});

// ---- getOutboundContext: Section 15.16 refund-integrity fields ----

test('getOutboundContext: referencedPurchase resolves the named purchase and its refunded total', () => {
  const db = buildTestDb();
  const purchaseId = insertTransaction(db, { senderId: 'u_1', receiverId: 'm_biz', amount: 500, msAgo: OLD_ENOUGH_MS, merchantId: 'gw_a' });
  insertTransaction(db, {
    senderId: 'm_biz',
    receiverId: 'u_1',
    amount: 200,
    msAgo: 60 * 1000,
    purpose: 'Refund',
    referenceTransactionId: purchaseId,
  });

  const context = getOutboundContext(
    db,
    { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString(), reference_transaction_id: purchaseId },
    NOW_MS
  );

  assert.equal(context.referencedPurchase.sender_id, 'u_1');
  assert.equal(context.referencedPurchase.receiver_id, 'm_biz');
  assert.equal(context.referencedPurchase.amount, 500);
  assert.equal(context.referencedPurchase.merchant_id, 'gw_a');
  assert.equal(context.referencedPurchaseRefundedTotal, 200);
  assert.equal(context.referencedPurchaseRefundCount, 1);
});

test('getOutboundContext: receiverMuleScore is never computed for the business\'s own registered accounts (regression)', () => {
  // A merchant receiving customer payments and paying them back out (refunds, settlements) is
  // normal operation -- without this exclusion, any business account with ordinary refund/payout
  // activity technically satisfies the generic receive-then-drain heuristic and gets mislabeled
  // a "Suspected Mule Account." Found live while visually checking the Analytics dashboard.
  const db = buildTestDb();
  db.prepare('INSERT INTO business_accounts (account_id, created_at) VALUES (?, ?)').run('m_biz', new Date(NOW_MS).toISOString());
  insertTransaction(db, { senderId: 'u_customer', receiverId: 'm_biz', amount: 1000, msAgo: 20 * 60 * 1000 });
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_other', amount: 900, msAgo: 15 * 60 * 1000, purpose: 'Refund' });
  insertTransaction(db, { senderId: 'u_customer2', receiverId: 'm_biz', amount: 1000, msAgo: 10 * 60 * 1000 });
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_other2', amount: 950, msAgo: 6 * 60 * 1000, purpose: 'Refund' });

  const context = getOutboundContext(db, { sender_id: 'm_biz2', receiver_id: 'm_biz', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.receiverMuleScore.isMule, false);
  assert.equal(context.receiverMuleScore.qualifyingCycles, 0);
});

test('getOutboundContext: referencedPurchase is null when no reference_transaction_id is given', () => {
  const db = buildTestDb();
  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.referencedPurchase, null);
  assert.equal(context.referencedPurchaseRefundedTotal, 0);
  assert.equal(context.referencedPurchaseRefundCount, 0);
});

test('getOutboundContext: refundCountToCustomer/refundTotalToCustomer scoped to the multiple-refund window', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_1', amount: 50, msAgo: 60 * 1000, purpose: 'Refund' });
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_1', amount: 75, msAgo: 2 * 60 * 1000, purpose: 'Refund' });
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_other', amount: 999, msAgo: 60 * 1000, purpose: 'Refund' }); // different customer, must not count

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.refundCountToCustomer, 2);
  assert.equal(context.refundTotalToCustomer, 125);
});

test('getOutboundContext: refundVelocityCount counts all recent refunds from this business account regardless of receiver', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_1', amount: 10, msAgo: 5000, purpose: 'Refund' });
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_2', amount: 10, msAgo: 5000, purpose: 'Refund' });
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_3', amount: 10, msAgo: 5000, purpose: 'Payout' }); // not a refund, must not count

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_4', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.refundVelocityCount, 2);
});

test('getOutboundContext: lastActivityTimestamp reflects the most recent transaction in either direction', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'u_other', receiverId: 'm_biz', amount: 10, msAgo: 5 * 24 * 60 * 60 * 1000 }); // 5 days ago, business as receiver
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_other2', amount: 10, msAgo: 24 * 60 * 60 * 1000 }); // 1 day ago, business as sender -- more recent

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_new', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.lastActivityTimestamp, new Date(NOW_MS - 24 * 60 * 60 * 1000).toISOString());
});

test('getOutboundContext: lastActivityTimestamp is null for an account with no prior transactions', () => {
  const db = buildTestDb();
  const context = getOutboundContext(db, { sender_id: 'm_brand_new', receiver_id: 'u_new', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.lastActivityTimestamp, null);
});

test('getOutboundContext: receiverMuleScore reflects the receiver\'s receive-then-drain history', () => {
  const db = buildTestDb();
  // u_mule receives 1000, then sends 900 (90%) back out within the mule window, twice.
  insertTransaction(db, { senderId: 'm_other', receiverId: 'u_mule', amount: 1000, msAgo: 20 * 60 * 1000 });
  insertTransaction(db, { senderId: 'u_mule', receiverId: 'u_downstream', amount: 900, msAgo: 15 * 60 * 1000 });
  insertTransaction(db, { senderId: 'm_other2', receiverId: 'u_mule', amount: 1000, msAgo: 10 * 60 * 1000 });
  insertTransaction(db, { senderId: 'u_mule', receiverId: 'u_downstream2', amount: 950, msAgo: 6 * 60 * 1000 });

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_mule', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.receiverMuleScore.isMule, true);
  assert.equal(context.receiverMuleScore.qualifyingCycles, 2);
});

// ---- checkFraudLists (server/fraudLists.js, Section 16) ----

test('checkFraudLists: detects blacklist/whitelist/watchlist membership for either sender or receiver', () => {
  const { checkFraudLists } = require('../server/fraudLists');
  const db = buildTestDb();
  db.prepare('INSERT INTO fraud_lists (entry_id, list_type, account_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'fl_1', 'blacklist', 'u_bad', 'confirmed fraud', new Date(NOW_MS).toISOString()
  );
  db.prepare('INSERT INTO fraud_lists (entry_id, list_type, account_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'fl_2', 'whitelist', 'u_good', null, new Date(NOW_MS).toISOString()
  );

  const hitAsSender = checkFraudLists(db, 'u_bad', 'u_unrelated');
  assert.equal(hitAsSender.blacklisted, true);
  assert.equal(hitAsSender.blacklistEntries[0].reason, 'confirmed fraud');

  const hitAsReceiver = checkFraudLists(db, 'u_unrelated', 'u_good');
  assert.equal(hitAsReceiver.whitelisted, true);

  const noHit = checkFraudLists(db, 'u_clean_1', 'u_clean_2');
  assert.equal(noHit.blacklisted, false);
  assert.equal(noHit.whitelisted, false);
  assert.equal(noHit.watchlisted, false);
});

// ---- computeMuleScore (server/muleScore.js, Section 15.16 Feature 13) ----

test('computeMuleScore: a receiver with no withdrawal-back-out history is not a mule', () => {
  const { computeMuleScore } = require('../server/muleScore');
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_clean', amount: 1000, msAgo: 60 * 1000 });

  const score = computeMuleScore(db, 'u_clean', NOW_MS);

  assert.equal(score.isMule, false);
  assert.equal(score.qualifyingCycles, 0);
});

test('computeMuleScore: still correctly counts an outflow that shares the exact same millisecond as its receipt (regression)', () => {
  // A fast automated drain (or, as found live, a fast local test run) can produce a receipt and
  // its immediate outflow at the exact same millisecond -- a strict "timestamp > receipt" bound
  // would silently exclude that outflow from the ratio, undercounting a genuine mule pattern.
  const { computeMuleScore } = require('../server/muleScore');
  const db = buildTestDb();
  const tiedTimestamp = new Date(NOW_MS - 5 * 60 * 1000).toISOString();
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_fast_mule', amount: 1000, transactionId: 't_receipt', msAgo: 0 });
  // Overwrite the timestamp directly to force an exact tie -- insertTransaction's own msAgo
  // parameter can't express "the same millisecond as another row" cleanly.
  db.prepare('UPDATE transactions SET timestamp = ? WHERE transaction_id = ?').run(tiedTimestamp, 't_receipt');
  insertTransaction(db, { senderId: 'u_fast_mule', receiverId: 'u_downstream', amount: 950, transactionId: 't_outflow', msAgo: 0 });
  db.prepare('UPDATE transactions SET timestamp = ? WHERE transaction_id = ?').run(tiedTimestamp, 't_outflow');

  const score = computeMuleScore(db, 'u_fast_mule', NOW_MS);

  assert.equal(score.qualifyingCycles, 1, 'the same-millisecond outflow should still count toward the ratio');
});

// ---- getOutboundContext: Section 15.16 Features 4/8/10/11 ----

function insertMerchantLogin(db, { merchantId, deviceId, country = null, msAgo }) {
  db.prepare(
    'INSERT INTO merchant_login_events (login_id, merchant_id, device_id, country, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(`login_${Math.random().toString(36).slice(2)}`, merchantId, deviceId, country, new Date(NOW_MS - msAgo).toISOString(), new Date(NOW_MS).toISOString());
}

test('getOutboundContext: takeoverRisk is set for a genuinely new device logging in shortly before this transaction', () => {
  const db = buildTestDb();
  insertMerchantLogin(db, { merchantId: 'm_biz', deviceId: 'd_old', country: 'IN', msAgo: 60 * 60 * 1000 });
  insertMerchantLogin(db, { merchantId: 'm_biz', deviceId: 'd_new', country: 'RU', msAgo: 60 * 1000 });

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.ok(context.takeoverRisk, 'expected a takeover risk to be detected');
  assert.equal(context.takeoverRisk.currentDevice, 'd_new');
  assert.equal(context.takeoverRisk.previousDevice, 'd_old');
  assert.equal(context.takeoverRisk.currentCountry, 'RU');
  assert.equal(context.takeoverRisk.previousCountry, 'IN');
});

test('getOutboundContext: takeoverRisk is null when the recent login device was already seen before', () => {
  const db = buildTestDb();
  insertMerchantLogin(db, { merchantId: 'm_biz', deviceId: 'd_known', country: 'IN', msAgo: 60 * 60 * 1000 });
  insertMerchantLogin(db, { merchantId: 'm_biz', deviceId: 'd_known', country: 'IN', msAgo: 60 * 1000 });

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.takeoverRisk, null);
});

test('getOutboundContext: takeoverRisk still resolves correctly when two logins share the exact same millisecond timestamp (regression)', () => {
  // Reproduces the exact race found under a loaded full-suite run: two POST /merchant-logins
  // calls fired fast enough can legitimately land on the same millisecond. A strict
  // "timestamp < recentLogin.timestamp" comparison for "the previous login" would silently
  // drop the earlier row entirely in this case, leaving takeoverRisk null even though a
  // genuinely new device just logged in.
  const db = buildTestDb();
  const tiedTimestamp = new Date(NOW_MS - 60 * 1000).toISOString();
  db.prepare(
    'INSERT INTO merchant_login_events (login_id, merchant_id, device_id, country, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('login_known', 'm_biz', 'd_known', 'IN', tiedTimestamp, tiedTimestamp);
  db.prepare(
    'INSERT INTO merchant_login_events (login_id, merchant_id, device_id, country, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('login_attacker', 'm_biz', 'd_attacker', 'RU', tiedTimestamp, tiedTimestamp);

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.ok(context.takeoverRisk, 'expected a takeover risk to still be detected under a same-millisecond tie');
  assert.equal(context.takeoverRisk.currentDevice, 'd_attacker');
  assert.equal(context.takeoverRisk.previousDevice, 'd_known');
});

test('getOutboundContext: takeoverRisk is null with no logins at all', () => {
  const db = buildTestDb();
  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.takeoverRisk, null);
});

test('getOutboundContext: disputeCount reflects disputes filed by this counterparty within the lookback window', () => {
  const db = buildTestDb();
  db.prepare('INSERT INTO disputes (dispute_id, customer_id, dispute_type, created_at) VALUES (?, ?, ?, ?)').run(
    'dsp_1', 'u_1', 'chargeback', new Date(NOW_MS - 60 * 1000).toISOString()
  );
  db.prepare('INSERT INTO disputes (dispute_id, customer_id, dispute_type, created_at) VALUES (?, ?, ?, ?)').run(
    'dsp_2', 'u_other', 'chargeback', new Date(NOW_MS - 60 * 1000).toISOString()
  );

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.disputeCount, 1);
});

test('getOutboundContext: employeeRefundCount/employeeRefundCountToReceiver only populate when employee_id is given', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_1', amount: 10, msAgo: 60 * 1000, purpose: 'Refund' });

  const withoutEmployee = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);
  assert.equal(withoutEmployee.employeeRefundCount, 0);
});

test('getOutboundContext: crossGatewayIds/crossGatewayTotal scoped to this specific receiver', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_1', amount: 5000, msAgo: 60 * 1000, merchantId: 'gw_a' });
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_other', amount: 9999, msAgo: 60 * 1000, merchantId: 'gw_c' }); // different receiver, must not count

  const context = getOutboundContext(
    db,
    { sender_id: 'm_biz', receiver_id: 'u_1', merchant_id: 'gw_b', timestamp: new Date(NOW_MS).toISOString() },
    NOW_MS
  );

  assert.deepEqual(context.crossGatewayIds, ['gw_a']);
  assert.equal(context.crossGatewayTotal, 5000);
});

// ---- getOutboundContext: Section 16 (duplicate/shared-identifier) ----

test('getOutboundContext: duplicateTransactionCount counts an identical recent transaction to the same receiver', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_1', amount: 500, msAgo: 10 * 1000 });
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_1', amount: 999, msAgo: 10 * 1000 }); // different amount, must not count
  insertTransaction(db, { senderId: 'm_biz', receiverId: 'u_2', amount: 500, msAgo: 10 * 1000 }); // different receiver, must not count

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', amount: 500, timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.duplicateTransactionCount, 1);
});

test('getOutboundContext: sharedDeviceAccountIds/sharedIpAccountIds exclude the sender itself', () => {
  const db = buildTestDb();
  for (const id of ['u_other', 'u_x', 'm_biz', 'u_y', 'u_z']) insertUser(db, id);
  db.prepare(
    'INSERT INTO transactions (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, fraud_score, decision, device_id, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('t_shared_1', 'u_other', 'u_x', 10, new Date(NOW_MS - 60000).toISOString(), 'transfer', 0, 'allow', 'd_shared', '1.2.3.4');
  db.prepare(
    'INSERT INTO transactions (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, fraud_score, decision, device_id, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('t_shared_2', 'm_biz', 'u_y', 10, new Date(NOW_MS - 30000).toISOString(), 'transfer', 0, 'allow', 'd_shared', '1.2.3.4');

  const context = getOutboundContext(
    db,
    { sender_id: 'm_biz', receiver_id: 'u_z', device_id: 'd_shared', ip_address: '1.2.3.4', timestamp: new Date(NOW_MS).toISOString() },
    NOW_MS
  );

  assert.deepEqual(context.sharedDeviceAccountIds, ['u_other']);
  assert.deepEqual(context.sharedIpAccountIds, ['u_other']);
});

// ---- applyOutboundRestrictors ----

test('applyOutboundRestrictors: floors the score and adds a reason for an amount above the review threshold', () => {
  const { score, reasons } = applyOutboundRestrictors(5, [], { amount: applyOutboundRestrictors.MAX_OUTBOUND_WITHOUT_REVIEW + 1 });

  assert.equal(score, 40);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /exceeds the .* review threshold/);
});

test('applyOutboundRestrictors: does not lower an already-higher score', () => {
  const { score } = applyOutboundRestrictors(90, [], { amount: applyOutboundRestrictors.MAX_OUTBOUND_WITHOUT_REVIEW + 1 });

  assert.equal(score, 90);
});

test('applyOutboundRestrictors: leaves score/reasons untouched below the review threshold', () => {
  const { score, reasons } = applyOutboundRestrictors(5, ['existing reason'], { amount: 100 });

  assert.equal(score, 5);
  assert.deepEqual(reasons, ['existing reason']);
});

// ---- devicePriorFlagCount / suspiciousUserAgent (Section 16, Category 10) ----

test('getOutboundContext: devicePriorFlagCount counts prior step_up/block transactions on this device, from any sender', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'u_other', receiverId: 'u_x', amount: 10, msAgo: 60 * 60 * 1000, deviceId: 'd_bad', decision: 'block' });
  insertTransaction(db, { senderId: 'u_other2', receiverId: 'u_x', amount: 10, msAgo: 30 * 60 * 1000, deviceId: 'd_bad', decision: 'step_up' });
  insertTransaction(db, { senderId: 'u_other3', receiverId: 'u_x', amount: 10, msAgo: 30 * 60 * 1000, deviceId: 'd_bad', decision: 'allow' });

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', device_id: 'd_bad', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.devicePriorFlagCount, 2);
});

test('getOutboundContext: devicePriorFlagCount ignores flags outside the lookback window', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'u_other', receiverId: 'u_x', amount: 10, msAgo: 200 * 24 * 60 * 60 * 1000, deviceId: 'd_old_bad', decision: 'block' });

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', device_id: 'd_old_bad', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.devicePriorFlagCount, 0);
});

test('getOutboundContext: devicePriorFlagCount is 0 with no device_id on this transaction', () => {
  const db = buildTestDb();
  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', device_id: null, timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.devicePriorFlagCount, 0);
});

test('getOutboundContext: suspiciousUserAgent is true for a known automation signature, false for a real browser UA', () => {
  const db = buildTestDb();
  const scripted = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', user_agent: 'python-requests/2.31.0', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);
  const browser = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);
  const none = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(scripted.suspiciousUserAgent, true);
  assert.equal(browser.suspiciousUserAgent, false);
  assert.equal(none.suspiciousUserAgent, false);
});
