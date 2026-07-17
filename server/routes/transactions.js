const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();

const { validateTransactionInput } = require('../validate');
const { ensureUserExists, getUserHistory, updateUserAfterTransaction } = require('../userProfile');
const findActiveAlert = require('../structuring/alertLookup');
const computeFraudScore = require('../scoring');
const decide = require('../decision');
const { getFraudProbability } = require('../ml/mlClient');
// Applied per-route below (`router.post('/transaction', requireApiKey, ...)` etc.), not as
// `router.use(requireApiKey)` at the top of this file. That distinction matters: server/index.js
// mounts this whole router at `app.use('/', ...)`, which — same as `router.use()` would — runs
// for every request that reaches it, whether or not any route inside actually matches. A blanket
// `router.use(requireApiKey)` here reproduced the exact bug this comment is warning against, just
// one file lower: it doesn't stop being "every path" just because it moved from index.js into
// this router. Found live (in a real browser, not curl) after the previous fix: the dashboard's
// own style.css/app.js/map.js/audit.js — none of which are routes this file defines — were being
// rejected with 401 before they could ever reach express.static in index.js, since <link>/<script
// src> tags can't attach the X-API-Key header the way authFetch()'s explicit fetch() calls can.
// The whole dashboard was unstyled and inert as a result. Scoping the middleware to only the
// routes that actually need it lets an unmatched path (style.css, a 404, anything) fall through
// past this router entirely, the same as it would have with no auth middleware in the chain at all.
const { requireApiKey, requireRole } = require('../middleware/apiKeyAuth');
const { isBusinessAccount } = require('../businessAccounts');
const getOutboundContext = require('../outboundContext');
const applyOutboundRestrictors = require('../outboundRestrictor');
const { checkFraudLists } = require('../fraudLists');
const { dispatchCriticalAlert } = require('../notifications');

const velocity = require('../rules/velocity');
const impossibleTravel = require('../rules/impossibleTravel');
const amountAnomaly = require('../rules/amountAnomaly');
const deviceMismatch = require('../rules/deviceMismatch');
const oddHour = require('../rules/oddHour');
const refundWithoutPurchase = require('../rules/refundWithoutPurchase');
const payoutToNewReceiver = require('../rules/payoutToNewReceiver');
const outboundRatioAnomaly = require('../rules/outboundRatioAnomaly');
const outboundFanOutBurst = require('../rules/outboundFanOutBurst');
const refundAccountMismatch = require('../rules/refundAccountMismatch');
const multipleRefundDetection = require('../rules/multipleRefundDetection');
const splitRefundDetection = require('../rules/splitRefundDetection');
const refundVelocity = require('../rules/refundVelocity');
const newVendorRisk = require('../rules/newVendorRisk');
const dormantAccountReactivation = require('../rules/dormantAccountReactivation');
const muleReceiverRisk = require('../rules/muleReceiverRisk');
const geoRisk = require('../rules/geoRisk');
const merchantAccountTakeover = require('../rules/merchantAccountTakeover');
const friendlyFraud = require('../rules/friendlyFraud');
const employeeFraud = require('../rules/employeeFraud');
const crossGatewayStructuring = require('../rules/crossGatewayStructuring');
const duplicateTransaction = require('../rules/duplicateTransaction');
const sharedIdentifierRisk = require('../rules/sharedIdentifierRisk');

const RULE_DETECTORS = [
  { type: 'velocity', check: velocity },
  { type: 'impossible_travel', check: impossibleTravel },
  { type: 'amount_anomaly', check: amountAnomaly },
  { type: 'device_mismatch', check: deviceMismatch },
  { type: 'odd_hour', check: oddHour },
];

// Outbound-only detectors -- run against getOutboundContext (below), not the sender's own
// getUserHistory. Only evaluated for transactions whose sender is a registered business account
// (money leaving the business); see the fraud/AML scoping comment on POST /transaction.
const OUTBOUND_RULE_DETECTORS = [
  { type: 'refund_without_purchase', check: refundWithoutPurchase },
  { type: 'payout_new_receiver', check: payoutToNewReceiver },
  { type: 'outbound_ratio_anomaly', check: outboundRatioAnomaly },
  { type: 'outbound_fan_out_burst', check: outboundFanOutBurst },
  { type: 'refund_account_mismatch', check: refundAccountMismatch },
  { type: 'multiple_refund_detection', check: multipleRefundDetection },
  { type: 'split_refund_detection', check: splitRefundDetection },
  { type: 'refund_velocity', check: refundVelocity },
  { type: 'new_vendor_risk', check: newVendorRisk },
  { type: 'dormant_account_reactivation', check: dormantAccountReactivation },
  { type: 'mule_receiver_risk', check: muleReceiverRisk },
  { type: 'geo_risk', check: geoRisk },
  { type: 'merchant_account_takeover', check: merchantAccountTakeover },
  { type: 'friendly_fraud', check: friendlyFraud },
  { type: 'employee_fraud', check: employeeFraud },
  { type: 'cross_gateway_structuring', check: crossGatewayStructuring },
  { type: 'duplicate_transaction', check: duplicateTransaction },
  { type: 'shared_identifier_risk', check: sharedIdentifierRisk },
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
// analyst-or-above (Section 16, Category 20 RBAC): ingesting a transaction is an operational
// action, not a read -- a viewer-only key can watch the dashboard but not inject transactions.
router.post('/transaction', requireApiKey, requireRole('analyst'), async (req, res, next) => {
  const requestStartMs = process.hrtime.bigint(); // Feature 18 analytics: average response latency -- not a scoring input, measured purely for observability
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

    // The structuring-alert lookup always runs, regardless of direction: a known laundering
    // ring doesn't get a pass just because it's paying the business rather than being paid by
    // it (Task 7 DoD -- "an active structuring alert always forces block, regardless of
    // transaction size" -- must hold for every transaction, not just outbound ones).
    const structuringLookup = findActiveAlert(db, input.sender_id, input.receiver_id, nowMs);

    // Section 16 (Categories 19/21): the fraud_lists check also always runs, regardless of
    // direction, same reasoning as the structuring lookup above -- a blacklisted account is a
    // confirmed bad actor either way.
    const fraudListCheck = checkFraudLists(db, input.sender_id, input.receiver_id);

    // Fraud/AML behavioral scoring (the rule detectors + ML) only runs for money leaving the
    // business -- a customer paying the business isn't a risk this system is positioned to
    // police (that's the card network's/payment gateway's problem: stolen cards, chargebacks),
    // while money leaving the business unaccountably is the actual theft/laundering vector this
    // product exists to catch (architecture.md Section 4.1).
    const outbound = isBusinessAccount(db, input.sender_id);

    let ruleResults = [];
    let mlProbability = 0;
    if (outbound) {
      const userHistory = getUserHistory(db, input.sender_id, nowMs);
      const outboundContext = getOutboundContext(db, input, nowMs);

      ruleResults = [
        ...RULE_DETECTORS.map(({ type, check }) => ({ type, ...check(input, userHistory) })),
        ...OUTBOUND_RULE_DETECTORS.map(({ type, check }) => ({ type, ...check(input, outboundContext) })),
      ];
      mlProbability = await getFraudProbability(input, userHistory);
    }

    let { score, reasons, riskBreakdown, severity, confidence } = computeFraudScore(ruleResults, structuringLookup, mlProbability, fraudListCheck);
    if (outbound) {
      const reasonCountBeforeRestrictor = reasons.length;
      ({ score, reasons } = applyOutboundRestrictors(score, reasons, input));
      // applyOutboundRestrictors is a pure amount-based floor, not a detector -- it has no
      // `type`/`severity` of its own, but riskBreakdown should still account for any reason it
      // appended so the two stay in sync (Feature 17: every reason traceable in the breakdown).
      if (reasons.length > reasonCountBeforeRestrictor) {
        riskBreakdown = [
          ...riskBreakdown,
          { type: 'outbound_amount_restrictor', reason: reasons[reasons.length - 1], weight: null, severity: 'Medium' },
        ];
      }
    }
    const decision = decide(score);

    const transactionId = `t_${crypto.randomUUID()}`;
    const latencyMs = Number(process.hrtime.bigint() - requestStartMs) / 1e6;

    db.prepare(
      `INSERT INTO transactions
        (transaction_id, sender_id, receiver_id, amount, timestamp, location_lat, location_lng, device_id, merchant_id, purpose, transaction_type, fraud_score, decision, reference_transaction_id, employee_id, country, ip_address, latency_ms, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      input.purpose,
      input.transaction_type,
      score,
      decision,
      input.reference_transaction_id,
      input.employee_id,
      input.country,
      input.ip_address,
      latencyMs,
      confidence
    );

    const flagInsert = db.prepare(
      'INSERT INTO flags (flag_id, transaction_id, flag_type, reason, weight, severity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const r of ruleResults) {
      if (r.flagged) {
        flagInsert.run(`fl_${crypto.randomUUID()}`, transactionId, r.type, r.reason, r.weight, r.severity || null, input.timestamp);
      }
    }

    updateUserAfterTransaction(db, input.sender_id, input);

    // Section 15.16, Feature 17: every response includes fraud_score, decision, severity,
    // detector names + human-readable reasons (risk_breakdown), and the plain reasons array
    // (kept for backward compatibility with existing callers/tests). Section 16, Category 13:
    // `confidence` (0-100) is a separate axis from `fraud_score` -- how much independent
    // corroboration backs this decision, not how risky the transaction looks.
    const responseBody = {
      transaction_id: transactionId,
      fraud_score: score,
      decision,
      severity,
      confidence,
      reasons,
      risk_breakdown: riskBreakdown,
    };

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
        purpose: input.purpose,
        transaction_type: input.transaction_type,
        reference_transaction_id: input.reference_transaction_id,
        employee_id: input.employee_id,
        country: input.country,
        ip_address: input.ip_address,
      });
    }

    // Section 16, Category 17: Critical Fraud Alerts, dispatched to every configured
    // notification channel. Deliberately not awaited -- a slow/unreachable Slack/Twilio/SMTP
    // endpoint must never add latency to the scoring decision itself (the same reasoning that
    // keeps the structuring engine's heavy analysis off the synchronous per-transaction path).
    // dispatchCriticalAlert never throws (every channel's own error is caught internally), but
    // .catch is kept as a defensive backstop against an unexpected synchronous throw.
    if (severity === 'Critical') {
      const alertMessage = `[SentinelPay] Critical fraud alert: ${transactionId} (${input.sender_id} -> ${input.receiver_id}, ${input.amount}) blocked at score ${score}. ${reasons.join('; ')}`;
      dispatchCriticalAlert(alertMessage).catch(() => {});
    }

    res.status(201).json(responseBody);
  } catch (err) {
    next(err);
  }
});

// GET /transactions?limit=50&decision=block,step_up — recent transactions for the dashboard's
// live table and the audit trail view. `decision` (optional, comma-separated) filters to one
// or more of allow/step_up/block — used by the audit trail to show only flagged transactions.
router.get('/transactions', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  // Express parses a repeated query param (?decision=a&decision=b) as an array, not a string —
  // without normalizing that case here too, it silently fell through the `typeof === 'string'`
  // check below and returned every transaction unfiltered instead of filtering or erroring.
  const rawDecisionParam = Array.isArray(req.query.decision) ? req.query.decision.join(',') : req.query.decision;

  let decisionFilter = null;
  if (typeof rawDecisionParam === 'string' && rawDecisionParam.trim() !== '') {
    const requested = rawDecisionParam.split(',').map((d) => d.trim());
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
  const breakdownByTransaction = new Map();
  if (transactionIds.length > 0) {
    const flagRows = db
      .prepare(
        `SELECT transaction_id, flag_type, reason, weight, severity FROM flags WHERE transaction_id IN (${transactionIds.map(() => '?').join(',')})`
      )
      .all(...transactionIds);
    for (const f of flagRows) {
      if (!reasonsByTransaction.has(f.transaction_id)) reasonsByTransaction.set(f.transaction_id, []);
      reasonsByTransaction.get(f.transaction_id).push(f.reason);
      if (!breakdownByTransaction.has(f.transaction_id)) breakdownByTransaction.set(f.transaction_id, []);
      breakdownByTransaction.get(f.transaction_id).push({ type: f.flag_type, reason: f.reason, weight: f.weight, severity: f.severity });
    }
  }

  function overallSeverity(breakdown) {
    const rank = { Low: 1, Medium: 2, High: 3, Critical: 4 };
    let worst = 'None';
    for (const entry of breakdown) {
      if (entry.severity && (rank[entry.severity] || 0) > (rank[worst] || 0)) worst = entry.severity;
    }
    return worst;
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
      purpose: row.purpose,
      transaction_type: row.transaction_type,
      fraud_score: row.fraud_score,
      decision: row.decision,
      reference_transaction_id: row.reference_transaction_id,
      employee_id: row.employee_id,
      country: row.country,
      ip_address: row.ip_address,
      reasons: reasonsByTransaction.get(row.transaction_id) || [],
      risk_breakdown: breakdownByTransaction.get(row.transaction_id) || [],
      severity: overallSeverity(breakdownByTransaction.get(row.transaction_id) || []),
      confidence: row.confidence,
    }))
  );
});

// GET /audit/summary?hours=24&bucketMinutes=60 — Task 11 (audit trail / analytics view):
// time-bucketed counts of allow/step_up/block over a lookback window, for a trend chart
// showing fraud activity over time rather than a single point-in-time snapshot.
router.get('/audit/summary', requireApiKey, (req, res) => {
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
router.get('/alerts', requireApiKey, (req, res) => {
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
