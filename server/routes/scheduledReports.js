// Section 16, Category 18: read access to generated report snapshots, plus a manual trigger for
// demo/testing without waiting for the real schedule to close a period.
const express = require('express');
const router = express.Router();

const { requireApiKey, requireRole } = require('../middleware/apiKeyAuth');
const { generateReport } = require('../scheduledReports');

const VALID_REPORT_TYPES = ['daily', 'weekly', 'monthly'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

router.get('/scheduled-reports', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const { type } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  if (type !== undefined && !VALID_REPORT_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_REPORT_TYPES.join(', ')}` });
  }

  const rows = type
    ? db.prepare('SELECT * FROM scheduled_reports WHERE report_type = ? ORDER BY period_end DESC LIMIT ?').all(type, limit)
    : db.prepare('SELECT * FROM scheduled_reports ORDER BY period_end DESC LIMIT ?').all(limit);

  res.json(rows.map((r) => ({ ...r, emailed: !!r.emailed, summary: JSON.parse(r.summary_json) })));
});

// POST /scheduled-reports/generate { type } — admin-only: generates (and attempts to email) a
// report for the period ending now, on demand. Real generation, not a mock -- idempotent for the
// same period, same as the background job's own periodic tick.
router.post('/scheduled-reports/generate', requireApiKey, requireRole('admin'), async (req, res) => {
  const db = req.app.locals.db;
  const { type } = req.body || {};

  if (!VALID_REPORT_TYPES.includes(type)) {
    return res.status(400).json({ error: `type is required and must be one of: ${VALID_REPORT_TYPES.join(', ')}` });
  }

  const report = await generateReport(db, type, Date.now());
  if (!report) {
    return res.status(409).json({ error: `A ${type} report for the current period already exists` });
  }

  res.status(201).json(report);
});

module.exports = router;
