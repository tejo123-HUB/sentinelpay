// Section 15.16, Feature 18: analytics endpoints for the dashboard's Feature 15 panels and for
// programmatic reporting. All read-only, all reuse the existing transactions/flags/
// structuring_alerts tables (Feature 19's "reuse existing database" requirement) -- no new
// tables here, only new queries over what already exists (plus transactions.latency_ms, added
// alongside this feature purely for the average-latency stat).
const express = require('express');
const router = express.Router();

const { requireApiKey } = require('../middleware/apiKeyAuth');
const { computeMuleScore } = require('../muleScore');
const { buildXlsxWorkbook } = require('../xlsxWriter');
const { FRAUD_SIGNATURES } = require('../fraudSignatures');

const DEFAULT_TOP_LIMIT = 10;
const MAX_TOP_LIMIT = 100;
const MULE_CANDIDATE_SCAN_LIMIT = 200; // bounds the per-receiver mule-score scan, same reasoning as MULE_SCORE_MAX_RECEIPTS_SCANNED
const VALID_DIMENSIONS = ['customers', 'merchants', 'employees', 'vendors', 'devices', 'ips', 'countries'];
const DIMENSION_COLUMN = {
  customers: 'receiver_id',
  merchants: 'sender_id',
  employees: 'employee_id',
  vendors: 'receiver_id',
  devices: 'device_id',
  ips: 'ip_address',
  countries: 'country',
};

function clampLimit(raw) {
  return Math.min(Math.max(parseInt(raw, 10) || DEFAULT_TOP_LIMIT, 1), MAX_TOP_LIMIT);
}

// GET /analytics/summary — overview stats for the dashboard's top stat-card row.
router.get('/analytics/summary', requireApiKey, (req, res) => {
  const db = req.app.locals.db;

  const totals = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END) AS allowed,
        SUM(CASE WHEN decision = 'step_up' THEN 1 ELSE 0 END) AS step_up,
        SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS blocked,
        COALESCE(SUM(CASE WHEN decision = 'block' THEN amount ELSE 0 END), 0) AS blocked_amount,
        COALESCE(SUM(CASE WHEN decision != 'block' AND fraud_score >= 40 THEN amount ELSE 0 END), 0) AS recovered_amount,
        COALESCE(AVG(fraud_score), 0) AS avg_fraud_score,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms
      FROM transactions`
    )
    .get();

  const total = totals.total || 0;
  const flagged = (totals.step_up || 0) + (totals.blocked || 0);

  res.json({
    total_processed: total,
    allowed: totals.allowed || 0,
    step_up: totals.step_up || 0,
    blocked: totals.blocked || 0,
    fraud_percent: total > 0 ? Number(((flagged / total) * 100).toFixed(2)) : 0,
    // "Recovered amount" (architecture.md Section 4.1, Feature 15): the total value of
    // transactions that scored risky enough to warrant a step-up/block-tier signal
    // (fraud_score >= 40) but were not ultimately blocked -- money that step-up authentication
    // plausibly saved from being lost, not a literal chargeback-recovery event (this system has
    // no post-decision recovery workflow to observe directly).
    blocked_amount: Number(totals.blocked_amount.toFixed(2)),
    recovered_amount: Number(totals.recovered_amount.toFixed(2)),
    avg_fraud_score: Number(totals.avg_fraud_score.toFixed(2)),
    avg_latency_ms: Number(totals.avg_latency_ms.toFixed(2)),
  });
});

// GET /analytics/top-frauds?limit=10 — most common fraud/flag types, for the "top fraud
// categories" dashboard panel.
router.get('/analytics/top-frauds', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const limit = clampLimit(req.query.limit);

  const rows = db
    .prepare(
      `SELECT flag_type, COUNT(*) AS count, COALESCE(AVG(weight), 0) AS avg_weight
       FROM flags GROUP BY flag_type ORDER BY count DESC LIMIT ?`
    )
    .all(limit);

  res.json(rows.map((r) => ({ flag_type: r.flag_type, count: r.count, avg_weight: Number(r.avg_weight.toFixed(2)) })));
});

// GET /analytics/fraud-signatures -- Section 17 (FA216, "Fraud Signature Database"): the full
// catalog of every flag_type this system can produce (server/fraudSignatures.js), each with a
// human-readable description and its live occurrence count -- unlike top-frauds below, a
// signature that has never fired still appears here with occurrences: 0, since this is a
// database of *known signatures*, not a ranking of *observed* ones.
router.get('/analytics/fraud-signatures', requireApiKey, (req, res) => {
  const db = req.app.locals.db;

  const countRows = db.prepare('SELECT flag_type, COUNT(*) AS n FROM flags GROUP BY flag_type').all();
  const countsByType = new Map(countRows.map((r) => [r.flag_type, r.n]));

  res.json(
    FRAUD_SIGNATURES.map((sig) => ({
      ...sig,
      occurrences: countsByType.get(sig.flag_type) || 0,
    }))
  );
});

// GET /analytics/top-risky?dimension=customers|merchants|employees|vendors|devices|ips|countries&limit=10
// One generic endpoint instead of eight near-identical ones (Feature 15's "top risky
// customers/merchants/employees/vendors/devices/IPs/countries" panels) -- avoids duplicating the
// same GROUP BY logic eight times over. "customers" and "vendors" both key off receiver_id but
// are split by whether the transaction was a refund (customer) or not (vendor payout), since
// this schema has no separate role column to distinguish them.
router.get('/analytics/top-risky', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const dimension = req.query.dimension;
  if (!VALID_DIMENSIONS.includes(dimension)) {
    return res.status(400).json({ error: `dimension must be one of: ${VALID_DIMENSIONS.join(', ')}` });
  }
  const limit = clampLimit(req.query.limit);
  const column = DIMENSION_COLUMN[dimension];

  let purposeClause = '';
  if (dimension === 'customers') purposeClause = "AND LOWER(t.purpose) LIKE '%refund%'";
  if (dimension === 'vendors') purposeClause = "AND (t.purpose IS NULL OR LOWER(t.purpose) NOT LIKE '%refund%')";

  const rows = db
    .prepare(
      `SELECT t.${column} AS key, COUNT(DISTINCT f.transaction_id) AS flagged_count, COALESCE(SUM(t.amount), 0) AS total_amount
       FROM flags f
       JOIN transactions t ON t.transaction_id = f.transaction_id
       WHERE t.${column} IS NOT NULL ${purposeClause}
       GROUP BY t.${column}
       ORDER BY flagged_count DESC
       LIMIT ?`
    )
    .all(limit);

  res.json(rows.map((r) => ({ key: r.key, flagged_count: r.flagged_count, total_amount: Number(r.total_amount.toFixed(2)) })));
});

// GET /analytics/risk-profile?dimension=customers|merchants|vendors|employees|devices&id=...
// Section 16, Categories 6/7/8 (Customer/Merchant/Vendor Intelligence): a dedicated per-entity
// risk profile -- "Customer Risk Score/Profile", "Merchant Health Score", "Vendor Trust Score" --
// beyond the ranked top-risky list (which only ever answers "who's riskiest right now", not "how
// risky is this specific ID"). Reuses the exact same dimension/column/purpose-filter convention as
// GET /analytics/top-risky (`vendors`/`customers` both key off receiver_id, split by refund
// purpose, same as that handler) -- no new tables, same "reuse existing database" reasoning as the
// rest of Feature 18/19.
router.get('/analytics/risk-profile', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const dimension = req.query.dimension;
  const id = req.query.id;
  if (!VALID_DIMENSIONS.includes(dimension)) {
    return res.status(400).json({ error: `dimension must be one of: ${VALID_DIMENSIONS.join(', ')}` });
  }
  if (typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({ error: 'id is required' });
  }
  const column = DIMENSION_COLUMN[dimension];

  let purposeClause = '';
  if (dimension === 'customers') purposeClause = "AND LOWER(purpose) LIKE '%refund%'";
  if (dimension === 'vendors') purposeClause = "AND (purpose IS NULL OR LOWER(purpose) NOT LIKE '%refund%')";

  const totals = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN decision = 'step_up' THEN 1 ELSE 0 END) AS step_up,
        COALESCE(SUM(amount), 0) AS total_amount,
        COALESCE(AVG(fraud_score), 0) AS avg_fraud_score,
        MAX(timestamp) AS last_activity
       FROM transactions
       WHERE ${column} = ? ${purposeClause}`
    )
    .get(id);

  const total = totals.total || 0;
  const flaggedRow = db
    .prepare(
      `SELECT COUNT(DISTINCT f.transaction_id) AS n
       FROM flags f JOIN transactions t ON t.transaction_id = f.transaction_id
       WHERE t.${column} = ? ${purposeClause}`
    )
    .get(id);
  const flaggedCount = flaggedRow.n || 0;

  const topFlagTypes = db
    .prepare(
      `SELECT f.flag_type, COUNT(*) AS count
       FROM flags f JOIN transactions t ON t.transaction_id = f.transaction_id
       WHERE t.${column} = ? ${purposeClause}
       GROUP BY f.flag_type ORDER BY count DESC LIMIT 5`
    )
    .all(id);

  const recentTransactions = db
    .prepare(
      `SELECT transaction_id, amount, timestamp, decision, fraud_score
       FROM transactions WHERE ${column} = ? ${purposeClause}
       ORDER BY timestamp DESC LIMIT 10`
    )
    .all(id);

  // Explainability (CLAUDE.md hard rule: every score needs a human-readable reason, not just a
  // number): health_score is the inverse of average fraud_score across this entity's own
  // transaction history -- a plain, directly-traceable formula, not a black box. An entity with
  // no transaction history gets a neutral 100 (no evidence either way), same "innocent until a
  // signal says otherwise" default this project already uses for new vendors/receivers elsewhere.
  const healthScore = total > 0 ? Math.round(Math.max(0, Math.min(100, 100 - totals.avg_fraud_score))) : 100;
  let riskTier = 'Low';
  if (total > 0) {
    const flaggedRatio = flaggedCount / total;
    if (flaggedRatio >= 0.5 || healthScore < 40) riskTier = 'High';
    else if (flaggedRatio >= 0.2 || healthScore < 70) riskTier = 'Medium';
  }

  res.json({
    dimension,
    id,
    health_score: healthScore,
    risk_tier: riskTier,
    total_transactions: total,
    flagged_transactions: flaggedCount,
    flagged_ratio: total > 0 ? Number((flaggedCount / total).toFixed(4)) : 0,
    blocked: totals.blocked || 0,
    step_up: totals.step_up || 0,
    total_amount: Number((totals.total_amount || 0).toFixed(2)),
    avg_fraud_score: Number((totals.avg_fraud_score || 0).toFixed(2)),
    last_activity: totals.last_activity || null,
    top_flag_types: topFlagTypes.map((r) => ({ flag_type: r.flag_type, count: r.count })),
    recent_transactions: recentTransactions,
  });
});

// GET /analytics/mule-accounts?limit=10 — top suspected mule accounts (Feature 13's dashboard
// consumer), computed over the most-active recent receivers rather than every account ever seen.
router.get('/analytics/mule-accounts', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const limit = clampLimit(req.query.limit);
  const nowMs = Date.now();

  // Excludes the business's own registered accounts, same reasoning as outboundContext.js's
  // receiverMuleScore: a merchant receiving customer payments and paying them back out is
  // normal operation, not the mule pattern this list exists to surface.
  const businessAccountIds = new Set(db.prepare('SELECT account_id FROM business_accounts').all().map((r) => r.account_id));

  const candidates = db
    .prepare('SELECT receiver_id, COUNT(*) AS n FROM transactions GROUP BY receiver_id ORDER BY n DESC LIMIT ?')
    .all(MULE_CANDIDATE_SCAN_LIMIT);

  const scored = candidates
    .filter((c) => !businessAccountIds.has(c.receiver_id))
    .map((c) => ({ account_id: c.receiver_id, ...computeMuleScore(db, c.receiver_id, nowMs) }))
    .filter((s) => s.isMule)
    .sort((a, b) => b.qualifyingCycles - a.qualifyingCycles)
    .slice(0, limit);

  res.json(scored);
});

// GET /analytics/known-mules?limit=10 -- Section 17 (FA217, "Known Mule Database"): the persisted
// registry (mule_accounts table), populated in real time by POST /transaction the moment a
// receiver is confirmed a mule -- distinct from GET /analytics/mule-accounts above, which
// re-scores a bounded scan of recent receivers live, on every call. This is what makes it a real
// "database" (a standing record of accounts) rather than an on-demand computation.
router.get('/analytics/known-mules', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const limit = clampLimit(req.query.limit);

  const rows = db
    .prepare('SELECT account_id, qualifying_cycles, first_confirmed_at, last_seen_at FROM mule_accounts ORDER BY qualifying_cycles DESC, last_seen_at DESC LIMIT ?')
    .all(limit);

  res.json(rows);
});

// GET /analytics/gateway-comparison — per-merchant_id (gateway) volume/fraud comparison, for the
// "gateway comparison" dashboard panel -- the whole point of this product per architecture.md
// Section 1: one aggregated view across every gateway the business uses.
router.get('/analytics/gateway-comparison', requireApiKey, (req, res) => {
  const db = req.app.locals.db;

  const rows = db
    .prepare(
      `SELECT
        merchant_id,
        COUNT(*) AS total,
        SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN decision = 'step_up' THEN 1 ELSE 0 END) AS step_up,
        COALESCE(SUM(amount), 0) AS total_amount,
        COALESCE(AVG(fraud_score), 0) AS avg_fraud_score
      FROM transactions
      WHERE merchant_id IS NOT NULL
      GROUP BY merchant_id
      ORDER BY total DESC`
    )
    .all();

  res.json(
    rows.map((r) => ({
      merchant_id: r.merchant_id,
      total: r.total,
      blocked: r.blocked,
      step_up: r.step_up,
      fraud_rate_percent: r.total > 0 ? Number((((r.blocked + r.step_up) / r.total) * 100).toFixed(2)) : 0,
      total_amount: Number(r.total_amount.toFixed(2)),
      avg_fraud_score: Number(r.avg_fraud_score.toFixed(2)),
    }))
  );
});

const VALID_TREND_BUCKETS = ['hour', 'day', 'week', 'month'];
const TREND_BUCKET_MS = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000, // fixed 30-day bucket, not a true calendar month -- consistent, no calendar-locale edge cases, adequate at this project's scope
};
const DEFAULT_TREND_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TREND_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

// GET /analytics/trend?bucket=hour|day|week|month&lookbackHours=720 — fraud trend over time at a
// configurable granularity, generalizing /audit/summary's fixed hourly-bucket trend chart to the
// hourly/daily/weekly/monthly views Feature 15's dashboard calls for.
router.get('/analytics/trend', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const bucket = VALID_TREND_BUCKETS.includes(req.query.bucket) ? req.query.bucket : 'day';
  const bucketMs = TREND_BUCKET_MS[bucket];
  const lookbackMs = Math.min(
    Math.max((parseInt(req.query.lookbackHours, 10) || 0) * 60 * 60 * 1000, 0) || DEFAULT_TREND_LOOKBACK_MS,
    MAX_TREND_LOOKBACK_MS
  );
  const sinceIso = new Date(Date.now() - lookbackMs).toISOString();

  const rows = db
    .prepare('SELECT timestamp, decision, fraud_score FROM transactions WHERE timestamp >= ? ORDER BY timestamp ASC')
    .all(sinceIso);

  const buckets = new Map();
  for (const row of rows) {
    const tMs = new Date(row.timestamp).getTime();
    const bucketStartMs = Math.floor(tMs / bucketMs) * bucketMs;
    if (!buckets.has(bucketStartMs)) {
      buckets.set(bucketStartMs, { bucket_start: new Date(bucketStartMs).toISOString(), allow: 0, step_up: 0, block: 0, total_score: 0, count: 0 });
    }
    const b = buckets.get(bucketStartMs);
    if (row.decision in b) b[row.decision] += 1;
    b.total_score += row.fraud_score || 0;
    b.count += 1;
  }

  const sortedBuckets = [...buckets.values()]
    .sort((a, b) => new Date(a.bucket_start) - new Date(b.bucket_start))
    .map((b) => ({
      bucket_start: b.bucket_start,
      allow: b.allow,
      step_up: b.step_up,
      block: b.block,
      avg_fraud_score: b.count > 0 ? Number((b.total_score / b.count).toFixed(2)) : 0,
    }));

  res.json({ bucket, buckets: sortedBuckets });
});

const VALID_EXPORT_FORMATS = ['csv', 'json', 'excel'];
const EXPORT_HEADERS = ['transaction_id', 'sender_id', 'receiver_id', 'amount', 'timestamp', 'merchant_id', 'purpose', 'transaction_type', 'fraud_score', 'decision', 'country'];
const MAX_EXPORT_ROWS = 5000;

function toCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// GET /analytics/export?format=csv|json|excel&limit=1000 — bulk export of recent transactions.
// PDF is generated client-side from the JSON form (dashboard/analytics.js's triggerPdfExport),
// same dependency-light reasoning as this project's other client-side-rendered exports; Excel is
// a real server-generated .xlsx file (server/xlsxWriter.js), no exceljs/xlsx dependency.
router.get('/analytics/export', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const format = VALID_EXPORT_FORMATS.includes(req.query.format) ? req.query.format : 'json';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), MAX_EXPORT_ROWS);

  const rows = db
    .prepare(
      'SELECT transaction_id, sender_id, receiver_id, amount, timestamp, merchant_id, purpose, transaction_type, fraud_score, decision, country FROM transactions ORDER BY timestamp DESC LIMIT ?'
    )
    .all(limit);

  if (format === 'csv') {
    const header = 'transaction_id,sender_id,receiver_id,amount,timestamp,merchant_id,purpose,transaction_type,fraud_score,decision,country';
    const lines = rows.map((r) =>
      [r.transaction_id, r.sender_id, r.receiver_id, r.amount, r.timestamp, r.merchant_id, r.purpose, r.transaction_type, r.fraud_score, r.decision, r.country]
        .map(toCsvValue)
        .join(',')
    );
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="sentinelpay-export.csv"').send([header, ...lines].join('\n'));
    return;
  }

  if (format === 'excel') {
    // Section 16, Category 18: a real .xlsx file, built by server/xlsxWriter.js -- no
    // exceljs/xlsx dependency, consistent with this project's dependency-light convention.
    const dataRows = rows.map((r) => EXPORT_HEADERS.map((h) => (typeof r[h] === 'number' ? r[h] : r[h] ?? '')));
    const workbook = buildXlsxWorkbook(EXPORT_HEADERS, dataRows);
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', 'attachment; filename="sentinelpay-export.xlsx"')
      .send(workbook);
    return;
  }

  res.json(rows);
});

module.exports = router;
