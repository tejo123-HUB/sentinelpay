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
  const priorReceiverIds = ['B', 'C'];
  const result = analyzeFanOut(windowTransactions, priorReceiverIds);

  assert.equal(result.passesFanOut, false);
});

test('fanOutAnalysis: accepts a Set as well as an array for priorReceiverIds', () => {
  const windowTransactions = [
    { receiver_id: 'B', amount: 4000 },
    { receiver_id: 'C', amount: 4000 },
  ];
  const result = analyzeFanOut(windowTransactions, new Set(['B', 'C']));

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

test('chainTracking: reason cites the minimum mule ratio, not just the first one encountered (regression)', () => {
  // Regression test: the reason text used to cite muleAccounts[0]'s ratio (Map insertion
  // order), which isn't necessarily the lowest. With a 99% mule listed first and an 85% mule
  // second, the old code would claim "2 of 3 receivers withdrew over 99%+" — false for the
  // second one. The claim must be a true lower bound across everything it's cited for.
  const alert = buildAlert({
    senderId: 'A',
    totalAmount: 24000,
    count: 6,
    windowStart: iso(0),
    windowEnd: iso(450000),
    receiverIds: ['B', 'C', 'D'],
    withdrawalResults: [
      { receiverId: 'B', amountReceived: 8000, amountOut: 7920, withdrawalRatio: 0.99, isMule: true },
      { receiverId: 'D', amountReceived: 8000, amountOut: 6800, withdrawalRatio: 0.85, isMule: true },
      { receiverId: 'C', amountReceived: 8000, amountOut: 1000, withdrawalRatio: 0.125, isMule: false },
    ],
  });

  assert.match(alert.reason, /over 85%\+/, `expected the reason to cite the minimum (85%), got: ${alert.reason}`);
  assert.doesNotMatch(alert.reason, /over 99%\+/);
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

test('backgroundJob.runScanCycle: a persisted structuring alert auto-blacklists its origin (FA198)', () => {
  const db = buildTestDb();
  const { transactions, nowMs } = buildStructuringScenario();

  for (const userId of ['A', 'B', 'C', 'D', 'external']) insertUser(db, userId, iso(-3600000));
  for (const t of transactions) insertTransaction(db, t);

  const { checkFraudLists } = require('../server/fraudLists');
  assert.equal(checkFraudLists(db, 'A', 'A').blacklisted, false);

  runScanCycle(db, nowMs);

  const afterFirst = checkFraudLists(db, 'A', 'A');
  assert.equal(afterFirst.blacklisted, true);
  assert.match(afterFirst.blacklistEntries[0].reason, /Auto-blacklisted: structuring alert/);

  const auditRows = db.prepare("SELECT * FROM admin_audit_log WHERE target_id = 'A' AND action = 'auto-create'").all();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].actor_ip, 'system');

  // A second scan cycle (already-alerted account) must not spam a duplicate blacklist entry.
  runScanCycle(db, nowMs + 5000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fraud_lists WHERE account_id = 'A'").get().n, 1);
});

test('backgroundJob.runScanCycle: a genuine long-term contact outside the recent-transactions lookback is not misclassified as a new fan-out receiver (regression)', () => {
  // Regression test: the fan-out "no prior history" check used to be derived from the same
  // LOOKBACK_MS-bounded (~45 min) transaction set fetched for split-detection, so a receiver
  // the sender has genuinely paid for months would look "new" the moment they weren't paid in
  // the last 45 minutes. Here, sender A has a real 2-hour-old relationship with B (well outside
  // LOOKBACK_MS) — B must NOT count toward MIN_FANOUT even though the fetch for this scan won't
  // include that old transaction. Only C and D are genuinely new (2 receivers), which is below
  // MIN_FANOUT (3), so this must NOT produce a structuring alert.
  const db = buildTestDb();
  for (const userId of ['A', 'B', 'C', 'D']) insertUser(db, userId, iso(-3 * 60 * 60 * 1000));

  // A genuine, old relationship — 2 hours before the burst below, well outside the ~45-minute
  // recent-transactions lookback the background job fetches per scan cycle.
  insertTransaction(db, {
    sender_id: 'A',
    receiver_id: 'B',
    amount: 500,
    timestamp: iso(-2 * 60 * 60 * 1000),
    transaction_type: 'transfer',
  });

  // The burst: 6 transfers of 4000 to B, C, D (2 each) — meets MIN_SPLIT_COUNT/MIN_SPLIT_TOTAL.
  const receivers = ['B', 'C', 'D'];
  for (let i = 0; i < 6; i += 1) {
    insertTransaction(db, {
      sender_id: 'A',
      receiver_id: receivers[i % 3],
      amount: 4000,
      timestamp: iso(i * 30 * 1000),
      transaction_type: 'transfer',
    });
  }

  const created = runScanCycle(db, BASE_TIME + 5 * 30 * 1000);

  assert.equal(created.length, 0, 'B is a genuine old contact; only 2 receivers are truly new, below MIN_FANOUT');
});

test('backgroundJob.runScanCycle: alert totals are scoped to only the flagged new receivers, not the whole burst (regression)', () => {
  // Regression test: when a sender's burst includes both an old contact (correctly excluded
  // from receiver_ids) and enough new receivers to still trip fan-out, the alert's
  // total_amount/transaction_count used to report the *whole* burst including the old
  // contact's share — overstating what the flagged receiver_ids actually cover in the
  // human-readable reason. Here: old contact B gets 1 of the 6 transfers; C, D, E (3 new
  // receivers, meets MIN_FANOUT) get the other 5. The alert must report only C+D+E's share:
  // 5 transactions totaling 20,000 — not 6 transactions totaling 24,000.
  const db = buildTestDb();
  for (const userId of ['A', 'B', 'C', 'D', 'E']) insertUser(db, userId, iso(-3 * 60 * 60 * 1000));

  insertTransaction(db, {
    sender_id: 'A',
    receiver_id: 'B',
    amount: 500,
    timestamp: iso(-2 * 60 * 60 * 1000),
    transaction_type: 'transfer',
  });

  const burstReceivers = ['B', 'C', 'D', 'E', 'C', 'D'];
  for (let i = 0; i < burstReceivers.length; i += 1) {
    insertTransaction(db, {
      sender_id: 'A',
      receiver_id: burstReceivers[i],
      amount: 4000,
      timestamp: iso(i * 30 * 1000),
      transaction_type: 'transfer',
    });
  }

  const created = runScanCycle(db, BASE_TIME + (burstReceivers.length - 1) * 30 * 1000);

  assert.equal(created.length, 1);
  const alert = created[0];
  assert.deepEqual(JSON.parse(alert.receiver_ids).sort(), ['C', 'D', 'E']);
  assert.equal(alert.transaction_count, 5, 'should count only the 5 transfers to C/D/E, not B\'s');
  assert.equal(alert.total_amount, 20000, 'should total only C/D/E\'s 20,000, not B\'s extra 4,000');
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

// ---- detectCircularFlow (Section 15.16, Feature 6) ----

const detectCircularFlow = require('../server/structuring/circularFlow');

test('detectCircularFlow: detects a direct Merchant -> A -> Merchant cycle', () => {
  const transactions = [
    { sender_id: 'M', receiver_id: 'A', amount: 1000, timestamp: iso(-3000) },
    { sender_id: 'A', receiver_id: 'M', amount: 900, timestamp: iso(-1000) },
  ];

  const cycles = detectCircularFlow(transactions, ['M']);

  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].path, ['M', 'A', 'M']);
  assert.equal(cycles[0].originId, 'M');
  assert.equal(cycles[0].totalAmount, 1900);
});

test('detectCircularFlow: detects a Merchant -> A -> B -> Merchant cycle', () => {
  const transactions = [
    { sender_id: 'M', receiver_id: 'A', amount: 500, timestamp: iso(-5000) },
    { sender_id: 'A', receiver_id: 'B', amount: 480, timestamp: iso(-3000) },
    { sender_id: 'B', receiver_id: 'M', amount: 460, timestamp: iso(-1000) },
  ];

  const cycles = detectCircularFlow(transactions, ['M']);

  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].path, ['M', 'A', 'B', 'M']);
});

test('detectCircularFlow: detects a Merchant -> A -> B -> C -> Merchant cycle', () => {
  const transactions = [
    { sender_id: 'M', receiver_id: 'A', amount: 500, timestamp: iso(-7000) },
    { sender_id: 'A', receiver_id: 'B', amount: 480, timestamp: iso(-5000) },
    { sender_id: 'B', receiver_id: 'C', amount: 460, timestamp: iso(-3000) },
    { sender_id: 'C', receiver_id: 'M', amount: 440, timestamp: iso(-1000) },
  ];

  const cycles = detectCircularFlow(transactions, ['M']);

  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].path, ['M', 'A', 'B', 'C', 'M']);
});

test('detectCircularFlow: does not flag a straight-line payout with no path back to the origin', () => {
  const transactions = [
    { sender_id: 'M', receiver_id: 'A', amount: 500, timestamp: iso(-3000) },
    { sender_id: 'A', receiver_id: 'B', amount: 480, timestamp: iso(-1000) },
  ];

  const cycles = detectCircularFlow(transactions, ['M']);

  assert.equal(cycles.length, 0);
});

test('detectCircularFlow: does not flag a cycle exceeding the configured max hops', () => {
  const config = require('../server/config');
  // One more intermediate hop than MAX_CYCLE_HOPS allows.
  const chain = ['M', 'A', 'B', 'C', 'D', 'M'].slice(0, config.CIRCULAR_FLOW.MAX_CYCLE_HOPS + 3);
  const transactions = [];
  for (let i = 0; i < chain.length - 1; i += 1) {
    transactions.push({ sender_id: chain[i], receiver_id: chain[i + 1], amount: 100, timestamp: iso(-1000 * (chain.length - i)) });
  }

  const cycles = detectCircularFlow(transactions, ['M']);

  assert.equal(cycles.length, 0);
});

test('backgroundJob.runScanCycle: a circular-flow cycle is persisted as a structuring_alerts row and picked up by the fast lookup', () => {
  const db = buildTestDb();
  const nowMs = BASE_TIME;
  db.prepare('INSERT INTO business_accounts (account_id, created_at) VALUES (?, ?)').run('m_circular', iso(-3600000));

  for (const userId of ['m_circular', 'circ_a', 'circ_b']) insertUser(db, userId, iso(-3600000));
  insertTransaction(db, { sender_id: 'm_circular', receiver_id: 'circ_a', amount: 5000, timestamp: iso(-3000), transaction_type: 'transfer' });
  insertTransaction(db, { sender_id: 'circ_a', receiver_id: 'circ_b', amount: 4800, timestamp: iso(-2000), transaction_type: 'transfer' });
  insertTransaction(db, { sender_id: 'circ_b', receiver_id: 'm_circular', amount: 4600, timestamp: iso(-1000), transaction_type: 'transfer' });

  const created = runScanCycle(db, nowMs);
  const circularAlert = created.find((a) => a.reason.startsWith('Circular transaction pattern detected.'));
  assert.ok(circularAlert, 'expected a circular-flow alert to be created');
  assert.equal(circularAlert.sender_id, 'm_circular');
  assert.deepEqual(JSON.parse(circularAlert.receiver_ids), ['circ_a', 'circ_b']);

  const lookup = findActiveAlert(db, 'circ_a', 'someone_else', nowMs);
  assert.equal(lookup.active, true, 'an account in the cycle should be caught by the existing fast lookup with no changes to it');
});

test('backgroundJob.runScanCycle: a circular-flow alert does NOT auto-blacklist the business account that is its origin (regression)', () => {
  // A circular-flow alert's sender_id is always one of the business's own registered accounts
  // (detectCircularFlow's originIds come from business_accounts) -- auto-blacklisting FA198 must
  // only ever apply to genuine structuring alerts, where sender_id is the actual suspected
  // launderer, or it would force-block every future transaction touching the business's own
  // account (blacklist floors the score regardless of direction) the moment its own money
  // legitimately cycles back through a vendor/refund relationship.
  const db = buildTestDb();
  const nowMs = BASE_TIME;
  db.prepare('INSERT INTO business_accounts (account_id, created_at) VALUES (?, ?)').run('m_circular_no_blacklist', iso(-3600000));

  for (const userId of ['m_circular_no_blacklist', 'circ_x', 'circ_y']) insertUser(db, userId, iso(-3600000));
  insertTransaction(db, { sender_id: 'm_circular_no_blacklist', receiver_id: 'circ_x', amount: 5000, timestamp: iso(-3000), transaction_type: 'transfer' });
  insertTransaction(db, { sender_id: 'circ_x', receiver_id: 'circ_y', amount: 4800, timestamp: iso(-2000), transaction_type: 'transfer' });
  insertTransaction(db, { sender_id: 'circ_y', receiver_id: 'm_circular_no_blacklist', amount: 4600, timestamp: iso(-1000), transaction_type: 'transfer' });

  const created = runScanCycle(db, nowMs);
  assert.ok(created.some((a) => a.reason.startsWith('Circular transaction pattern detected.')), 'expected a circular-flow alert to be created');

  const { checkFraudLists } = require('../server/fraudLists');
  assert.equal(
    checkFraudLists(db, 'm_circular_no_blacklist', 'm_circular_no_blacklist').blacklisted,
    false,
    'the business account must not be auto-blacklisted just for being a circular-flow origin'
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fraud_lists WHERE account_id = 'm_circular_no_blacklist'").get().n, 0);
});

test('alertLookup.findActiveAlert: an ordinary customer paying a business with an active circular-flow alert is NOT treated as an active-alert hit (regression)', () => {
  // Found live via demo seed data: circular-flow alerts record the business's own account as
  // sender_id (the detection origin -- see backgroundJob.js), but findActiveAlert previously
  // treated "receiver_id matches some alert's stored sender_id" as proof of an active bad actor
  // regardless of alert type. Once a business had ever been the origin of a circular-flow alert,
  // every ordinary customer paying that business for the next 24h hit this same false match and
  // force-blocked at STRUCTURING_ALERT_FLOOR -- reproduced against real seeded data where every
  // demo store ended up with its own circular-flow alert and every subsequent purchase blocked.
  const db = buildTestDb();
  const nowMs = BASE_TIME;
  db.prepare('INSERT INTO business_accounts (account_id, created_at) VALUES (?, ?)').run('m_circular_alertlookup', iso(-3600000));

  for (const userId of ['m_circular_alertlookup', 'circ_p', 'circ_q']) insertUser(db, userId, iso(-3600000));
  insertTransaction(db, { sender_id: 'm_circular_alertlookup', receiver_id: 'circ_p', amount: 5000, timestamp: iso(-3000), transaction_type: 'transfer' });
  insertTransaction(db, { sender_id: 'circ_p', receiver_id: 'circ_q', amount: 4800, timestamp: iso(-2000), transaction_type: 'transfer' });
  insertTransaction(db, { sender_id: 'circ_q', receiver_id: 'm_circular_alertlookup', amount: 4600, timestamp: iso(-1000), transaction_type: 'transfer' });

  const created = runScanCycle(db, nowMs);
  assert.ok(created.some((a) => a.reason.startsWith('Circular transaction pattern detected.')), 'expected a circular-flow alert to be created');

  // A brand-new customer who has never touched this alert, paying the business.
  const ordinaryPurchase = findActiveAlert(db, 'u_brand_new_customer', 'm_circular_alertlookup', nowMs);
  assert.equal(ordinaryPurchase.active, false, 'an ordinary customer paying a business must not be blocked just because that business was once a circular-flow origin');

  // The business making another ordinary outbound payment (e.g. a refund) must also not be
  // treated as "the sender of an active alert" just because it's the circular-flow origin.
  const ordinaryOutbound = findActiveAlert(db, 'm_circular_alertlookup', 'u_another_customer', nowMs);
  assert.equal(ordinaryOutbound.active, false);

  // The actual suspicious intermediate accounts (the cycle's real participants, in receiver_ids)
  // must still be caught -- this fix must not blind the lookup to genuine circular-flow suspects.
  const realSuspect = findActiveAlert(db, 'circ_p', 'someone_else', nowMs);
  assert.equal(realSuspect.active, true);
});
