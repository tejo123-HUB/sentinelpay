// Partial-Feature Completion Pass: Fraud Investigation Module's evidence-attachment gap. Binary
// content is written under a server-generated evidence_id -- never the caller-supplied original
// filename -- so a malicious filename (e.g. containing "../") can never influence the actual
// storage path; the original filename is preserved only as display metadata in
// case_evidence.filename.
//
// PROD/current: Google Cloud Storage is a real, working backend here, not a documented stand-in --
// see the 24 July 2026 Google Cloud integration note in architecture.md Section 9. When
// GCS_BUCKET_NAME is set, every function below genuinely uploads/downloads/deletes an object in
// that bucket via the official `@google-cloud/storage` SDK (auth via standard
// GOOGLE_APPLICATION_CREDENTIALS Application Default Credentials -- no key material handled by
// this code). With no GCS_BUCKET_NAME configured, the local-filesystem path below is the default,
// exactly as before this integration existed -- same "not a degraded experience" convention as
// this project's other optional integrations (Gemini/Claude in server/aiAssistant.js).
const fs = require('node:fs/promises');
const path = require('node:path');

const EVIDENCE_DIR = path.join(__dirname, '..', 'data', 'evidence');

function gcsConfigured() {
  return !!process.env.GCS_BUCKET_NAME;
}

// Lazily required so the @google-cloud/storage SDK (and its gRPC/protobuf dependency tree) is
// only ever loaded into memory when GCS is actually configured -- the common local-filesystem
// demo path stays exactly as lightweight to start as before this integration existed.
let cachedBucket = null;
function getGcsBucket() {
  if (cachedBucket) return cachedBucket;
  const { Storage } = require('@google-cloud/storage');
  const storage = new Storage();
  cachedBucket = storage.bucket(process.env.GCS_BUCKET_NAME);
  return cachedBucket;
}

async function ensureEvidenceDir() {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
}

function evidenceFilePath(evidenceId) {
  return path.join(EVIDENCE_DIR, evidenceId);
}

/** @param {string} evidenceId @param {Buffer} buffer */
async function writeEvidenceFile(evidenceId, buffer) {
  if (gcsConfigured()) {
    await getGcsBucket().file(evidenceId).save(buffer, { resumable: false });
    return;
  }
  await ensureEvidenceDir();
  await fs.writeFile(evidenceFilePath(evidenceId), buffer);
}

/** @param {string} evidenceId @returns {Promise<Buffer>} */
async function readEvidenceFile(evidenceId) {
  if (gcsConfigured()) {
    const [buffer] = await getGcsBucket().file(evidenceId).download();
    return buffer;
  }
  return fs.readFile(evidenceFilePath(evidenceId));
}

async function deleteEvidenceFile(evidenceId) {
  if (gcsConfigured()) {
    try {
      await getGcsBucket().file(evidenceId).delete();
    } catch (err) {
      if (err.code !== 404) throw err;
    }
    return;
  }
  try {
    await fs.unlink(evidenceFilePath(evidenceId));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Test-only seam: lets tests inject a fake bucket object instead of constructing a real
// @google-cloud/storage client, the same "swap the thing that talks to the network" approach this
// project already uses via global.fetch monkeypatching for the Gemini/Claude integrations --
// GCS's SDK doesn't go through fetch, so an explicit setter is this module's equivalent.
function _setGcsBucketForTests(bucket) {
  cachedBucket = bucket;
}

module.exports = {
  EVIDENCE_DIR,
  gcsConfigured,
  writeEvidenceFile,
  readEvidenceFile,
  deleteEvidenceFile,
  _setGcsBucketForTests,
};
