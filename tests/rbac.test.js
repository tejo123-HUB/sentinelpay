// Section 16, Category 20: RBAC via scoped API keys. Every route file captures
// `const { requireApiKey, requireRole } = require('../middleware/apiKeyAuth')` at its own
// module-load time -- so changing API_KEY_ANALYST/API_KEY_VIEWER between tests requires clearing
// *every* server-tree module from require.cache, not just server/index.js and rateLimit.js (the
// existing freshServer() pattern in tests/api.test.js), or a route file holding a stale reference
// to the old apiKeyAuth.js module would silently keep enforcing the previous test's roles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.API_KEY = 'test-admin-key';

function clearServerTreeCache() {
  const serverDir = path.join(__dirname, '..', 'server');
  for (const resolvedPath of Object.keys(require.cache)) {
    if (resolvedPath.startsWith(serverDir)) {
      delete require.cache[resolvedPath];
    }
  }
}

function freshServer() {
  clearServerTreeCache();
  const { app, server } = require('../server/index');
  return new Promise((resolve) => {
    if (server.listening) return resolve({ app, server });
    server.once('listening', () => resolve({ app, server }));
  });
}

function request(server, method, path_, body, headerOverrides = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY, ...headerOverrides };
    for (const key of Object.keys(headers)) {
      if (headers[key] === undefined) delete headers[key];
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: path_, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function validTransaction(overrides = {}) {
  return {
    sender_id: 'u_rbac_1',
    receiver_id: 'u_rbac_2',
    amount: 100,
    timestamp: '2026-07-18T10:00:00Z',
    transaction_type: 'transfer',
    ...overrides,
  };
}

test('RBAC: with no analyst/viewer keys configured, the admin key still works exactly as before', async () => {
  delete process.env.API_KEY_ANALYST;
  delete process.env.API_KEY_VIEWER;
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/transaction', validTransaction());
    assert.equal(res.status, 201);
  } finally {
    server.close();
  }
});

test('RBAC: a viewer key can GET but not POST /transaction', async () => {
  process.env.API_KEY_ANALYST = 'test-analyst-key';
  process.env.API_KEY_VIEWER = 'test-viewer-key';
  const { server } = await freshServer();
  try {
    const getRes = await request(server, 'GET', '/transactions', null, { 'X-API-Key': 'test-viewer-key' });
    assert.equal(getRes.status, 200);

    const postRes = await request(server, 'POST', '/transaction', validTransaction(), { 'X-API-Key': 'test-viewer-key' });
    assert.equal(postRes.status, 403);
  } finally {
    server.close();
    delete process.env.API_KEY_ANALYST;
    delete process.env.API_KEY_VIEWER;
  }
});

test('RBAC: an analyst key can POST /transaction but not manage business-accounts or fraud-lists', async () => {
  process.env.API_KEY_ANALYST = 'test-analyst-key';
  process.env.API_KEY_VIEWER = 'test-viewer-key';
  const { server } = await freshServer();
  try {
    const postTx = await request(server, 'POST', '/transaction', validTransaction(), { 'X-API-Key': 'test-analyst-key' });
    assert.equal(postTx.status, 201);

    const postBiz = await request(server, 'POST', '/business-accounts', { account_id: 'm_test' }, { 'X-API-Key': 'test-analyst-key' });
    assert.equal(postBiz.status, 403);

    const postFraudList = await request(
      server,
      'POST',
      '/fraud-lists',
      { list_type: 'blacklist', account_id: 'u_bad' },
      { 'X-API-Key': 'test-analyst-key' }
    );
    assert.equal(postFraudList.status, 403);
  } finally {
    server.close();
    delete process.env.API_KEY_ANALYST;
    delete process.env.API_KEY_VIEWER;
  }
});

test('RBAC: the admin key can still do everything once analyst/viewer keys exist', async () => {
  process.env.API_KEY_ANALYST = 'test-analyst-key';
  process.env.API_KEY_VIEWER = 'test-viewer-key';
  const { server } = await freshServer();
  try {
    const postBiz = await request(server, 'POST', '/business-accounts', { account_id: 'm_admin_test' });
    assert.equal(postBiz.status, 201);

    const auditLog = await request(server, 'GET', '/admin-audit-log');
    assert.equal(auditLog.status, 200);
  } finally {
    server.close();
    delete process.env.API_KEY_ANALYST;
    delete process.env.API_KEY_VIEWER;
  }
});

test('RBAC: GET /admin-audit-log is admin-only, rejecting even a valid analyst key', async () => {
  process.env.API_KEY_ANALYST = 'test-analyst-key';
  process.env.API_KEY_VIEWER = 'test-viewer-key';
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/admin-audit-log', null, { 'X-API-Key': 'test-analyst-key' });
    assert.equal(res.status, 403);
  } finally {
    server.close();
    delete process.env.API_KEY_ANALYST;
    delete process.env.API_KEY_VIEWER;
  }
});

test('RBAC: an unrecognized key is still rejected with 401, not 403', async () => {
  process.env.API_KEY_ANALYST = 'test-analyst-key';
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/transactions', null, { 'X-API-Key': 'totally-bogus-key' });
    assert.equal(res.status, 401);
  } finally {
    server.close();
    delete process.env.API_KEY_ANALYST;
  }
});
