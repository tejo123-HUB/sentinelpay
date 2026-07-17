// Section 16, Category 14: real, working case management -- the subset of the Fraud
// Investigation Module that doesn't need a full analyst-identity/login system this build has
// deliberately never had. `assigned_to` is caller-supplied free text, the same trust model as
// `transactions.employee_id`/`investigation_notes.author` -- not a verified identity, but a real,
// persisted, queryable field, not theater.
const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();

const { requireApiKey, requireRole } = require('../middleware/apiKeyAuth');
const { MAX_ID_LENGTH } = require('../validate');

const VALID_STATUSES = ['open', 'investigating', 'resolved', 'escalated'];
const MAX_TITLE_LENGTH = 256;
const MAX_ASSIGNED_TO_LENGTH = 128;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function serializeCase(row) {
  return {
    case_id: row.case_id,
    title: row.title,
    status: row.status,
    assigned_to: row.assigned_to,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// POST /cases { title, transaction_ids: [...], assigned_to? } -- creates a case, optionally
// linking it to one or more transactions up front (case creation almost always starts from
// "these transactions look related," not from an empty shell).
router.post('/cases', requireApiKey, requireRole('analyst'), (req, res) => {
  const db = req.app.locals.db;
  const { title, transaction_ids, assigned_to } = req.body || {};

  if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_TITLE_LENGTH) {
    return res.status(400).json({ error: `title is required and must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters` });
  }
  if (assigned_to !== undefined && assigned_to !== null && (typeof assigned_to !== 'string' || assigned_to.length > MAX_ASSIGNED_TO_LENGTH)) {
    return res.status(400).json({ error: `assigned_to must be at most ${MAX_ASSIGNED_TO_LENGTH} characters` });
  }
  const ids = Array.isArray(transaction_ids) ? transaction_ids : [];
  if (ids.some((id) => typeof id !== 'string' || id.length > MAX_ID_LENGTH)) {
    return res.status(400).json({ error: 'transaction_ids, if provided, must be an array of transaction_id strings' });
  }

  const caseId = `case_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();

  db.prepare('INSERT INTO cases (case_id, title, status, assigned_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    caseId,
    title,
    'open',
    typeof assigned_to === 'string' ? assigned_to : null,
    nowIso,
    nowIso
  );

  const linkStmt = db.prepare('INSERT OR IGNORE INTO case_transactions (case_id, transaction_id, added_at) VALUES (?, ?, ?)');
  for (const transactionId of ids) {
    linkStmt.run(caseId, transactionId, nowIso);
  }

  res.status(201).json({ case_id: caseId, title, status: 'open', assigned_to: typeof assigned_to === 'string' ? assigned_to : null, created_at: nowIso, updated_at: nowIso, transaction_ids: ids });
});

// GET /cases?status=&assigned_to=&limit=50
router.get('/cases', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const { status, assigned_to } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (typeof assigned_to === 'string' && assigned_to.trim() !== '') {
    clauses.push('assigned_to = ?');
    params.push(assigned_to);
  }
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = db.prepare(`SELECT * FROM cases ${whereClause} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit);
  res.json(rows.map(serializeCase));
});

// GET /cases/:caseId — case detail including linked transaction IDs.
router.get('/cases/:caseId', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const row = db.prepare('SELECT * FROM cases WHERE case_id = ?').get(req.params.caseId);
  if (!row) {
    return res.status(404).json({ error: `No case found with case_id ${req.params.caseId}` });
  }

  const linkedTransactionIds = db
    .prepare('SELECT transaction_id FROM case_transactions WHERE case_id = ? ORDER BY added_at ASC')
    .all(req.params.caseId)
    .map((r) => r.transaction_id);

  res.json({ ...serializeCase(row), transaction_ids: linkedTransactionIds });
});

// PATCH /cases/:caseId { status?, assigned_to?, title? } — analyst+ (investigating/updating
// cases is exactly an analyst's job; unlike business_accounts/fraud_lists, this has no
// system-wide scoring effect, so it doesn't need admin).
router.patch('/cases/:caseId', requireApiKey, requireRole('analyst'), (req, res) => {
  const db = req.app.locals.db;
  const existing = db.prepare('SELECT * FROM cases WHERE case_id = ?').get(req.params.caseId);
  if (!existing) {
    return res.status(404).json({ error: `No case found with case_id ${req.params.caseId}` });
  }

  const { status, assigned_to, title } = req.body || {};
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '' || title.length > MAX_TITLE_LENGTH)) {
    return res.status(400).json({ error: `title must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters` });
  }
  if (assigned_to !== undefined && assigned_to !== null && (typeof assigned_to !== 'string' || assigned_to.length > MAX_ASSIGNED_TO_LENGTH)) {
    return res.status(400).json({ error: `assigned_to must be at most ${MAX_ASSIGNED_TO_LENGTH} characters` });
  }

  const nextStatus = status !== undefined ? status : existing.status;
  const nextAssignedTo = assigned_to !== undefined ? assigned_to : existing.assigned_to;
  const nextTitle = title !== undefined ? title : existing.title;
  const nowIso = new Date().toISOString();

  db.prepare('UPDATE cases SET status = ?, assigned_to = ?, title = ?, updated_at = ? WHERE case_id = ?').run(
    nextStatus,
    nextAssignedTo,
    nextTitle,
    nowIso,
    req.params.caseId
  );

  res.json({ case_id: req.params.caseId, title: nextTitle, status: nextStatus, assigned_to: nextAssignedTo, updated_at: nowIso });
});

// POST /cases/:caseId/transactions { transaction_id } — link an additional transaction.
router.post('/cases/:caseId/transactions', requireApiKey, requireRole('analyst'), (req, res) => {
  const db = req.app.locals.db;
  const existing = db.prepare('SELECT 1 FROM cases WHERE case_id = ?').get(req.params.caseId);
  if (!existing) {
    return res.status(404).json({ error: `No case found with case_id ${req.params.caseId}` });
  }

  const { transaction_id } = req.body || {};
  if (typeof transaction_id !== 'string' || transaction_id.trim() === '') {
    return res.status(400).json({ error: 'transaction_id is required' });
  }
  const txExists = db.prepare('SELECT 1 FROM transactions WHERE transaction_id = ?').get(transaction_id);
  if (!txExists) {
    return res.status(404).json({ error: `No transaction found with transaction_id ${transaction_id}` });
  }

  db.prepare('INSERT OR IGNORE INTO case_transactions (case_id, transaction_id, added_at) VALUES (?, ?, ?)').run(
    req.params.caseId,
    transaction_id,
    new Date().toISOString()
  );
  db.prepare('UPDATE cases SET updated_at = ? WHERE case_id = ?').run(new Date().toISOString(), req.params.caseId);

  res.status(201).json({ case_id: req.params.caseId, transaction_id });
});

// GET /cases/:caseId/timeline — "Investigation Timeline"/"Fraud Replay": every linked
// transaction (with its decision/reasons), every structuring alert touching an account involved
// in this case, and every investigation note across those transactions, merged and sorted
// chronologically -- a real, working replay of everything relevant to the case in time order.
router.get('/cases/:caseId/timeline', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const existing = db.prepare('SELECT 1 FROM cases WHERE case_id = ?').get(req.params.caseId);
  if (!existing) {
    return res.status(404).json({ error: `No case found with case_id ${req.params.caseId}` });
  }

  const transactionIds = db
    .prepare('SELECT transaction_id FROM case_transactions WHERE case_id = ?')
    .all(req.params.caseId)
    .map((r) => r.transaction_id);

  if (transactionIds.length === 0) {
    return res.json({ case_id: req.params.caseId, events: [] });
  }

  const placeholders = transactionIds.map(() => '?').join(',');
  const events = [];

  const txRows = db.prepare(`SELECT * FROM transactions WHERE transaction_id IN (${placeholders})`).all(...transactionIds);
  const accountIds = new Set();
  for (const row of txRows) {
    accountIds.add(row.sender_id);
    accountIds.add(row.receiver_id);
    events.push({
      type: 'transaction',
      timestamp: row.timestamp,
      transaction_id: row.transaction_id,
      summary: `${row.sender_id} -> ${row.receiver_id}: ${row.amount} (${row.decision}, score ${row.fraud_score})`,
    });
  }

  const noteRows = db.prepare(`SELECT * FROM investigation_notes WHERE transaction_id IN (${placeholders})`).all(...transactionIds);
  for (const row of noteRows) {
    events.push({
      type: 'investigation_note',
      timestamp: row.created_at,
      transaction_id: row.transaction_id,
      summary: `${row.author || 'unknown'}: ${row.note}`,
    });
  }

  if (accountIds.size > 0) {
    const accountPlaceholders = [...accountIds].map(() => '?').join(',');
    const alertRows = db
      .prepare(`SELECT * FROM structuring_alerts WHERE sender_id IN (${accountPlaceholders})`)
      .all(...accountIds);
    for (const row of alertRows) {
      events.push({
        type: 'structuring_alert',
        timestamp: row.created_at,
        alert_id: row.alert_id,
        summary: row.reason,
      });
    }
  }

  events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  res.json({ case_id: req.params.caseId, events });
});

module.exports = router;
