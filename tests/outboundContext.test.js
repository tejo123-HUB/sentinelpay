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

function insertTransaction(db, { senderId, receiverId, amount, msAgo, purpose = null, merchantId = null, referenceTransactionId = null, transactionId }) {
  insertUser(db, senderId);
  insertUser(db, receiverId);
  const id = transactionId || `t_${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO transactions
      (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, fraud_score, decision, purpose, merchant_id, reference_transaction_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    senderId,
    receiverId,
    amount,
    new Date(NOW_MS - msAgo).toISOString(),
    'transfer',
    0,
    'allow',
    purpose,
    merchantId,
    referenceTransactionId
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
