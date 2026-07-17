// Section 16, Category 20/21: read-only view of the admin_audit_log table (server/adminAuditLog.js
// writes to it from businessAccounts.js/fraudLists.js's mutation routes).
const express = require('express');
const router = express.Router();

const { requireApiKey } = require('../middleware/apiKeyAuth');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

// GET /admin-audit-log?limit=100
router.get('/admin-audit-log', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const rows = db.prepare('SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT ?').all(limit);

  res.json(rows);
});

module.exports = router;
