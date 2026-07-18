// Section 16, Category 18: real scheduled report generation, on the same periodic-tick pattern
// as the structuring background job (server/structuring/backgroundJob.js). Delivery is a real
// side effect of generation via the notification engine's email channel (Category 17) when
// configured -- not a separate, unimplemented step.
const crypto = require('node:crypto');
const { sendEmailNotification } = require('./notifications');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PERIOD_MS = {
  daily: MS_PER_DAY,
  weekly: 7 * MS_PER_DAY,
  monthly: 30 * MS_PER_DAY, // fixed 30-day period, not a calendar month -- same reasoning as analytics.js's TREND_BUCKET_MS.monthly
};

const DEFAULT_INTERVAL_MS = Number(process.env.SCHEDULED_REPORTS_INTERVAL_MS) || 60 * 60 * 1000; // hourly tick by default -- cheap to check, and daily/weekly/monthly periods only actually close much less often than that

/**
 * Aggregates the same summary shape as GET /analytics/summary, scoped to one time window.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} periodStartIso
 * @param {string} periodEndIso
 */
function computeSummaryForPeriod(db, periodStartIso, periodEndIso) {
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
      FROM transactions WHERE timestamp >= ? AND timestamp < ?`
    )
    .get(periodStartIso, periodEndIso);

  const total = totals.total || 0;
  const flagged = (totals.step_up || 0) + (totals.blocked || 0);

  return {
    period_start: periodStartIso,
    period_end: periodEndIso,
    total_processed: total,
    allowed: totals.allowed || 0,
    step_up: totals.step_up || 0,
    blocked: totals.blocked || 0,
    fraud_percent: total > 0 ? Number(((flagged / total) * 100).toFixed(2)) : 0,
    blocked_amount: Number(totals.blocked_amount.toFixed(2)),
    recovered_amount: Number(totals.recovered_amount.toFixed(2)),
    avg_fraud_score: Number(totals.avg_fraud_score.toFixed(2)),
    avg_latency_ms: Number(totals.avg_latency_ms.toFixed(2)),
  };
}

function formatSummaryAsText(reportType, summary) {
  return [
    `SentinelPay ${reportType} report: ${summary.period_start} to ${summary.period_end}`,
    `Total processed: ${summary.total_processed}`,
    `Allowed: ${summary.allowed} | Step-up: ${summary.step_up} | Blocked: ${summary.blocked}`,
    `Fraud rate: ${summary.fraud_percent}%`,
    `Blocked amount: ${summary.blocked_amount} | Recovered amount: ${summary.recovered_amount}`,
    `Average fraud score: ${summary.avg_fraud_score} | Average latency: ${summary.avg_latency_ms}ms`,
  ].join('\n');
}

/**
 * Generates (and persists, and attempts to email) one report for the period ending at `nowMs`,
 * unless a report for that exact period already exists (idempotent -- a re-run within the same
 * period, e.g. after a restart, doesn't produce a duplicate).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {'daily'|'weekly'|'monthly'} reportType
 * @param {number} nowMs
 * @returns {object|null} the created report row, or null if one already existed for this period
 */
async function generateReport(db, reportType, nowMs) {
  const periodMs = PERIOD_MS[reportType];
  // Idempotency depends on period_end being identical across calls within the same period --
  // Date.now() at raw millisecond precision would make every call's period_end unique, so two
  // requests moments apart would never be recognized as "the same period" and the duplicate
  // check below would never actually trigger. Aligning to a period-sized boundary (the same
  // Math.floor(t / bucketMs) * bucketMs pattern analytics.js's trend bucketing already uses)
  // makes every call within one period compute the exact same boundary.
  const periodEndMs = Math.floor(nowMs / periodMs) * periodMs;
  const periodEndIso = new Date(periodEndMs).toISOString();
  const periodStartIso = new Date(periodEndMs - periodMs).toISOString();

  const existing = db
    .prepare('SELECT 1 FROM scheduled_reports WHERE report_type = ? AND period_end = ?')
    .get(reportType, periodEndIso);
  if (existing) return null;

  const summary = computeSummaryForPeriod(db, periodStartIso, periodEndIso);
  const reportId = `report_${crypto.randomUUID()}`;
  const createdAtIso = new Date().toISOString();

  let emailed = false;
  try {
    const result = await sendEmailNotification(`SentinelPay ${reportType} report`, formatSummaryAsText(reportType, summary));
    emailed = !!result.sent;
  } catch {
    emailed = false;
  }

  db.prepare(
    'INSERT INTO scheduled_reports (report_id, report_type, period_start, period_end, summary_json, emailed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(reportId, reportType, periodStartIso, periodEndIso, JSON.stringify(summary), emailed ? 1 : 0, createdAtIso);

  return { report_id: reportId, report_type: reportType, period_start: periodStartIso, period_end: periodEndIso, summary, emailed, created_at: createdAtIso };
}

function startScheduledReportsJob(db, intervalMs = DEFAULT_INTERVAL_MS) {
  if (!db) return { stop() {} };

  const timer = setInterval(() => {
    Promise.all([
      generateReport(db, 'daily', Date.now()),
      generateReport(db, 'weekly', Date.now()),
      generateReport(db, 'monthly', Date.now()),
    ]).catch((err) => {
      console.error('Scheduled reports job failed:', err);
    });
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { computeSummaryForPeriod, generateReport, startScheduledReportsJob, PERIOD_MS };
