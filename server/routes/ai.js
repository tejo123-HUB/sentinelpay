// Partial-Feature Completion Pass: Section 26 "Future AI Features" endpoints. See
// server/aiAssistant.js's header comment for the PROD (Claude API)/DEMO (deterministic,
// no-API-key-required) split every function here rests on.
const express = require('express');
const router = express.Router();

const { requireApiKey } = require('../middleware/apiKeyAuth');
const { MAX_ID_LENGTH } = require('../validate');
const {
  parseNaturalLanguageQuery,
  executeNaturalLanguageSearch,
  generateFraudInsights,
  generateReportNarrative,
  answerChatMessage,
} = require('../aiAssistant');

const MAX_QUERY_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 1000;

// POST /ai/search { query } -- Natural Language Fraud Search.
router.post('/ai/search', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const { query } = req.body || {};
  if (typeof query !== 'string' || query.trim() === '' || query.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({ error: `query is required and must be at most ${MAX_QUERY_LENGTH} characters` });
  }

  const parsed = parseNaturalLanguageQuery(query);
  const results = executeNaturalLanguageSearch(db, parsed);
  res.json({
    query,
    understood: parsed.understood,
    result_count: results.length,
    results,
  });
});

// POST /ai/chat { message, case_id? } -- AI Chat Assistant / AI Fraud Investigation Assistant
// (the same endpoint, scoped to a case's own context when case_id is supplied -- one generic
// mechanism rather than two near-identical endpoints, this project's established convention e.g.
// GET /analytics/top-risky's single dimension-parameterized route).
router.post('/ai/chat', requireApiKey, async (req, res) => {
  const db = req.app.locals.db;
  const { message, case_id } = req.body || {};
  if (typeof message !== 'string' || message.trim() === '' || message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `message is required and must be at most ${MAX_MESSAGE_LENGTH} characters` });
  }

  let caseContext = null;
  if (case_id !== undefined && case_id !== null) {
    if (typeof case_id !== 'string' || case_id.length > MAX_ID_LENGTH) {
      return res.status(400).json({ error: 'case_id must be a string' });
    }
    const caseRow = db.prepare('SELECT * FROM cases WHERE case_id = ?').get(case_id);
    if (!caseRow) {
      return res.status(404).json({ error: `No case found with case_id ${case_id}` });
    }
    const linkedCount = db.prepare('SELECT COUNT(*) AS n FROM case_transactions WHERE case_id = ?').get(case_id).n;
    const noteRows = db
      .prepare('SELECT note, author FROM investigation_notes n JOIN case_transactions ct ON ct.transaction_id = n.transaction_id WHERE ct.case_id = ? ORDER BY n.created_at DESC LIMIT 5')
      .all(case_id);
    caseContext =
      `Case "${caseRow.title}" (status: ${caseRow.status}, assigned to: ${caseRow.assigned_to || 'unassigned'}, outcome: ${caseRow.outcome || 'pending'}), ` +
      `linked to ${linkedCount} transaction(s).` +
      (noteRows.length > 0 ? ` Recent analyst notes: ${noteRows.map((n) => `"${n.note}" (${n.author || 'unknown'})`).join('; ')}.` : '');
  }

  const { reply, source } = await answerChatMessage(db, message, caseContext);
  res.json({ reply, source });
});

const DEFAULT_INSIGHTS_WINDOW_HOURS = 24;
const MAX_INSIGHTS_WINDOW_HOURS = 24 * 90;

// GET /ai/insights?windowHours=24 -- AI Fraud Insights.
router.get('/ai/insights', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const windowHours = Math.min(Math.max(parseInt(req.query.windowHours, 10) || DEFAULT_INSIGHTS_WINDOW_HOURS, 1), MAX_INSIGHTS_WINDOW_HOURS);
  const insights = generateFraudInsights(db, windowHours * 60 * 60 * 1000);
  res.json({ window_hours: windowHours, insights });
});

const VALID_REPORT_PERIODS = { daily: 24, weekly: 24 * 7, monthly: 24 * 30 };

// GET /ai/report?period=daily|weekly|monthly -- AI Fraud Report Generator.
router.get('/ai/report', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const period = VALID_REPORT_PERIODS[req.query.period] ? req.query.period : 'daily';
  const windowMs = VALID_REPORT_PERIODS[period] * 60 * 60 * 1000;
  const sinceIso = new Date(Date.now() - windowMs).toISOString();

  const totals = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END) AS allowed,
        SUM(CASE WHEN decision = 'step_up' THEN 1 ELSE 0 END) AS step_up,
        SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS blocked,
        COALESCE(SUM(CASE WHEN decision = 'block' THEN amount ELSE 0 END), 0) AS blocked_amount,
        COALESCE(SUM(CASE WHEN decision != 'block' AND fraud_score >= 40 THEN amount ELSE 0 END), 0) AS recovered_amount
       FROM transactions WHERE timestamp >= ?`
    )
    .get(sinceIso);
  const total = totals.total || 0;
  const flagged = (totals.step_up || 0) + (totals.blocked || 0);
  const summary = {
    total_processed: total,
    allowed: totals.allowed || 0,
    step_up: totals.step_up || 0,
    blocked: totals.blocked || 0,
    fraud_percent: total > 0 ? Number(((flagged / total) * 100).toFixed(2)) : 0,
    blocked_amount: Number(totals.blocked_amount.toFixed(2)),
    recovered_amount: Number(totals.recovered_amount.toFixed(2)),
  };

  const topFrauds = db
    .prepare(
      `SELECT f.flag_type, COUNT(*) AS count FROM flags f JOIN transactions t ON t.transaction_id = f.transaction_id
       WHERE t.timestamp >= ? GROUP BY f.flag_type ORDER BY count DESC LIMIT 5`
    )
    .all(sinceIso);

  const insights = generateFraudInsights(db, windowMs);
  const narrative = generateReportNarrative(summary, insights, topFrauds);

  res.json({ period, since: sinceIso, summary, top_frauds: topFrauds, insights, narrative });
});

module.exports = router;
