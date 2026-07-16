const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();

const { validateTransactionInput } = require('../validate');
const { ensureUserExists, getUserHistory, updateUserAfterTransaction } = require('../userProfile');
const findActiveAlert = require('../structuring/alertLookup');
const computeFraudScore = require('../scoring');
const decide = require('../decision');
const { getFraudProbability } = require('../ml/mlClient');

const velocity = require('../rules/velocity');
const impossibleTravel = require('../rules/impossibleTravel');
const amountAnomaly = require('../rules/amountAnomaly');
const deviceMismatch = require('../rules/deviceMismatch');
const oddHour = require('../rules/oddHour');

const RULE_DETECTORS = [
  { type: 'velocity', check: velocity },
  { type: 'impossible_travel', check: impossibleTravel },
  { type: 'amount_anomaly', check: amountAnomaly },
  { type: 'device_mismatch', check: deviceMismatch },
  { type: 'odd_hour', check: oddHour },
];

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const VALID_DECISIONS = ['allow', 'step_up', 'block'];
const DEFAULT_AUDIT_HOURS = 24; // default lookback window for the audit trend summary
const MAX_AUDIT_HOURS = 24 * 90; // cap at ~90 days so a huge range can't make one request scan the whole table pathologically
const DEFAULT_BUCKET_MINUTES = 60;
const MIN_BUCKET_MINUTES = 1;
const MAX_BUCKET_MINUTES = 24 * 60; // one bucket per day, at most

// POST /transaction — the whole scoring pipeline (rules + structuring lookup + ML + decision)
// runs synchronously in this handler before responding. No async/polling pattern (CLAUDE.md
// hard rule).
//
// Wrapped in try/catch + next(err): Express 4 (unlike Express 5) does not automatically catch
// rejected promises or errors thrown after an `await` inside an async handler — without this,
// a single DB error or ML client failure here would become an unhandled promise rejection
// (hanging the client forever, and potentially crashing the whole process on modern Node,
// which terminates by default on unhandled rejections) instead of reaching the error-handling
// middleware in index.js.
router.post('/transaction', async (req, res, next) => {
  try {
    const db = req.app.locals.db;

    const validation = validateTransactionInput(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    const input = validation.value;

    // Security: the client-supplied timestamp is validated for shape (see validate.js) but
    // never trusted as the anchor for time-window logic. Every window check in this pipeline
    // — velocity (60s), impossible travel (elapsed-time speed), the structuring alert's
    // "is this alert still active" lookup, the recent-transactions lookback used for rules and
    // ML features — is keyed off `nowMs`. If a caller could set that to an arbitrary value,
    // a future-dated transaction would shift the structuring-alert activity window forward
    // past every real alert's created_at, silently defeating the "an active structuring alert
    // always forces block, regardless of transaction size" guarantee (Task 7 DoD); a
    // backdated one could similarly hide a rapid burst from the velocity check. This system
    // sits between a payment gateway and settlement (architecture.md Section 1) and scores
    // synchronously in real time, so server-received time and the true event time should
    // already be milliseconds apart for any legitimate caller — overriding here costs nothing
    // for honest traffic and closes the manipulation vector for a compromised/malicious one.
    // The DB and API responses now record server-received time as the transaction's timestamp.
    input.timestamp = new Date().toISOString();
    const nowMs = new Date(input.timestamp).getTime();

    ensureUserExists(db, input.sender_id, input.timestamp);
    ensureUserExists(db, input.receiver_id, input.timestamp);

    const userHistory = getUserHistory(db, input.sender_id, nowMs);

    const ruleResults = RULE_DETECTORS.map(({ type, check }) => ({
      type,
      ...check(input, userHistory),
    }));

    const structuringLookup = findActiveAlert(db, input.sender_id, input.receiver_id, nowMs);
    const mlProbability = await getFraudProbability(input, userHistory);

    const { score, reasons } = computeFraudScore(ruleResults, structuringLookup, mlProbability);
    const decision = decide(score);

    const transactionId = `t_${crypto.randomUUID()}`;

    db.prepare(
      `INSERT INTO transactions
        (transaction_id, sender_id, receiver_id, amount, timestamp, location_lat, location_lng, device_id, merchant_id, transaction_type, fraud_score, decision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      transactionId,
      input.sender_id,
      input.receiver_id,
      input.amount,
      input.timestamp,
      input.location ? input.location.lat : null,
      input.location ? input.location.lng : null,
      input.device_id,
      input.merchant_id,
      input.transaction_type,
      score,
      decision
    );

    const flagInsert = db.prepare(
      'INSERT INTO flags (flag_id, transaction_id, flag_type, reason, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const r of ruleResults) {
      if (r.flagged) {
        flagInsert.run(`fl_${crypto.randomUUID()}`, transactionId, r.type, r.reason, r.weight, input.timestamp);
      }
    }

    updateUserAfterTransaction(db, input.sender_id, input);

    const responseBody = { transaction_id: transactionId, fraud_score: score, decision, reasons };

    // The WS broadcast carries the full transaction, not just the POST response shape: the
    // live dashboard table (sender/receiver/amount/type/time columns) and the map view
    // (location) both need it, and every field here was already known before this handler
    // even queried anything, so there's no extra cost to including it. Architecture.md
    // Section 7 originally documented the WS payload as "same as POST /transaction response"
    // — a spec gap, not a deliberate minimalism: with only {transaction_id, fraud_score,
    // decision, reasons} on the wire, every live row in the dashboard's table rendered blank
    // dashes for sender/receiver/amount/type (app.js's fallbacks silently masked it), and the
    // map could never plot a single live transaction (no location field to plot). Fixed here;
    // architecture.md Section 7 updated to match reality.
    const wss = req.app.locals.wss;
    if (wss && typeof wss.broadcast === 'function') {
      wss.broadcast('transaction', {
        ...responseBody,
        sender_id: input.sender_id,
        receiver_id: input.receiver_id,
        amount: input.amount,
        timestamp: input.timestamp,
        location: input.location,
        device_id: input.device_id,
        merchant_id: input.merchant_id,
        transaction_type: input.transaction_type,
      });
    }

    res.status(201).json(responseBody);
  } catch (err) {
    next(err);
  }
});

// GET /transactions?limit=50&decision=block,step_up — recent transactions for the dashboard's
// live table and the audit trail view. `decision` (optional, comma-separated) filters to one
// or more of allow/step_up/block — used by the audit trail to show only flagged transactions.
router.get('/transactions', (req, res) => {
  const db = req.app.locals.db;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  let decisionFilter = null;
  if (typeof req.query.decision === 'string' && req.query.decision.trim() !== '') {
    const requested = req.query.decision.split(',').map((d) => d.trim());
    const valid = requested.filter((d) => VALID_DECISIONS.includes(d));
    if (valid.length === 0) {
      return res.status(400).json({ error: `decision must be one or more of: ${VALID_DECISIONS.join(', ')}` });
    }
    decisionFilter = valid;
  }

  const whereClause = decisionFilter ? `WHERE decision IN (${decisionFilter.map(() => '?').join(',')})` : '';
  const rows = db
    .prepare(`SELECT * FROM transactions ${whereClause} ORDER BY timestamp DESC LIMIT ?`)
    .all(...(decisionFilter || []), limit);

  const transactionIds = rows.map((r) => r.transaction_id);
  const reasonsByTransaction = new Map();
  if (transactionIds.length > 0) {
    const flagRows = db
      .prepare(`SELECT transaction_id, reason FROM flags WHERE transaction_id IN (${transactionIds.map(() => '?').join(',')})`)
      .all(...transactionIds);
    for (const f of flagRows) {
      if (!reasonsByTransaction.has(f.transaction_id)) reasonsByTransaction.set(f.transaction_id, []);
      reasonsByTransaction.get(f.transaction_id).push(f.reason);
    }
  }

  res.json(
    rows.map((row) => ({
      transaction_id: row.transaction_id,
      sender_id: row.sender_id,
      receiver_id: row.receiver_id,
      amount: row.amount,
      timestamp: row.timestamp,
      location:
        row.location_lat != null && row.location_lng != null
          ? { lat: row.location_lat, lng: row.location_lng }
          : null,
      device_id: row.device_id,
      merchant_id: row.merchant_id,
      transaction_type: row.transaction_type,
      fraud_score: row.fraud_score,
      decision: row.decision,
      reasons: reasonsByTransaction.get(row.transaction_id) || [],
    }))
  );
});

// GET /audit/summary?hours=24&bucketMinutes=60 — Task 11 (audit trail / analytics view):
// time-bucketed counts of allow/step_up/block over a lookback window, for a trend chart
// showing fraud activity over time rather than a single point-in-time snapshot.
router.get('/audit/summary', (req, res) => {
  const db = req.app.locals.db;
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || DEFAULT_AUDIT_HOURS, 1), MAX_AUDIT_HOURS);
  const bucketMinutes = Math.min(
    Math.max(parseInt(req.query.bucketMinutes, 10) || DEFAULT_BUCKET_MINUTES, MIN_BUCKET_MINUTES),
    MAX_BUCKET_MINUTES
  );
  const bucketMs = bucketMinutes * 60 * 1000;
  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const rows = db
    .prepare('SELECT timestamp, decision FROM transactions WHERE timestamp >= ? ORDER BY timestamp ASC')
    .all(sinceIso);

  const buckets = new Map();
  for (const row of rows) {
    const tMs = new Date(row.timestamp).getTime();
    const bucketStartMs = Math.floor(tMs / bucketMs) * bucketMs;
    if (!buckets.has(bucketStartMs)) {
      buckets.set(bucketStartMs, { bucket_start: new Date(bucketStartMs).toISOString(), allow: 0, step_up: 0, block: 0 });
    }
    const bucket = buckets.get(bucketStartMs);
    if (row.decision in bucket) bucket[row.decision] += 1;
  }

  const sortedBuckets = [...buckets.values()].sort((a, b) => new Date(a.bucket_start) - new Date(b.bucket_start));

  res.json({
    hours,
    bucketMinutes,
    totalTransactions: rows.length,
    buckets: sortedBuckets,
  });
});

// GET /alerts — active structuring/layering alerts, grouped (not per-transaction).
router.get('/alerts', (req, res) => {
  const db = req.app.locals.db;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  const rows = db
    .prepare('SELECT * FROM structuring_alerts ORDER BY created_at DESC LIMIT ?')
    .all(limit);

  res.json(
    rows.map((row) => ({
      alert_id: row.alert_id,
      sender_id: row.sender_id,
      receiver_ids: JSON.parse(row.receiver_ids),
      total_amount: row.total_amount,
      transaction_count: row.transaction_count,
      window_start: row.window_start,
      window_end: row.window_end,
      withdrawal_ratio: row.withdrawal_ratio,
      reason: row.reason,
      created_at: row.created_at,
    }))
  );
});

module.exports = router;
