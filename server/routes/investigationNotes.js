// Section 16, Category 13/14: free-text notes an analyst can attach to a transaction while
// investigating it -- the safe, tractable subset of "Investigation Notes"/"Investigation
// Timeline" that doesn't require the full Fraud Investigation Module (case assignment, analyst
// identity, workflow state), which this build has deliberately declined -- see architecture.md
// Section 16, Category 14 for why. No DELETE route: notes are append-only, since an
// investigation record that could be silently erased isn't a trustworthy one.
const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();

const { requireApiKey, requireRole } = require('../middleware/apiKeyAuth');
const { MAX_ID_LENGTH } = require('../validate');

const MAX_NOTE_LENGTH = 2000;
const MAX_AUTHOR_LENGTH = 128;

// POST /investigation-notes { transaction_id, note, author? }
router.post('/investigation-notes', requireApiKey, requireRole('analyst'), (req, res) => {
  const db = req.app.locals.db;
  const { transaction_id, note, author } = req.body || {};

  if (typeof transaction_id !== 'string' || transaction_id.trim() === '' || transaction_id.length > MAX_ID_LENGTH) {
    return res.status(400).json({ error: `transaction_id is required and must be a non-empty string of at most ${MAX_ID_LENGTH} characters` });
  }
  if (typeof note !== 'string' || note.trim() === '' || note.length > MAX_NOTE_LENGTH) {
    return res.status(400).json({ error: `note is required and must be a non-empty string of at most ${MAX_NOTE_LENGTH} characters` });
  }
  if (author !== undefined && author !== null && (typeof author !== 'string' || author.length > MAX_AUTHOR_LENGTH)) {
    return res.status(400).json({ error: `author must be at most ${MAX_AUTHOR_LENGTH} characters` });
  }

  const existing = db.prepare('SELECT 1 FROM transactions WHERE transaction_id = ?').get(transaction_id);
  if (!existing) {
    return res.status(404).json({ error: `No transaction found with transaction_id ${transaction_id}` });
  }

  const noteId = `note_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();

  db.prepare('INSERT INTO investigation_notes (note_id, transaction_id, note, author, created_at) VALUES (?, ?, ?, ?, ?)').run(
    noteId,
    transaction_id,
    note,
    typeof author === 'string' ? author : null,
    nowIso
  );

  res.status(201).json({ note_id: noteId, transaction_id, note, author: typeof author === 'string' ? author : null, created_at: nowIso });
});

// GET /investigation-notes?transaction_id=... — the investigation timeline for one transaction,
// oldest first (a timeline reads naturally in chronological order).
router.get('/investigation-notes', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const transactionId = req.query.transaction_id;

  if (typeof transactionId !== 'string' || transactionId.trim() === '') {
    return res.status(400).json({ error: 'transaction_id query parameter is required' });
  }

  const rows = db
    .prepare('SELECT * FROM investigation_notes WHERE transaction_id = ? ORDER BY created_at ASC')
    .all(transactionId);

  res.json(rows);
});

module.exports = router;
