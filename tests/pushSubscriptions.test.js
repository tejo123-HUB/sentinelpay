// Partial-Feature Completion Pass: Web Push subscription endpoints (server/routes/notifications.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.API_KEY = 'test-key-for-automated-tests';

// Clears the whole server/ subtree, not just index.js/rateLimit.js -- tests below set
// API_KEY_VIEWER, and every route file captures requireApiKey/requireRole from
// middleware/apiKeyAuth.js at its own module-load time (see tests/caseEvidence.test.js /
// tests/rbac.test.js for the same reasoning), so a narrower cache clear would leave routes
// enforcing a stale role set.
function freshServer() {
  const serverDir = require('node:path').join(__dirname, '..', 'server');
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
    // Node's http.request doesn't always auto-set Content-Length for DELETE bodies the way it
    // does for POST/PATCH -- explicit here so body-parser's typeis.hasBody check (which requires
    // either transfer-encoding or a non-zero content-length) sees the body on every method.
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('GET /notifications/vapid-public-key: 404s when VAPID is not configured', async () => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/notifications/vapid-public-key');
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('GET /notifications/vapid-public-key: returns the configured public key', async () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  process.env.VAPID_PUBLIC_KEY = ecdh.getPublicKey().toString('base64url');
  process.env.VAPID_PRIVATE_KEY = ecdh.getPrivateKey().toString('base64url');
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/notifications/vapid-public-key');
    assert.equal(res.status, 200);
    assert.equal(res.body.public_key, process.env.VAPID_PUBLIC_KEY);
  } finally {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    server.close();
  }
});

test('POST /notifications/push-subscriptions: registers a subscription, and DELETE removes it', async () => {
  const { server } = await freshServer();
  try {
    const subscription = {
      endpoint: 'https://push.example.com/some/endpoint/id',
      keys: { p256dh: 'fake-p256dh-value', auth: 'fake-auth-value' },
    };
    const postRes = await request(server, 'POST', '/notifications/push-subscriptions', subscription);
    assert.equal(postRes.status, 201);

    // Re-subscribing (same endpoint) upserts rather than erroring.
    const postAgain = await request(server, 'POST', '/notifications/push-subscriptions', subscription);
    assert.equal(postAgain.status, 201);

    const deleteRes = await request(server, 'DELETE', '/notifications/push-subscriptions', { endpoint: subscription.endpoint });
    assert.equal(deleteRes.status, 204);
  } finally {
    server.close();
  }
});

test('POST /notifications/push-subscriptions: rejects a non-https endpoint', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/notifications/push-subscriptions', {
      endpoint: 'http://push.example.com/insecure',
      keys: { p256dh: 'x', auth: 'y' },
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

// Security fix (post-merge audit / SSRF): the https:// check alone doesn't stop a caller from
// registering an internal/loopback/link-local destination directly. A registered endpoint causes
// this server to make a real outbound VAPID-authenticated request to it on every future Critical
// alert -- an analyst-role key shouldn't be able to point that at internal infrastructure.
test('POST /notifications/push-subscriptions: rejects internal/loopback/link-local endpoint hosts', async () => {
  const { server } = await freshServer();
  try {
    const disallowed = [
      'https://127.0.0.1/hook',
      'https://localhost/hook',
      'https://169.254.169.254/latest/meta-data/', // cloud metadata service
      'https://10.0.0.5/hook',
      'https://192.168.1.1/hook',
      'https://172.16.0.1/hook',
      'https://[::1]/hook',
      'https://[fc00::1]/hook',
    ];
    for (const endpoint of disallowed) {
      const res = await request(server, 'POST', '/notifications/push-subscriptions', {
        endpoint,
        keys: { p256dh: 'x', auth: 'y' },
      });
      assert.equal(res.status, 400, `expected ${endpoint} to be rejected`);
    }
  } finally {
    server.close();
  }
});

test('POST /notifications/push-subscriptions: rejects a missing keys object', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/notifications/push-subscriptions', { endpoint: 'https://push.example.com/x' });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

// Code-review follow-up: a viewer-role key (explicitly scoped elsewhere in this app to "watch the
// dashboard but not inject transactions") must not be able to register a subscription -- a
// registered endpoint causes this server to make a real outbound authenticated request to it on
// every future Critical alert, a privilege-boundary violation a read-only key shouldn't get.
test('POST /notifications/push-subscriptions: requires the analyst role, not just any valid key', async () => {
  process.env.API_KEY_VIEWER = 'test-viewer-key-push';
  const { server } = await freshServer();
  try {
    const res = await request(
      server,
      'POST',
      '/notifications/push-subscriptions',
      { endpoint: 'https://push.example.com/viewer-attempt', keys: { p256dh: 'x', auth: 'y' } },
      { 'X-API-Key': 'test-viewer-key-push' }
    );
    assert.equal(res.status, 403);
  } finally {
    delete process.env.API_KEY_VIEWER;
    server.close();
  }
});

test('DELETE /notifications/push-subscriptions: also requires the analyst role', async () => {
  process.env.API_KEY_VIEWER = 'test-viewer-key-push-del';
  const { server } = await freshServer();
  try {
    const res = await request(
      server,
      'DELETE',
      '/notifications/push-subscriptions',
      { endpoint: 'https://push.example.com/whatever' },
      { 'X-API-Key': 'test-viewer-key-push-del' }
    );
    assert.equal(res.status, 403);
  } finally {
    delete process.env.API_KEY_VIEWER;
    server.close();
  }
});

// Code-review follow-up: bounds how many endpoints an authorized caller can register, so one
// Critical alert can never fan out into an unbounded number of outbound requests.
test('POST /notifications/push-subscriptions: rejects a new subscription once MAX_SUBSCRIPTIONS is reached, but still allows updating an existing one', async () => {
  const { PUSH_SUBSCRIPTIONS } = require('../server/config');
  const { server } = await freshServer();
  try {
    for (let i = 0; i < PUSH_SUBSCRIPTIONS.MAX_SUBSCRIPTIONS; i++) {
      const res = await request(server, 'POST', '/notifications/push-subscriptions', {
        endpoint: `https://push.example.com/cap-test/${i}`,
        keys: { p256dh: 'x', auth: 'y' },
      });
      assert.equal(res.status, 201, `subscription ${i} should have been accepted`);
    }

    const overCap = await request(server, 'POST', '/notifications/push-subscriptions', {
      endpoint: 'https://push.example.com/cap-test/over-limit',
      keys: { p256dh: 'x', auth: 'y' },
    });
    assert.equal(overCap.status, 429);

    // Updating an already-registered endpoint's keys must still work at the cap -- the cap
    // bounds distinct endpoints, not re-subscriptions of an existing one.
    const updateExisting = await request(server, 'POST', '/notifications/push-subscriptions', {
      endpoint: 'https://push.example.com/cap-test/0',
      keys: { p256dh: 'new-key', auth: 'new-auth' },
    });
    assert.equal(updateExisting.status, 201);
  } finally {
    server.close();
  }
});
