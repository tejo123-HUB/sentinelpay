const express = require('express');
const router = express.Router();

const { MAX_ID_LENGTH } = require('../validate');
// requireApiKey is applied per-route below, not via router.use(), for the same reason
// transactions.js scopes it per-route: a blanket router.use(requireApiKey) here would run for
// every request reaching this router, including the dashboard's own static assets, which can't
// attach an X-API-Key header the way authFetch()'s fetch() calls can.
const { requireApiKey } = require('../middleware/apiKeyAuth');

// GET /business-accounts — the dashboard's editable registry of the business's own account IDs,
// used client-side to decide which side of a transaction (sender or receiver) is the business
// vs. the customer, so the live/audit tables can show one "ID" column instead of both.
router.get('/business-accounts', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const rows = db.prepare('SELECT account_id, created_at FROM business_accounts ORDER BY created_at ASC').all();
  res.json(rows);
});

// POST /business-accounts { account_id } — registers an account as belonging to the business.
// INSERT OR IGNORE: re-adding an already-registered ID is a no-op, not an error.
router.post('/business-accounts', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const { account_id } = req.body || {};
  if (typeof account_id !== 'string' || account_id.trim() === '' || account_id.length > MAX_ID_LENGTH) {
    return res.status(400).json({
      error: `account_id is required and must be a non-empty string of at most ${MAX_ID_LENGTH} characters`,
    });
  }

  db.prepare('INSERT OR IGNORE INTO business_accounts (account_id, created_at) VALUES (?, ?)').run(
    account_id,
    new Date().toISOString()
  );

  res.status(201).json({ account_id });
});

// DELETE /business-accounts/:accountId — un-registers an account. Idempotent: removing an ID
// that isn't registered still returns 204, not a 404.
router.delete('/business-accounts/:accountId', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  db.prepare('DELETE FROM business_accounts WHERE account_id = ?').run(req.params.accountId);
  res.status(204).end();
});

module.exports = router;
