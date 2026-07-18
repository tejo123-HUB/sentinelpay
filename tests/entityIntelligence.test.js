// Partial-Feature Completion Pass: Vendor Intelligence's dedicated trust-score gap and Merchant
// Intelligence's dedicated behavioral-profiling gap. Same freshServer/request harness as
// tests/graph.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

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

function request(server, method, path, body, headerOverrides = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY, ...headerOverrides };
    for (const key of Object.keys(headers)) {
      if (headers[key] === undefined) delete headers[key];
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
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
    sender_id: 'u_test_1',
    receiver_id: 'u_test_2',
    amount: 250,
    timestamp: '2026-07-18T10:15:00Z',
    device_id: 'd_test',
    transaction_type: 'transfer',
    ...overrides,
  };
}

test('GET /vendors/:vendorId/trust-score: a vendor with no history gets a neutral score', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/vendors/u_unknown_vendor/trust-score');
    assert.equal(res.status, 200);
    assert.equal(res.body.trust_score, 50);
    assert.equal(res.body.is_new_vendor, true);
  } finally {
    server.close();
  }
});

test('GET /vendors/:vendorId/trust-score: an established vendor with clean payments scores high', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_vendor_biz' });
    // Seed inbound customer revenue first -- outboundRatioAnomaly.js flags outbound payments with
    // no legitimate revenue basis behind them, so a business with zero inbound history would
    // otherwise score every one of its outbound vendor payments as anomalous regardless of the
    // vendor's own cleanliness, which isn't what this test is trying to isolate. A distinct
    // device_id (not shared with the vendor payments below) avoids also tripping the shared-
    // device detector, which isn't part of this scenario either.
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_customer', receiver_id: 'm_vendor_biz', amount: 500000, timestamp: '2026-07-17T23:00:00Z', device_id: 'd_customer' }));
    // Only two vendor payments, no device_id (POST /transaction overwrites the client-supplied
    // timestamp with real server time, so back-to-back requests in a test loop land within the
    // same velocity window regardless of the synthetic timestamps passed here -- keeping this
    // below velocity.js's burst threshold avoids that unrelated detector firing).
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_vendor_biz', receiver_id: 'u_clean_vendor', amount: 100, device_id: null, purpose: 'vendor settlement' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_vendor_biz', receiver_id: 'u_clean_vendor', amount: 105, device_id: null, purpose: 'vendor settlement' }));

    const res = await request(server, 'GET', '/vendors/u_clean_vendor/trust-score');
    assert.equal(res.status, 200);
    assert.equal(res.body.total_payments, 2);
    assert.ok(res.body.trust_score >= 60, `expected a decent trust score, got ${res.body.trust_score}`);
  } finally {
    server.close();
  }
});

test('GET /vendors/:vendorId/trust-score: requires vendorId and API key', async () => {
  const { server } = await freshServer();
  try {
    const unauth = await request(server, 'GET', '/vendors/u_x/trust-score', null, { 'X-API-Key': undefined });
    assert.equal(unauth.status, 401);
  } finally {
    server.close();
  }
});

test('GET /vendors/top-trusted: only includes vendors meeting the minimum payment count', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_vendor_biz2' });
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_vendor_biz2', receiver_id: 'u_one_payment_vendor', amount: 100, timestamp: '2026-07-18T05:00:00Z', purpose: 'vendor settlement' }));

    const res = await request(server, 'GET', '/vendors/top-trusted');
    assert.equal(res.status, 200);
    assert.ok(!res.body.some((v) => v.vendor_id === 'u_one_payment_vendor'));
  } finally {
    server.close();
  }
});

test('GET /merchants/:merchantId/profile: aggregates transaction health and login activity', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_profile_biz' });
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_profile_biz', receiver_id: 'u_recv', amount: 100, timestamp: '2026-07-18T06:00:00Z' }));
    await request(server, 'POST', '/merchant-logins', { merchant_id: 'm_profile_biz', device_id: 'd_login_1', timestamp: '2026-07-18T05:59:00Z' });

    const res = await request(server, 'GET', '/merchants/m_profile_biz/profile');
    assert.equal(res.status, 200);
    assert.equal(res.body.total_transactions, 1);
    assert.equal(res.body.login_activity.total_logins, 1);
    assert.ok(res.body.security_score >= 0 && res.body.security_score <= 100);
  } finally {
    server.close();
  }
});

test('GET /merchants/:merchantId/profile: requires merchantId', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/merchants/%20/profile');
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
