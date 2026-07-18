// Partial-Feature Completion Pass: Vendor Intelligence's dedicated trust-score gap and Merchant
// Intelligence's dedicated behavioral-profiling gap. Both categories were previously only covered
// indirectly, through the generic GET /analytics/risk-profile?dimension=vendors|merchants (a
// per-entity health_score, same formula for every dimension). These routes add the
// category-specific shape each one is actually named for: a Vendor *Trust* Score (the positive-
// framing mirror of a risk score, with a tenure bonus a generic risk endpoint has no reason to
// have) and a Merchant behavioral *profile* (transaction activity + login/device/security
// signals merged into one view, not just a transaction-side health number).
//
// "Merchant" here means the business's own registered account (business_accounts / the id space
// merchant_login_events.merchant_id already uses for login/takeover tracking) -- not
// transactions.merchant_id, which identifies the payment *gateway* (Stripe/Razorpay/etc) a
// transaction was ingested from. That naming overlap already exists elsewhere in this codebase
// (outboundContext.js's takeover-risk query keys merchant_login_events off the business account
// id); this file follows the same established convention rather than introducing a new one.
const express = require('express');
const router = express.Router();

const { requireApiKey } = require('../middleware/apiKeyAuth');
const { MAX_ID_LENGTH } = require('../validate');
const { VENDOR_TRUST } = require('../config');
const { computeReputationScore } = require('../reputation');
const { predictSeries } = require('../forecasting');

// GET /vendors/:vendorId/trust-score -- Vendor Trust Score / Vendor Payment Analysis.
router.get('/vendors/:vendorId/trust-score', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const vendorId = req.params.vendorId;
  if (typeof vendorId !== 'string' || vendorId.trim() === '' || vendorId.length > MAX_ID_LENGTH) {
    return res.status(400).json({ error: 'vendorId is required' });
  }

  // "Vendor" = a receiver of non-refund outbound payments (same purpose-based split GET
  // /analytics/top-risky already uses to distinguish vendors from customers, both of which key
  // off receiver_id).
  const totals = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(amount), 0) AS total_amount,
        COALESCE(AVG(amount), 0) AS avg_amount,
        COALESCE(AVG(fraud_score), 0) AS avg_fraud_score,
        MIN(timestamp) AS first_payment,
        MAX(timestamp) AS last_payment
       FROM transactions
       WHERE receiver_id = ? AND (purpose IS NULL OR LOWER(purpose) NOT LIKE '%refund%')`
    )
    .get(vendorId);

  const total = totals.total || 0;
  if (total === 0) {
    return res.json({
      vendor_id: vendorId,
      trust_score: 50,
      trust_tier: 'Unknown',
      reason_breakdown: ['No payment history to this vendor yet -- neutral score, not evidence of trust either way'],
      total_payments: 0,
      total_amount: 0,
      is_new_vendor: true,
    });
  }

  const reasonBreakdown = [];
  // Mirror image of GET /analytics/risk-profile's health_score formula (100 - avg_fraud_score) --
  // deliberately the same base calculation (Explainability requires a traceable formula, not a
  // second, differently-tuned black box), plus a tenure bonus a generic risk endpoint has no
  // reason to add.
  let trustScore = Math.max(0, Math.min(100, 100 - totals.avg_fraud_score));
  reasonBreakdown.push(`Average fraud score across ${total} payment(s) is ${totals.avg_fraud_score.toFixed(1)}`);

  if (total < VENDOR_TRUST.MIN_PAYMENTS_FOR_ESTABLISHED) {
    reasonBreakdown.push(`Fewer than ${VENDOR_TRUST.MIN_PAYMENTS_FOR_ESTABLISHED} payments on record -- trust score not yet fully established`);
  } else {
    const tenureDays = (Date.now() - new Date(totals.first_payment).getTime()) / (24 * 60 * 60 * 1000);
    const tenureBonus = Math.min(VENDOR_TRUST.MAX_TENURE_BONUS, (tenureDays / VENDOR_TRUST.TENURE_BONUS_DAYS) * VENDOR_TRUST.MAX_TENURE_BONUS);
    trustScore = Math.min(100, trustScore + tenureBonus);
    reasonBreakdown.push(`Established vendor relationship, ${Math.round(tenureDays)} day(s) of history (+${tenureBonus.toFixed(1)} tenure bonus)`);
  }

  const reputation = computeReputationScore(db, vendorId, 'user');
  if (reputation.txnCount > 0) {
    // A confirmed-bad reputation (blacklist/mule floor) always caps trust, regardless of how
    // clean this vendor's own payment-side history looks -- same "a confirmed bad actor doesn't
    // get a pass" precedence scoring.js already applies.
    trustScore = Math.min(trustScore, 100 - reputation.score);
  }

  let trustTier = 'Low';
  if (trustScore >= 80) trustTier = 'High';
  else if (trustScore >= 50) trustTier = 'Medium';

  res.json({
    vendor_id: vendorId,
    trust_score: Math.round(trustScore),
    trust_tier: trustTier,
    reason_breakdown: reasonBreakdown,
    total_payments: total,
    total_amount: Number(totals.total_amount.toFixed(2)),
    avg_payment_amount: Number(totals.avg_amount.toFixed(2)),
    first_payment: totals.first_payment,
    last_payment: totals.last_payment,
    is_new_vendor: total < VENDOR_TRUST.MIN_PAYMENTS_FOR_ESTABLISHED,
  });
});

const DEFAULT_TOP_LIMIT = 10;
const MAX_TOP_LIMIT = 100;

// GET /vendors/top-trusted?limit=10 -- Trusted Vendor Detection: the complement of
// /analytics/top-risky?dimension=vendors (that ranks by *risk*; this ranks by trust, and only
// among vendors with enough history to be meaningfully trusted).
router.get('/vendors/top-trusted', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_TOP_LIMIT, 1), MAX_TOP_LIMIT);

  const rows = db
    .prepare(
      `SELECT receiver_id, COUNT(*) AS total, COALESCE(AVG(fraud_score), 0) AS avg_fraud_score, COALESCE(SUM(amount), 0) AS total_amount
       FROM transactions
       WHERE (purpose IS NULL OR LOWER(purpose) NOT LIKE '%refund%')
       GROUP BY receiver_id
       HAVING total >= ?
       ORDER BY avg_fraud_score ASC
       LIMIT ?`
    )
    .all(VENDOR_TRUST.MIN_PAYMENTS_FOR_ESTABLISHED, limit);

  res.json(
    rows.map((r) => ({
      vendor_id: r.receiver_id,
      total_payments: r.total,
      trust_score: Math.round(Math.max(0, Math.min(100, 100 - r.avg_fraud_score))),
      total_amount: Number(r.total_amount.toFixed(2)),
    }))
  );
});

// GET /merchants/:merchantId/profile -- Merchant Behavioral Profiling / Merchant Security
// Analytics: transaction-side health plus login/device-diversity/security signals merged into
// one dedicated view, closing the "only covered indirectly via the generic risk-profile
// dimension" gap.
router.get('/merchants/:merchantId/profile', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const merchantId = req.params.merchantId;
  if (typeof merchantId !== 'string' || merchantId.trim() === '' || merchantId.length > MAX_ID_LENGTH) {
    return res.status(400).json({ error: 'merchantId is required' });
  }

  const txTotals = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN decision = 'step_up' THEN 1 ELSE 0 END) AS step_up,
        COALESCE(SUM(amount), 0) AS total_amount,
        COALESCE(AVG(fraud_score), 0) AS avg_fraud_score
       FROM transactions WHERE sender_id = ?`
    )
    .get(merchantId);

  const loginTotals = db
    .prepare(
      `SELECT
        COUNT(*) AS total_logins,
        COUNT(DISTINCT device_id) AS distinct_devices,
        COUNT(DISTINCT country) AS distinct_countries,
        MAX(timestamp) AS last_login
       FROM merchant_login_events WHERE merchant_id = ?`
    )
    .get(merchantId);

  const takeoverFlagCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM flags f JOIN transactions t ON t.transaction_id = f.transaction_id
       WHERE t.sender_id = ? AND f.flag_type = 'merchant_account_takeover'`
    )
    .get(merchantId).n;

  const total = txTotals.total || 0;
  // Security score: starts from the same 100-minus-avg-fraud-score baseline as health_score
  // elsewhere, then subtracts for account-security-specific signals a generic transaction-only
  // health score never sees -- a confirmed takeover attempt, or logins from an unusually wide
  // spread of devices/countries in a short history (both real, if imperfect, account-hygiene
  // signals, same heuristic caution level as this project's other self-reported-field detectors).
  let securityScore = total > 0 ? Math.max(0, Math.min(100, 100 - txTotals.avg_fraud_score)) : 100;
  const securityNotes = [];
  if (takeoverFlagCount > 0) {
    securityScore = Math.min(securityScore, 30);
    securityNotes.push(`${takeoverFlagCount} merchant account takeover flag(s) on record`);
  }
  if (loginTotals.distinct_devices > 5) {
    securityScore = Math.max(0, securityScore - 10);
    securityNotes.push(`Logins from ${loginTotals.distinct_devices} distinct devices`);
  }
  if (securityNotes.length === 0) {
    securityNotes.push('No takeover flags or unusual login/device diversity on record');
  }

  res.json({
    merchant_id: merchantId,
    total_transactions: total,
    blocked: txTotals.blocked || 0,
    step_up: txTotals.step_up || 0,
    total_amount: Number((txTotals.total_amount || 0).toFixed(2)),
    health_score: total > 0 ? Math.round(Math.max(0, Math.min(100, 100 - txTotals.avg_fraud_score))) : 100,
    security_score: Math.round(securityScore),
    security_notes: securityNotes,
    login_activity: {
      total_logins: loginTotals.total_logins || 0,
      distinct_devices: loginTotals.distinct_devices || 0,
      distinct_countries: loginTotals.distinct_countries || 0,
      last_login: loginTotals.last_login || null,
    },
  });
});

const MERCHANT_FORECAST_HORIZON = 5;

// GET /merchants/:merchantId/risk-forecast -- Predictive Merchant Risk: projects this merchant's
// own fraud_score trend forward a few transactions, via the same linear-regression forecaster
// GET /analytics/forecast uses (server/forecasting.js), applied to one merchant's own recent
// transaction-level score series rather than a bucketed aggregate.
router.get('/merchants/:merchantId/risk-forecast', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const merchantId = req.params.merchantId;
  if (typeof merchantId !== 'string' || merchantId.trim() === '' || merchantId.length > MAX_ID_LENGTH) {
    return res.status(400).json({ error: 'merchantId is required' });
  }

  const rows = db
    .prepare('SELECT fraud_score, timestamp FROM transactions WHERE sender_id = ? ORDER BY timestamp ASC LIMIT 200')
    .all(merchantId);

  const series = rows.map((r) => r.fraud_score || 0);
  const result = predictSeries(series, MERCHANT_FORECAST_HORIZON);

  res.json({
    merchant_id: merchantId,
    history_points: series.length,
    recent_scores: series.slice(-20),
    forecast: result.forecast,
    trend: result.trend,
  });
});

module.exports = router;
