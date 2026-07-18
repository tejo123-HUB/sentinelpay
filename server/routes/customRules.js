// Section 16, Category 19: CRUD for the no-code rule engine. admin-only for mutations -- a bad
// custom rule affects scoring for every future outbound transaction, the same system-wide-effect
// reasoning as business_accounts/fraud_lists.
const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();

const { requireApiKey, requireRole } = require('../middleware/apiKeyAuth');
const { recordAdminAction } = require('../adminAuditLog');
const { ALLOWED_FIELDS, ALLOWED_OPERATORS } = require('../customRules');

const VALID_SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];
const MAX_NAME_LENGTH = 128;
const MAX_VALUE_LENGTH = 256;

router.post('/custom-rules', requireApiKey, requireRole('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { name, field, operator, value, weight, severity } = req.body || {};

  if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_NAME_LENGTH) {
    return res.status(400).json({ error: `name is required and must be a non-empty string of at most ${MAX_NAME_LENGTH} characters` });
  }
  if (!ALLOWED_FIELDS.includes(field)) {
    return res.status(400).json({ error: `field must be one of: ${ALLOWED_FIELDS.join(', ')}` });
  }
  if (!ALLOWED_OPERATORS.includes(operator)) {
    return res.status(400).json({ error: `operator must be one of: ${ALLOWED_OPERATORS.join(', ')}` });
  }
  if (value === undefined || value === null || String(value).length > MAX_VALUE_LENGTH) {
    return res.status(400).json({ error: `value is required and must be at most ${MAX_VALUE_LENGTH} characters` });
  }
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 100) {
    return res.status(400).json({ error: 'weight is required and must be a number between 0 and 100' });
  }
  if (!VALID_SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` });
  }

  const ruleId = `rule_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();

  db.prepare(
    'INSERT INTO custom_rules (rule_id, name, field, operator, value, weight, severity, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)'
  ).run(ruleId, name, field, operator, String(value), weight, severity, nowIso);
  recordAdminAction(db, { action: 'create', targetType: 'custom_rule', targetId: ruleId, detail: name, actorIp: req.ip });

  res.status(201).json({ rule_id: ruleId, name, field, operator, value: String(value), weight, severity, enabled: true, created_at: nowIso });
});

router.get('/custom-rules', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const rows = db.prepare('SELECT * FROM custom_rules ORDER BY created_at DESC').all();
  res.json(rows.map((r) => ({ ...r, enabled: !!r.enabled })));
});

router.patch('/custom-rules/:ruleId', requireApiKey, requireRole('admin'), (req, res) => {
  const db = req.app.locals.db;
  const existing = db.prepare('SELECT * FROM custom_rules WHERE rule_id = ?').get(req.params.ruleId);
  if (!existing) {
    return res.status(404).json({ error: `No custom rule found with rule_id ${req.params.ruleId}` });
  }

  const { enabled, weight, severity } = req.body || {};
  if (weight !== undefined && (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 100)) {
    return res.status(400).json({ error: 'weight must be a number between 0 and 100' });
  }
  if (severity !== undefined && !VALID_SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` });
  }

  const nextEnabled = enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;
  const nextWeight = weight !== undefined ? weight : existing.weight;
  const nextSeverity = severity !== undefined ? severity : existing.severity;

  db.prepare('UPDATE custom_rules SET enabled = ?, weight = ?, severity = ? WHERE rule_id = ?').run(
    nextEnabled,
    nextWeight,
    nextSeverity,
    req.params.ruleId
  );
  recordAdminAction(db, { action: 'update', targetType: 'custom_rule', targetId: req.params.ruleId, actorIp: req.ip });

  res.json({ rule_id: req.params.ruleId, enabled: !!nextEnabled, weight: nextWeight, severity: nextSeverity });
});

router.delete('/custom-rules/:ruleId', requireApiKey, requireRole('admin'), (req, res) => {
  const db = req.app.locals.db;
  db.prepare('DELETE FROM custom_rules WHERE rule_id = ?').run(req.params.ruleId);
  recordAdminAction(db, { action: 'delete', targetType: 'custom_rule', targetId: req.params.ruleId, actorIp: req.ip });
  res.status(204).end();
});

module.exports = router;
