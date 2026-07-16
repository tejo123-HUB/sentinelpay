const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { SCHEMA } = require('../server/db');
const detectSplits = require('../server/structuring/splitDetection');
const analyzeFanOut = require('../server/structuring/fanOutAnalysis');
const correlateWithdrawal = require('../server/structuring/withdrawalCorrelation');
const buildAlert = require('../server/structuring/chainTracking');
const runStructuringScan = require('../server/structuring/pipeline');
const { runScanCycle } = require('../server/structuring/backgroundJob');
const findActiveAlert = require('../server/structuring/alertLookup');

const BASE_TIME = new Date('2026-07-18T12:00:00Z').getTime();

function iso(offsetMs) {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

// Synthetic DoD scenario: 1 sender (A) -> 6 small transfers -> 3 receivers (B, C, D) ->
// 2 of the 3 receivers withdraw >80% of received funds within 30 minutes.
function buildStructuringScenario() {
  const transfers = [
    { sender_id: 'A', receiver_id: 'B', amount: 4000, timestamp: iso(0), transaction_type: 'transfer' },
    { sender_id: 'A', receiver_id: 'C', amount: 4000, timestamp: iso(90 * 1000), transaction_type: 'transfer' },
    { sender_id: 'A', receiver_id: 'D', amount: 4000, timestamp: iso(180 * 1000), transaction_type: 'transfer' },
    { sender_id: 'A', receiver_id: 'B', amount: 4000, timestamp: iso(270 * 1000), transaction_type: 'transfer' },
    { sender_id: 'A', receiver_id: 'C', amount: 4000, timestamp: iso(360 * 1000), transaction_type: 'transfer' },
    { sender_id: 'A', receiver_id: 'D', amount: 4000, timestamp: iso(450 * 1000), transaction_type: 'transfer' },
  ];
  const windowEndMs = BASE_TIME + 450 * 1000;

  const withdrawals = [
    // B withdraws 87.5% of its 8000 received within 30 minutes -> mule
    { sender_id: 'B', receiver_id: 'external', amount: 7000, timestamp: new Date(windowEndMs + 10 * 60 * 1000).toISOString(), transaction_type: 'withdrawal' },
    // D withdraws 81.25% of its 8000 received within 30 minutes -> mule
    { sender_id: 'D', receiver_id: 'external', amount: 6500, timestamp: new Date(windowEndMs + 15 * 60 * 1000).toISOString(), transaction_type: 'withdrawal' },
    // C only withdraws a small fraction -> not a mule
    { sender_id: 'C', receiver_id: 'external', amount: 1000, timestamp: new Date(windowEndMs + 5 * 60 * 1000).toISOString(), transaction_type: 'withdrawal' },
  ];

  return { transactions: [...transfers, ...withdrawals], nowMs: windowEndMs };
}

test('splitDetection: flags a sender with a burst of small transfers summing above threshold', () => {
  const { transactions, nowMs } = buildStructuringScenario();
  const candidates = detectSplits(transactions, nowMs);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].senderId, 'A');
  assert.equal(candidates[0].count, 6);
  assert.equal(candidates[0].totalAmount, 24000);
});

test('splitDetection: does not flag a sender below the count/total thresholds', () => {
  const transactions = [
    { sender_id: 'A', receiver_id: 'B', amount: 1000, timestamp: iso(0), transaction_type: 'transfer' },
    { sender_id: 'A', receiver_id: 'C', amount: 1000, timestamp: iso(60000), transaction_type: 'transfer' },
  ];
  const candidates = detectSplits(transactions, BASE_TIME + 60000);

  assert.equal(candidates.length, 0);
});

test('fanOutAnalysis: flags fan-out to receivers with no prior history', () => {
  const windowTransactions = [
    { receiver_id: 'B', amount: 4000 },
    { receiver_id: 'C', amount: 4000 },
    { receiver_id: 'D', amount: 4000 },
  ];
  const result = analyzeFanOut(windowTransactions, []);

  assert.equal(result.passesFanOut, true);
  assert.deepEqual(result.newReceiverIds.sort(), ['B', 'C', 'D']);
});

test('fanOutAnalysis: does not flag receivers with established prior history', () => {
  const windowTransactions = [
    { receiver_id: 'B', amount: 4000 },
    { receiver_id: 'C', amount: 4000 },
  ];
  const priorTransactions = [{ receiver_id: 'B' }, { receiver_id: 'C' }];
  const result = analyzeFanOut(windowTransactions, priorTransactions);

  assert.equal(result.passesFanOut, false);
});

test('withdrawalCorrelation: flags a receiver that rapidly withdraws most of the received funds', () => {
  const windowEndMs = BASE_TIME;
  const outgoing = [
    { sender_id: 'B', amount: 7000, timestamp: new Date(windowEndMs + 10 * 60 * 1000).toISOString() },
  ];
  const result = correlateWithdrawal('B', 8000, windowEndMs, outgoing);

  assert.equal(result.isMule, true);
  assert.ok(result.withdrawalRatio >= 0.8);
});

test('withdrawalCorrelation: does not flag a receiver that keeps most of the funds', () => {
  const windowEndMs = BASE_TIME;
  const outgoing = [
    { sender_id: 'C', amount: 1000, timestamp: new Date(windowEndMs + 5 * 60 * 1000).toISOString() },
  ];
  const result = correlateWithdrawal('C', 8000, windowEndMs, outgoing);

  assert.equal(result.isMule, false);
});

test('chainTracking: combines results into a single alert row with a human-readable reason', () => {
  const alert = buildAlert({
    senderId: 'A',
    totalAmount: 24000,
    count: 6,
    windowStart: iso(0),
    windowEnd: iso(450000),
    receiverIds: ['B', 'C', 'D'],
    withdrawalResults: [
      { receiverId: 'B', amountReceived: 8000, amountOut: 7000, withdrawalRatio: 0.875, isMule: true },
      { receiverId: 'D', amountReceived: 8000, amountOut: 6500, withdrawalRatio: 0.8125, isMule: true },
      { receiverId: 'C', amountReceived: 8000, amountOut: 1000, withdrawalRatio: 0.125, isMule: false },
    ],
  });

  assert.equal(alert.sender_id, 'A');
  assert.deepEqual(JSON.parse(alert.receiver_ids), ['B', 'C', 'D']);
  assert.equal(alert.transaction_count, 6);
  assert.ok(alert.reason.length > 0);
  assert.match(alert.reason, /mule/);
});

// ---- Full pipeline: the Task 6 Definition of Done ----

test('pipeline DoD: full structuring scenario produces exactly one alert in one scan', () => {
  const { transactions, nowMs } = buildStructuringScenario();
  const alerts = runStructuringScan(transactions, nowMs, []);

  assert.equal(alerts.length, 1);
  const alert = alerts[0];
  assert.equal(alert.sender_id, 'A');
  assert.deepEqual(JSON.parse(alert.receiver_ids).sort(), ['B', 'C', 'D']);
  assert.equal(alert.transaction_count, 6);
  assert.equal(alert.total_amount, 24000);
  assert.match(alert.reason, /mule/);
});

test('pipeline DoD: re-scanning the same window does not create a duplicate alert', () => {
  const { transactions, nowMs } = buildStructuringScenario();
  const firstPass = runStructuringScan(transactions, nowMs, []);
  const secondPass = runStructuringScan(transactions, nowMs + 5000, firstPass);

  assert.equal(firstPass.length, 1);
  assert.equal(secondPass.length, 0);
});

test('pipeline: a realistic background-job scan delay still correctly correlates withdrawals (regression)', () => {
  // Regression test: splitDetection previously stamped windowEnd as the *scan* time (nowMs)
  // rather than the last transfer's own timestamp. In real operation (and in the live
  // simulator) a mule withdraws within a second or two of receiving the funds, and the
  // background job then scans a few seconds later still — so the withdrawal's timestamp was
  // always *before* the inflated windowEnd, and correlateWithdrawal's `tMs >= windowEndMs`
  // check wrongly excluded it every single time. Mirrors simulate_transactions.js's actual
  // timing: transfers ~200ms apart, withdrawals ~200ms after the last transfer, background
  // job scanning ~8s later (its default interval).
  const receivers = ['B', 'C', 'D'];
  const transfers = Array.from({ length: 6 }, (_, i) => ({
    sender_id: 'A',
    receiver_id: receivers[i % 3],
    amount: 4000,
    timestamp: iso(i * 200),
    transaction_type: 'transfer',
  }));
  const lastTransferMs = BASE_TIME + 5 * 200;
  const withdrawals = [
    { sender_id: 'B', receiver_id: 'external', amount: 7000, timestamp: new Date(lastTransferMs + 200).toISOString(), transaction_type: 'withdrawal' },
    { sender_id: 'D', receiver_id: 'external', amount: 6500, timestamp: new Date(lastTransferMs + 400).toISOString(), transaction_type: 'withdrawal' },
  ];
  const scanMs = lastTransferMs + 8000; // realistic background-job delay, not scan-at-last-transfer-instant

  const alerts = runStructuringScan([...transfers, ...withdrawals], scanMs, []);

  assert.equal(alerts.length, 1);
  assert.match(alerts[0].reason, /mule/);
  assert.ok(alerts[0].withdrawal_ratio > 0);
});

test('pipeline: a clean transaction set produces no alerts', () => {
  const transactions = [
    { sender_id: 'X', receiver_id: 'Y', amount: 150, timestamp: iso(0), transaction_type: 'transfer' },
    { sender_id: 'X', receiver_id: 'Y', amount: 200, timestamp: iso(60000), transaction_type: 'transfer' },
  ];
  const alerts = runStructuringScan(transactions, BASE_TIME + 60000, []);

  assert.equal(alerts.length, 0);
});

// ---- End-to-end: backgroundJob.runScanCycle against a real DB, plus the fast lookup ----

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function insertUser(db, userId, createdAtIso) {
  db.prepare('INSERT OR IGNORE INTO users (user_id, created_at) VALUES (?, ?)').run(userId, createdAtIso);
}

function insertTransaction(db, t) {
  db.prepare(
    `INSERT INTO transactions
      (transaction_id, sender_id, receiver_id, amount, timestamp, device_id, transaction_type, fraud_score, decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `t_${Math.random().toString(36).slice(2)}`,
    t.sender_id,
    t.receiver_id,
    t.amount,
    t.timestamp,
    t.device_id || null,
    t.transaction_type,
    0,
    'allow'
  );
}

test('backgroundJob.runScanCycle: DoD scenario produces exactly one persisted alert', () => {
  const db = buildTestDb();
  const { transactions, nowMs } = buildStructuringScenario();

  for (const userId of ['A', 'B', 'C', 'D', 'external']) insertUser(db, userId, iso(-3600000));
  for (const t of transactions) insertTransaction(db, t);

  const created = runScanCycle(db, nowMs);
  assert.equal(created.length, 1);

  const rows = db.prepare('SELECT * FROM structuring_alerts').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sender_id, 'A');
  assert.ok(rows[0].reason.length > 0);

  // Running a second cycle immediately after must not duplicate the alert.
  const createdAgain = runScanCycle(db, nowMs + 5000);
  assert.equal(createdAgain.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM structuring_alerts').get().n, 1);
});

test('alertLookup.findActiveAlert: fast per-transaction lookup finds sender and receiver hits', () => {
  const db = buildTestDb();
  const { transactions, nowMs } = buildStructuringScenario();
  for (const userId of ['A', 'B', 'C', 'D', 'external']) insertUser(db, userId, iso(-3600000));
  for (const t of transactions) insertTransaction(db, t);
  runScanCycle(db, nowMs);

  const senderHit = findActiveAlert(db, 'A', 'someone_else', nowMs);
  assert.equal(senderHit.active, true);

  const receiverHit = findActiveAlert(db, 'someone_else', 'B', nowMs);
  assert.equal(receiverHit.active, true);

  const noHit = findActiveAlert(db, 'unrelated_1', 'unrelated_2', nowMs);
  assert.equal(noHit.active, false);
});
