// Continuous Learning Extension, Phase A: the feature store (server/featureStore.js) -- entity
// coverage beyond sender-level, and the point-in-time-correctness guarantee replayFeatureHistory
// exists to provide.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { SCHEMA } = require('../server/db');
const { getBaseline, updateBaseline } = require('../server/adaptiveBaseline');
const {
  computeFeatureVector,
  updateEntityBaselinesAfterTransaction,
  replayFeatureHistory,
  deviceEntityId,
  merchantEntityId,
  ipEntityId,
} = require('../server/featureStore');
const getOutboundContext = require('../server/outboundContext');

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function ensureUser(db, userId) {
  const existing = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(userId);
  if (!existing) {
    db.prepare('INSERT INTO users (user_id, created_at) VALUES (?, ?)').run(userId, '2026-01-01T00:00:00.000Z');
  }
}

function insertTransaction(db, overrides = {}) {
  const t = {
    transaction_id: `t_${Math.random().toString(36).slice(2)}`,
    sender_id: 'u_sender',
    receiver_id: 'u_receiver',
    amount: 100,
    timestamp: '2026-07-18T10:00:00.000Z',
    device_id: null,
    merchant_id: null,
    ip_address: null,
    transaction_type: 'transfer',
    ...overrides,
  };
  ensureUser(db, t.sender_id);
  ensureUser(db, t.receiver_id);
  db.prepare(
    `INSERT INTO transactions (transaction_id, sender_id, receiver_id, amount, timestamp, device_id, merchant_id, ip_address, transaction_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(t.transaction_id, t.sender_id, t.receiver_id, t.amount, t.timestamp, t.device_id, t.merchant_id, t.ip_address, t.transaction_type);
  const rowid_ = db.prepare('SELECT rowid AS r FROM transactions WHERE transaction_id = ?').get(t.transaction_id).r;
  return { ...t, rowid_ };
}

// ---- computeFeatureVector ----

test('computeFeatureVector: a brand-new entity with no baseline yet gets a neutral (zero z-score) vector', () => {
  const db = buildTestDb();
  const t = insertTransaction(db, { amount: 500 });
  const vector = computeFeatureVector(db, t);

  assert.equal(vector.amount, 500);
  assert.equal(vector.user_amount_z, 0);
  assert.equal(vector.user_history_count, 0);
  assert.equal(vector.is_external_source, 0);
});

test('computeFeatureVector: reflects an established baseline once one exists', () => {
  const db = buildTestDb();
  for (const amt of [100, 100, 100, 100, 100]) {
    updateBaseline(db, 'u_sender', 'amount', amt, '2026-07-18T09:00:00.000Z');
  }
  const t = insertTransaction(db, { sender_id: 'u_sender', amount: 1000 });
  const vector = computeFeatureVector(db, t);

  // A tight (near-zero-variance) spender suddenly paying 10x their established average should
  // read as a strongly positive z-score -- same "same multiple, different verdict" property
  // amountAnomaly.js's adaptive baseline already established.
  assert.ok(vector.user_amount_z > 5);
});

test('computeFeatureVector: reputation/graph context, when supplied, is folded into the vector', () => {
  const db = buildTestDb();
  const t = insertTransaction(db);
  const vector = computeFeatureVector(db, t, { reputationContext: { score: 12 }, graphContext: { clusterRiskScore: 0.8 } });

  assert.equal(vector.reputation_score, 12);
  assert.equal(vector.graph_cluster_risk, 0.8);
});

// ---- updateEntityBaselinesAfterTransaction ----

test('updateEntityBaselinesAfterTransaction: updates device/merchant/ip interval baselines', () => {
  const db = buildTestDb();
  const t1 = insertTransaction(db, {
    timestamp: '2026-07-18T10:00:00.000Z',
    device_id: 'dev_1',
    merchant_id: 'merch_1',
    ip_address: '10.0.0.1',
  });
  updateEntityBaselinesAfterTransaction(db, t1, t1.rowid_);

  const t2 = insertTransaction(db, {
    timestamp: '2026-07-18T10:00:05.000Z',
    device_id: 'dev_1',
    merchant_id: 'merch_1',
    ip_address: '10.0.0.1',
  });
  updateEntityBaselinesAfterTransaction(db, t2, t2.rowid_);

  assert.equal(getBaseline(db, deviceEntityId('dev_1'), 'interval').count, 1);
  assert.equal(getBaseline(db, deviceEntityId('dev_1'), 'interval').mean, 5000);
  assert.equal(getBaseline(db, merchantEntityId('merch_1'), 'interval').mean, 5000);
  assert.equal(getBaseline(db, ipEntityId('10.0.0.1'), 'interval').mean, 5000);
});

test('updateEntityBaselinesAfterTransaction: pair.amount reuses outboundContext.refundBaselineEntityId, not a separate key', () => {
  const db = buildTestDb();
  const t = insertTransaction(db, { sender_id: 'biz_1', receiver_id: 'cust_1', amount: 250 });
  updateEntityBaselinesAfterTransaction(db, t, t.rowid_);

  const pairId = getOutboundContext.refundBaselineEntityId('biz_1', 'cust_1');
  assert.equal(getBaseline(db, pairId, 'amount').mean, 250);
});

test('updateEntityBaselinesAfterTransaction: an uptoRowid bound never sees a later transaction', () => {
  const db = buildTestDb();
  const early = insertTransaction(db, { timestamp: '2026-07-18T10:00:00.000Z', device_id: 'dev_x' });
  insertTransaction(db, { timestamp: '2026-07-18T10:05:00.000Z', device_id: 'dev_x' }); // a later row, already in the table

  // Update the *early* row using its own rowid bound -- must behave as if the later row doesn't
  // exist yet (this is the offline-replay scenario in miniature).
  updateEntityBaselinesAfterTransaction(db, early, early.rowid_);
  assert.equal(getBaseline(db, deviceEntityId('dev_x'), 'interval').count, 0); // only one prior row visible, no interval yet
});

// ---- replayFeatureHistory ----

test('replayFeatureHistory: writes one training_examples row per transaction', () => {
  const db = buildTestDb();
  insertTransaction(db, { timestamp: '2026-07-18T10:00:00.000Z', amount: 100 });
  insertTransaction(db, { timestamp: '2026-07-18T10:05:00.000Z', amount: 120 });
  insertTransaction(db, { timestamp: '2026-07-18T10:10:00.000Z', amount: 90 });

  const written = replayFeatureHistory(db);
  assert.equal(written, 3);

  const count = db.prepare('SELECT COUNT(*) AS n FROM training_examples').get().n;
  assert.equal(count, 3);
});

test('replayFeatureHistory: a later transaction never leaks into an earlier one\'s feature vector', () => {
  const db = buildTestDb();
  // Same sender, tight amounts early, one huge outlier last -- if replay leaked the future, the
  // early rows' baseline would already reflect the outlier and understate their own z-scores.
  insertTransaction(db, { sender_id: 'u_leak', timestamp: '2026-07-18T10:00:00.000Z', amount: 100 });
  insertTransaction(db, { sender_id: 'u_leak', timestamp: '2026-07-18T10:05:00.000Z', amount: 100 });
  insertTransaction(db, { sender_id: 'u_leak', timestamp: '2026-07-18T10:10:00.000Z', amount: 100 });
  insertTransaction(db, { sender_id: 'u_leak', timestamp: '2026-07-18T10:15:00.000Z', amount: 100000 });

  replayFeatureHistory(db);

  const rows = db
    .prepare(
      `SELECT te.feature_json, t.timestamp FROM training_examples te
       JOIN transactions t ON t.transaction_id = te.transaction_id
       WHERE t.sender_id = ? ORDER BY t.timestamp ASC`
    )
    .all('u_leak');

  const firstVector = JSON.parse(rows[0].feature_json);
  // The very first transaction for this sender has no prior history at all -- neutral z-score,
  // not one already skewed by the huge outlier three transactions later.
  assert.equal(firstVector.user_amount_z, 0);
  assert.equal(firstVector.user_history_count, 0);

  const lastVector = JSON.parse(rows[3].feature_json);
  // By the last (outlier) transaction, the baseline is built from the three prior $100 rows --
  // strongly positive z-score.
  assert.ok(lastVector.user_amount_z > 5);
});

test('replayFeatureHistory: is safe to re-run (resets and rebuilds entity_baselines rather than double-accumulating)', () => {
  const db = buildTestDb();
  insertTransaction(db, { sender_id: 'u_rerun', timestamp: '2026-07-18T10:00:00.000Z', amount: 100 });
  insertTransaction(db, { sender_id: 'u_rerun', timestamp: '2026-07-18T10:05:00.000Z', amount: 100 });

  replayFeatureHistory(db);
  const firstRunCount = getBaseline(db, 'u_rerun', 'amount').count;

  replayFeatureHistory(db);
  const secondRunCount = getBaseline(db, 'u_rerun', 'amount').count;

  assert.equal(firstRunCount, 2);
  assert.equal(secondRunCount, 2); // not 4 -- a re-run must not double-count prior history
});
