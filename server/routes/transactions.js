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

    updateUserAfterTransaction(db, input.sender_id, input, userHistory.transactionCount);

    const responseBody = { transaction_id: transactionId, fraud_score: score, decision, reasons };

    const wss = req.app.locals.wss;
    if (wss && typeof wss.broadcast === 'function') {
      wss.broadcast('transaction', responseBody);
    }

    res.status(201).json(responseBody);
  } catch (err) {
    next(err);
  }
});

// GET /transactions?limit=50 — recent transactions for the dashboard's live table.
router.get('/transactions', (req, res) => {
  const db = req.app.locals.db;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  const rows = db
    .prepare('SELECT * FROM transactions ORDER BY timestamp DESC LIMIT ?')
    .all(limit);

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
    }))
  );
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
