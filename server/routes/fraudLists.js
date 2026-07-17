// Section 16, Categories 19/21: CRUD routes for the blacklist/whitelist/watchlist registry.
// Same shape as server/routes/businessAccounts.js -- requireApiKey per-route, not a blanket
// router.use(), for the same reason (a blanket gate would 401 the dashboard's own static assets).
const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();

const { requireApiKey } = require('../middleware/apiKeyAuth');
const { MAX_ID_LENGTH } = require('../validate');

const VALID_LIST_TYPES = ['blacklist', 'whitelist', 'watchlist'];
const MAX_REASON_LENGTH = 256;

// GET /fraud-lists?list_type=blacklist — all entries, optionally filtered by type.
router.get('/fraud-lists', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const listType = req.query.list_type;

  if (listType !== undefined && !VALID_LIST_TYPES.includes(listType)) {
    return res.status(400).json({ error: `list_type must be one of: ${VALID_LIST_TYPES.join(', ')}` });
  }

  const rows = listType
    ? db.prepare('SELECT * FROM fraud_lists WHERE list_type = ? ORDER BY created_at DESC').all(listType)
    : db.prepare('SELECT * FROM fraud_lists ORDER BY created_at DESC').all();

  res.json(rows);
});

// POST /fraud-lists { list_type, account_id, reason } — adds an entry. Not INSERT OR IGNORE
// (unlike business_accounts): an account can validly appear on the same list more than once
// over time with different reasons (e.g. re-blacklisted after a second incident), and entry_id
// is the primary key, not (list_type, account_id).
router.post('/fraud-lists', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const { list_type, account_id, reason } = req.body || {};

  if (!VALID_LIST_TYPES.includes(list_type)) {
    return res.status(400).json({ error: `list_type is required and must be one of: ${VALID_LIST_TYPES.join(', ')}` });
  }
  if (typeof account_id !== 'string' || account_id.trim() === '' || account_id.length > MAX_ID_LENGTH) {
    return res.status(400).json({ error: `account_id is required and must be a non-empty string of at most ${MAX_ID_LENGTH} characters` });
  }
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH)) {
    return res.status(400).json({ error: `reason must be at most ${MAX_REASON_LENGTH} characters` });
  }

  const entryId = `fl_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();

  db.prepare('INSERT INTO fraud_lists (entry_id, list_type, account_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    entryId,
    list_type,
    account_id,
    typeof reason === 'string' ? reason : null,
    nowIso
  );

  res.status(201).json({ entry_id: entryId, list_type, account_id, reason: typeof reason === 'string' ? reason : null, created_at: nowIso });
});

// DELETE /fraud-lists/:entryId — idempotent, like business_accounts' DELETE.
router.delete('/fraud-lists/:entryId', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  db.prepare('DELETE FROM fraud_lists WHERE entry_id = ?').run(req.params.entryId);
  res.status(204).end();
});

module.exports = router;
