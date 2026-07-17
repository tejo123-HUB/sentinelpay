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

function insertTransaction(db, { senderId, receiverId, amount, msAgo }) {
  insertUser(db, senderId);
  insertUser(db, receiverId);
  db.prepare(
    `INSERT INTO transactions
      (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, fraud_score, decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `t_${Math.random().toString(36).slice(2)}`,
    senderId,
    receiverId,
    amount,
    new Date(NOW_MS - msAgo).toISOString(),
    'transfer',
    0,
    'allow'
  );
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

test('getOutboundContext: priorPurchaseTotal sums only this customer\'s payments to this business account', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'u_1', receiverId: 'm_biz', amount: 100, msAgo: 60000 });
  insertTransaction(db, { senderId: 'u_1', receiverId: 'm_biz', amount: 50, msAgo: 30000 });
  insertTransaction(db, { senderId: 'u_1', receiverId: 'm_other', amount: 999, msAgo: 20000 }); // different business -- excluded
  insertTransaction(db, { senderId: 'u_2', receiverId: 'm_biz', amount: 999, msAgo: 10000 }); // different customer -- excluded

  const context = getOutboundContext(db, { sender_id: 'm_biz', receiver_id: 'u_1', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);

  assert.equal(context.priorPurchaseTotal, 150);
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
