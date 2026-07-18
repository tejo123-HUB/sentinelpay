// Continuous Learning Extension, Phase B: self-updating composite reputation (server/reputation.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { SCHEMA } = require('../server/db');
const { computeReputationScore, updateReputationAfterTransaction } = require('../server/reputation');

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function tx(overrides = {}) {
  return {
    transaction_id: `t_${Math.random().toString(36).slice(2)}`,
    sender_id: 'u_sender',
    receiver_id: 'u_receiver',
    amount: 100,
    timestamp: '2026-07-18T10:00:00.000Z',
    device_id: null,
    merchant_id: null,
    ip_address: null,
    ...overrides,
  };
}

test('computeReputationScore: a brand-new entity with no history reads as neutral (the prior alone), not 0 or 100', () => {
  const db = buildTestDb();
  const { score, reasonBreakdown } = computeReputationScore(db, 'u_unknown', 'user');

  assert.equal(score, 50); // PRIOR_FLAGGED=4, PRIOR_TOTAL=8 -> 4/8*100 = 50
  assert.ok(reasonBreakdown.length > 0);
  assert.match(reasonBreakdown[0], /no transaction history/i);
});

test('updateReputationAfterTransaction: a long clean history pulls the score down toward 0', () => {
  const db = buildTestDb();
  for (let i = 0; i < 30; i++) {
    updateReputationAfterTransaction(db, tx({ sender_id: 'u_clean', receiver_id: 'u_other' }), []);
  }
  const { score, reasonBreakdown } = computeReputationScore(db, 'u_clean', 'user');
  assert.ok(score < 15, `expected a clean history to pull score well below 50, got ${score}`);
  assert.match(reasonBreakdown[0], /0\/30 \(0%\)/);
});

test('updateReputationAfterTransaction: a consistently flagged history pushes the score up toward 100', () => {
  const db = buildTestDb();
  for (let i = 0; i < 30; i++) {
    updateReputationAfterTransaction(db, tx({ sender_id: 'u_bad', receiver_id: 'u_other' }), [{ flagged: true }]);
  }
  const { score, reasonBreakdown } = computeReputationScore(db, 'u_bad', 'user');
  assert.ok(score > 85, `expected a consistently flagged history to push score well above 50, got ${score}`);
  assert.match(reasonBreakdown[0], /30\/30 \(100%\)/);
});

test('updateReputationAfterTransaction: one flag on a brand-new entity does not instantly max the score out (Laplace smoothing)', () => {
  const db = buildTestDb();
  updateReputationAfterTransaction(db, tx({ sender_id: 'u_onehit', receiver_id: 'u_other' }), [{ flagged: true }]);
  const { score } = computeReputationScore(db, 'u_onehit', 'user');
  assert.ok(score > 50 && score < 70, `expected a modest bump from a single flag, got ${score}`);
});

test('computeReputationScore: a blacklisted account is floored regardless of an otherwise clean history', () => {
  const db = buildTestDb();
  for (let i = 0; i < 20; i++) {
    updateReputationAfterTransaction(db, tx({ sender_id: 'u_blacklisted', receiver_id: 'u_other' }), []);
  }
  db.prepare('INSERT INTO fraud_lists (entry_id, list_type, account_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'fl_1',
    'blacklist',
    'u_blacklisted',
    'confirmed fraud',
    '2026-07-18T10:00:00.000Z'
  );

  const { score, reasonBreakdown } = computeReputationScore(db, 'u_blacklisted', 'user');
  assert.ok(score >= 90);
  assert.ok(reasonBreakdown.some((r) => /blacklist/i.test(r)));
});

test('computeReputationScore: a confirmed mule account is floored even with few observed transactions', () => {
  const db = buildTestDb();
  db.prepare('INSERT INTO mule_accounts (account_id, qualifying_cycles, first_confirmed_at, last_seen_at) VALUES (?, ?, ?, ?)').run(
    'u_mule',
    3,
    '2026-07-18T09:00:00.000Z',
    '2026-07-18T10:00:00.000Z'
  );

  const { score, reasonBreakdown } = computeReputationScore(db, 'u_mule', 'user');
  assert.ok(score >= 75);
  assert.ok(reasonBreakdown.some((r) => /mule/i.test(r)));
});

test('computeReputationScore: blacklist/mule floors only apply to user entities, not device/merchant/ip/pair', () => {
  const db = buildTestDb();
  // A device_id string that happens to collide with a blacklisted user_id must not inherit that
  // user's floor -- entity_type keeps the keyspaces genuinely separate.
  db.prepare('INSERT INTO fraud_lists (entry_id, list_type, account_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'fl_2',
    'blacklist',
    'device:shared_device_1',
    'unrelated user happens to share this id',
    '2026-07-18T10:00:00.000Z'
  );
  const { score } = computeReputationScore(db, 'device:shared_device_1', 'device');
  assert.equal(score, 50); // neutral prior only -- no blacklist floor applied for a non-user entity type
});

test('updateReputationAfterTransaction: updates device/merchant/ip/pair entities alongside both users', () => {
  const db = buildTestDb();
  updateReputationAfterTransaction(
    db,
    tx({ sender_id: 'biz_1', receiver_id: 'cust_1', device_id: 'dev_1', merchant_id: 'merch_1', ip_address: '1.2.3.4' }),
    [{ flagged: true }]
  );

  const senderRow = db.prepare('SELECT * FROM entity_reputation WHERE entity_id = ? AND entity_type = ?').get('biz_1', 'user');
  const receiverRow = db.prepare('SELECT * FROM entity_reputation WHERE entity_id = ? AND entity_type = ?').get('cust_1', 'user');
  const deviceRow = db.prepare('SELECT * FROM entity_reputation WHERE entity_id = ? AND entity_type = ?').get('device:dev_1', 'device');
  const merchantRow = db
    .prepare('SELECT * FROM entity_reputation WHERE entity_id = ? AND entity_type = ?')
    .get('merchant:merch_1', 'merchant');
  const ipRow = db.prepare('SELECT * FROM entity_reputation WHERE entity_id = ? AND entity_type = ?').get('ip:1.2.3.4', 'ip');

  for (const row of [senderRow, receiverRow, deviceRow, merchantRow, ipRow]) {
    assert.ok(row, 'expected an entity_reputation row to exist');
    assert.equal(row.txn_count, 1);
    assert.equal(row.flag_count, 1);
  }
});
