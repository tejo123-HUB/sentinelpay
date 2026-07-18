// Partial-Feature Completion Pass: Web Push subscription endpoints (server/routes/notifications.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.API_KEY = 'test-key-for-automated-tests';

function freshServer() {
  delete require.cache[require.resolve('../server/index')];
  delete require.cache[require.resolve('../server/middleware/rateLimit')];
  delete require.cache[require.resolve('../server/websocket')];
  const { app, server } = require('../server/index');
  return new Promise((resolve) => {
    if (server.listening) return resolve({ app, server });
    server.once('listening', () => resolve({ app, server }));
  });
}

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY };
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

test('POST /notifications/push-subscriptions: rejects a missing keys object', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/notifications/push-subscriptions', { endpoint: 'https://push.example.com/x' });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
