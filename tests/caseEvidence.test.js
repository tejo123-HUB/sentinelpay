// Partial-Feature Completion Pass: Fraud Investigation Module's evidence-attachment gap.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { CASE_EVIDENCE } = require('../server/config');

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.API_KEY = 'test-key-for-automated-tests';

// Clears the whole server/ subtree (not just index.js/rateLimit.js) -- one test below sets
// API_KEY_VIEWER, and every route file captures requireApiKey/requireRole from
// middleware/apiKeyAuth.js at its own module-load time (see tests/rbac.test.js for the same
// reasoning), so a narrower cache clear would leave routes enforcing a stale role set.
function freshServer() {
  const serverDir = path.join(__dirname, '..', 'server');
  for (const resolvedPath of Object.keys(require.cache)) {
    if (resolvedPath.startsWith(serverDir)) delete require.cache[resolvedPath];
  }
  const { app, server } = require('../server/index');
  return new Promise((resolve) => {
    if (server.listening) return resolve({ app, server });
    server.once('listening', () => resolve({ app, server }));
  });
}

function request(server, method, path, body, headerOverrides = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY, ...headerOverrides };
    for (const key of Object.keys(headers)) {
      if (headers[key] === undefined) delete headers[key];
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('application/json')) {
          let parsed = null;
          try {
            parsed = raw.length ? JSON.parse(raw.toString('utf-8')) : null;
          } catch {
            parsed = raw.toString('utf-8');
          }
          return resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw });
        }
        resolve({ status: res.statusCode, body: null, headers: res.headers, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function createCase(server) {
  const res = await request(server, 'POST', '/cases', { title: 'Evidence test case' });
  return res.body.case_id;
}

test('POST /cases/:caseId/evidence: uploads, and content round-trips exactly', async () => {
  const { server } = await freshServer();
  try {
    const caseId = await createCase(server);
    const content = Buffer.from('hello evidence file contents');
    const uploadRes = await request(server, 'POST', `/cases/${caseId}/evidence`, {
      filename: 'screenshot.png',
      mime_type: 'image/png',
      content_base64: content.toString('base64'),
    });
    assert.equal(uploadRes.status, 201);
    assert.equal(uploadRes.body.filename, 'screenshot.png');
    assert.equal(uploadRes.body.size_bytes, content.length);

    const listRes = await request(server, 'GET', `/cases/${caseId}/evidence`);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.length, 1);
    assert.equal(listRes.body[0].evidence_id, uploadRes.body.evidence_id);

    const downloadRes = await request(server, 'GET', `/cases/${caseId}/evidence/${uploadRes.body.evidence_id}/content`);
    assert.equal(downloadRes.status, 200);
    assert.equal(downloadRes.raw.toString('utf-8'), content.toString('utf-8'));
    assert.match(downloadRes.headers['content-disposition'], /screenshot\.png/);
  } finally {
    server.close();
  }
});

test('POST /cases/:caseId/evidence: rejects content over the size limit', async () => {
  const { server } = await freshServer();
  try {
    const caseId = await createCase(server);
    const bigContent = Buffer.alloc(CASE_EVIDENCE.MAX_SIZE_BYTES + 1, 'a');
    const res = await request(server, 'POST', `/cases/${caseId}/evidence`, {
      filename: 'too-big.bin',
      content_base64: bigContent.toString('base64'),
    });
    assert.equal(res.status, 413);
  } finally {
    server.close();
  }
});

// Code-review follow-up: the on-disk path is always server-generated (server/caseEvidence.js's
// evidenceFilePath uses evidence_id, never the caller-supplied filename) -- this test pins that
// invariant down explicitly, the same "test the exact shape of a known-dangerous input" pattern
// tests/api.test.js already applies to SQL/XSS-shaped input, so a future refactor that
// accidentally reintroduced the raw filename into the disk path would fail loudly here rather
// than silently opening a path-traversal hole.
test('POST /cases/:caseId/evidence: a path-traversal-shaped filename never influences the on-disk path (regression)', async () => {
  const { server } = await freshServer();
  try {
    const caseId = await createCase(server);
    const content = Buffer.from('traversal probe content');
    const uploadRes = await request(server, 'POST', `/cases/${caseId}/evidence`, {
      filename: '../../../../etc/passwd',
      content_base64: content.toString('base64'),
    });
    assert.equal(uploadRes.status, 201);
    // The stored filename is preserved verbatim as display metadata (that's fine -- it's never
    // used to build a filesystem path)...
    assert.equal(uploadRes.body.filename, '../../../../etc/passwd');

    // ...and the content is still readable back only via the server-generated evidence_id, proving
    // the malicious filename was never used as (part of) the actual on-disk path.
    const downloadRes = await request(server, 'GET', `/cases/${caseId}/evidence/${uploadRes.body.evidence_id}/content`);
    assert.equal(downloadRes.status, 200);
    assert.equal(downloadRes.raw.toString('utf-8'), content.toString('utf-8'));

    const evidenceDir = path.join(__dirname, '..', 'data', 'evidence');
    const onDiskPath = path.join(evidenceDir, uploadRes.body.evidence_id);
    assert.ok(onDiskPath.startsWith(evidenceDir + path.sep), 'evidence file must stay inside the evidence directory');
  } finally {
    server.close();
  }
});

test('POST /cases/:caseId/evidence: rejects invalid base64', async () => {
  const { server } = await freshServer();
  try {
    const caseId = await createCase(server);
    const res = await request(server, 'POST', `/cases/${caseId}/evidence`, {
      filename: 'bad.bin',
      content_base64: 'not valid base64!!!',
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /cases/:caseId/evidence: 404s for an unknown case', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/cases/case_nonexistent/evidence', {
      filename: 'a.txt',
      content_base64: Buffer.from('x').toString('base64'),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('POST /cases/:caseId/evidence: requires the analyst role', async () => {
  process.env.API_KEY_VIEWER = 'test-viewer-key';
  const { server } = await freshServer();
  try {
    const caseId = await createCase(server);
    const res = await request(server, 'POST', `/cases/${caseId}/evidence`, { filename: 'a.txt', content_base64: Buffer.from('x').toString('base64') }, { 'X-API-Key': 'test-viewer-key' });
    assert.equal(res.status, 403);
  } finally {
    delete process.env.API_KEY_VIEWER;
    server.close();
  }
});

// Security fix (post-merge audit): this route streams actual attachment content, not just
// metadata -- previously reachable by any valid key (including viewer), now requires analyst,
// matching the upload route's own floor.
test('GET /cases/:caseId/evidence/:evidenceId/content: requires the analyst role', async () => {
  process.env.API_KEY_VIEWER = 'test-viewer-key-evidence-read';
  const { server } = await freshServer();
  try {
    const caseId = await createCase(server);
    const uploadRes = await request(server, 'POST', `/cases/${caseId}/evidence`, {
      filename: 'a.txt',
      content_base64: Buffer.from('x').toString('base64'),
    });
    const res = await request(
      server,
      'GET',
      `/cases/${caseId}/evidence/${uploadRes.body.evidence_id}/content`,
      null,
      { 'X-API-Key': 'test-viewer-key-evidence-read' }
    );
    assert.equal(res.status, 403);
  } finally {
    delete process.env.API_KEY_VIEWER;
    server.close();
  }
});

test('GET /cases/:caseId/evidence/:evidenceId/content: 404s for an unknown evidence id', async () => {
  const { server } = await freshServer();
  try {
    const caseId = await createCase(server);
    const res = await request(server, 'GET', `/cases/${caseId}/evidence/ev_nonexistent/content`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

// Google Cloud Storage integration (24 July 2026): when GCS_BUCKET_NAME is configured, evidence
// content genuinely round-trips through @google-cloud/storage's Bucket/File API rather than the
// local filesystem. A real GCS project isn't available in this test environment, so this injects
// a fake bucket via caseEvidence.js's _setGcsBucketForTests() test seam (the same "swap out the
// thing that talks to the network" approach this project already uses via global.fetch
// monkeypatching elsewhere) -- what's under test is that the route/module actually call
// file().save()/download() with the right object name, not the real GCS network behavior.
test('POST/GET evidence: uses the configured GCS bucket (save/download) instead of the filesystem when GCS_BUCKET_NAME is set', async () => {
  process.env.GCS_BUCKET_NAME = 'test-fake-bucket';
  const { server } = await freshServer();
  const caseEvidenceModule = require('../server/caseEvidence');

  const store = new Map();
  const savedCalls = [];
  const downloadCalls = [];
  const fakeBucket = {
    file(objectName) {
      return {
        save: async (buffer) => {
          savedCalls.push(objectName);
          store.set(objectName, buffer);
        },
        download: async () => {
          downloadCalls.push(objectName);
          if (!store.has(objectName)) {
            const err = new Error('not found');
            err.code = 404;
            throw err;
          }
          return [store.get(objectName)];
        },
      };
    },
  };
  caseEvidenceModule._setGcsBucketForTests(fakeBucket);

  try {
    const caseId = await createCase(server);
    const content = Buffer.from('gcs-backed evidence bytes');
    const uploadRes = await request(server, 'POST', `/cases/${caseId}/evidence`, {
      filename: 'gcs-file.bin',
      content_base64: content.toString('base64'),
    });
    assert.equal(uploadRes.status, 201);
    assert.equal(savedCalls.length, 1);
    assert.equal(savedCalls[0], uploadRes.body.evidence_id);
    // Never written to the local filesystem path when GCS is configured.
    assert.ok(!store.has('nonexistent'));

    const downloadRes = await request(server, 'GET', `/cases/${caseId}/evidence/${uploadRes.body.evidence_id}/content`);
    assert.equal(downloadRes.status, 200);
    assert.equal(downloadRes.raw.toString('utf-8'), content.toString('utf-8'));
    assert.equal(downloadCalls.length, 1);
    assert.equal(downloadCalls[0], uploadRes.body.evidence_id);
  } finally {
    caseEvidenceModule._setGcsBucketForTests(null);
    delete process.env.GCS_BUCKET_NAME;
    server.close();
  }
});
