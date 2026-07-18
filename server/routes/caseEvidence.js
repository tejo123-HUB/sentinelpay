// Partial-Feature Completion Pass: Fraud Investigation Module's evidence-attachment gap -- real
// file attachments on a case, beyond the pre-existing free-text investigation_notes. Content
// arrives base64-encoded inside the JSON body (no multipart-form dependency, consistent with this
// project's dependency-light convention); binary bytes are written to disk under a server-
// generated id (server/caseEvidence.js), never the caller-supplied filename.
const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();

const { requireApiKey, requireRole } = require('../middleware/apiKeyAuth');
const { CASE_EVIDENCE } = require('../config');
const { writeEvidenceFile, readEvidenceFile } = require('../caseEvidence');

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64Strict(value) {
  const cleaned = value.replace(/\s+/g, '');
  if (cleaned.length === 0 || cleaned.length % 4 !== 0 || !BASE64_PATTERN.test(cleaned)) return null;
  return Buffer.from(cleaned, 'base64');
}

function serializeEvidence(row) {
  return {
    evidence_id: row.evidence_id,
    case_id: row.case_id,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
  };
}

// POST /cases/:caseId/evidence { filename, mime_type?, content_base64, uploaded_by? } --
// analyst-or-above, same role floor as every other case-mutating route in routes/cases.js.
router.post('/cases/:caseId/evidence', requireApiKey, requireRole('analyst'), (req, res) => {
  const db = req.app.locals.db;
  const existingCase = db.prepare('SELECT 1 FROM cases WHERE case_id = ?').get(req.params.caseId);
  if (!existingCase) {
    return res.status(404).json({ error: `No case found with case_id ${req.params.caseId}` });
  }

  const { filename, mime_type, content_base64, uploaded_by } = req.body || {};
  if (typeof filename !== 'string' || filename.trim() === '' || filename.length > CASE_EVIDENCE.MAX_FILENAME_LENGTH) {
    return res.status(400).json({ error: `filename is required and must be at most ${CASE_EVIDENCE.MAX_FILENAME_LENGTH} characters` });
  }
  if (mime_type !== undefined && mime_type !== null && (typeof mime_type !== 'string' || mime_type.length > 128)) {
    return res.status(400).json({ error: 'mime_type must be at most 128 characters' });
  }
  if (typeof content_base64 !== 'string' || content_base64.trim() === '') {
    return res.status(400).json({ error: 'content_base64 is required' });
  }

  const buffer = decodeBase64Strict(content_base64);
  if (!buffer) {
    return res.status(400).json({ error: 'content_base64 must be valid base64-encoded content' });
  }
  if (buffer.length > CASE_EVIDENCE.MAX_SIZE_BYTES) {
    return res.status(413).json({ error: `Evidence content exceeds the ${CASE_EVIDENCE.MAX_SIZE_BYTES}-byte limit` });
  }
  if (uploaded_by !== undefined && uploaded_by !== null && (typeof uploaded_by !== 'string' || uploaded_by.length > 128)) {
    return res.status(400).json({ error: 'uploaded_by must be at most 128 characters' });
  }

  const evidenceId = `ev_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();

  writeEvidenceFile(evidenceId, buffer);
  db.prepare(
    'INSERT INTO case_evidence (evidence_id, case_id, filename, mime_type, size_bytes, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(evidenceId, req.params.caseId, filename, typeof mime_type === 'string' ? mime_type : null, buffer.length, typeof uploaded_by === 'string' ? uploaded_by : null, nowIso);
  db.prepare('UPDATE cases SET updated_at = ? WHERE case_id = ?').run(nowIso, req.params.caseId);

  res.status(201).json(serializeEvidence({ evidence_id: evidenceId, case_id: req.params.caseId, filename, mime_type, size_bytes: buffer.length, uploaded_by, created_at: nowIso }));
});

// GET /cases/:caseId/evidence -- metadata list only, never the content (keeps the list cheap and
// avoids returning megabytes of base64 for a page that's just showing filenames).
router.get('/cases/:caseId/evidence', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const existingCase = db.prepare('SELECT 1 FROM cases WHERE case_id = ?').get(req.params.caseId);
  if (!existingCase) {
    return res.status(404).json({ error: `No case found with case_id ${req.params.caseId}` });
  }

  const rows = db.prepare('SELECT * FROM case_evidence WHERE case_id = ? ORDER BY created_at ASC').all(req.params.caseId);
  res.json(rows.map(serializeEvidence));
});

// A Content-Disposition filename that came from user input (case_evidence.filename) could
// otherwise carry quotes/CRLF-adjacent characters into the header; RFC 6266's filename* form
// (percent-encoded) is the correct way to carry an arbitrary display name safely, alongside a
// stripped-down ASCII fallback in the plain filename= parameter for older clients.
function contentDispositionHeader(filename) {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// GET /cases/:caseId/evidence/:evidenceId/content -- the actual binary bytes, served with the
// stored mime_type and a safely-encoded Content-Disposition header.
// Security fix (post-merge audit): analyst-or-above, not just any valid key. The metadata list
// route above is deliberately left at viewer level (filenames/sizes only, low sensitivity), but
// this route streams the actual attached content (screenshots, documents an analyst uploaded to
// an investigation) -- the same elevated floor the upload route (POST, above) already requires,
// which a read-only viewer key shouldn't bypass just because reading is "only" a GET.
router.get('/cases/:caseId/evidence/:evidenceId/content', requireApiKey, requireRole('analyst'), (req, res) => {
  const db = req.app.locals.db;
  const row = db
    .prepare('SELECT * FROM case_evidence WHERE case_id = ? AND evidence_id = ?')
    .get(req.params.caseId, req.params.evidenceId);
  if (!row) {
    return res.status(404).json({ error: 'No evidence found with that case_id/evidence_id' });
  }

  let buffer;
  try {
    buffer = readEvidenceFile(row.evidence_id);
  } catch (err) {
    return res.status(500).json({ error: 'Evidence content is missing on disk' });
  }

  res.set('Content-Disposition', contentDispositionHeader(row.filename));
  res.type(row.mime_type || 'application/octet-stream').send(buffer);
});

module.exports = router;
