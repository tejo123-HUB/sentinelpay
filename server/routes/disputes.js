// Section 15.16, Feature 8: ingests chargeback/dispute events. No existing table captures this --
// it's genuinely new data (a signal that would normally arrive from a payment gateway's
// chargeback webhook in production). Same trust model as the other ingestion routes.
const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();

const { requireApiKey, requireRole } = require('../middleware/apiKeyAuth');
const { MAX_ID_LENGTH } = require('../validate');

const MAX_DISPUTE_TYPE_LENGTH = 64;

router.post('/disputes', requireApiKey, requireRole('analyst'), (req, res) => {
  const db = req.app.locals.db;
  const { transaction_id, customer_id, dispute_type } = req.body || {};

  if (typeof customer_id !== 'string' || customer_id.trim() === '' || customer_id.length > MAX_ID_LENGTH) {
    return res.status(400).json({ error: `customer_id is required and must be a non-empty string of at most ${MAX_ID_LENGTH} characters` });
  }
  if (typeof dispute_type !== 'string' || dispute_type.trim() === '' || dispute_type.length > MAX_DISPUTE_TYPE_LENGTH) {
    return res.status(400).json({ error: `dispute_type is required and must be a non-empty string of at most ${MAX_DISPUTE_TYPE_LENGTH} characters` });
  }
  if (transaction_id !== undefined && transaction_id !== null && (typeof transaction_id !== 'string' || transaction_id.length > MAX_ID_LENGTH)) {
    return res.status(400).json({ error: `transaction_id must be at most ${MAX_ID_LENGTH} characters` });
  }

  const disputeId = `dsp_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();

  db.prepare(
    'INSERT INTO disputes (dispute_id, transaction_id, customer_id, dispute_type, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(disputeId, typeof transaction_id === 'string' ? transaction_id : null, customer_id, dispute_type, nowIso);

  res.status(201).json({ dispute_id: disputeId, customer_id, dispute_type, created_at: nowIso });
});

// GET /disputes?customer_id=...&limit=50
router.get('/disputes', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const customerId = typeof req.query.customer_id === 'string' ? req.query.customer_id : null;

  const rows = customerId
    ? db.prepare('SELECT * FROM disputes WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?').all(customerId, limit)
    : db.prepare('SELECT * FROM disputes ORDER BY created_at DESC LIMIT ?').all(limit);

  res.json(rows);
});

module.exports = router;
