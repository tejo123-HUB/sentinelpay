// Partial-Feature Completion Pass: Fraud Investigation Module's evidence-attachment gap. Binary
// content is written to disk under a server-generated evidence_id filename -- never the caller-
// supplied original filename -- so a malicious filename (e.g. containing "../") can never
// influence the actual on-disk path; the original filename is preserved only as display metadata
// in case_evidence.filename.
const fs = require('node:fs');
const path = require('node:path');

const EVIDENCE_DIR = path.join(__dirname, '..', 'data', 'evidence');

function ensureEvidenceDir() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

function evidenceFilePath(evidenceId) {
  return path.join(EVIDENCE_DIR, evidenceId);
}

/** @param {string} evidenceId @param {Buffer} buffer */
function writeEvidenceFile(evidenceId, buffer) {
  ensureEvidenceDir();
  fs.writeFileSync(evidenceFilePath(evidenceId), buffer);
}

/** @param {string} evidenceId @returns {Buffer} */
function readEvidenceFile(evidenceId) {
  return fs.readFileSync(evidenceFilePath(evidenceId));
}

function deleteEvidenceFile(evidenceId) {
  try {
    fs.unlinkSync(evidenceFilePath(evidenceId));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { EVIDENCE_DIR, writeEvidenceFile, readEvidenceFile, deleteEvidenceFile };
