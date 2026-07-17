// Section 16 (Categories 19/21): end-to-end coverage for the fraud_lists registry (blacklist/
// whitelist/watchlist) and its wiring into the scoring pipeline. Same freshServer/request harness
// as tests/newIngestionRoutes.test.js / tests/analytics.test.js.
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
    merchant_id: 'm_test',
    transaction_type: 'transfer',
    ...overrides,
  };
}

// ---- CRUD ----

test('POST /fraud-lists: valid input returns 201 and round-trips through GET', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/fraud-lists', { list_type: 'blacklist', account_id: 'u_bad', reason: 'confirmed fraud' });
    assert.equal(posted.status, 201);
    assert.ok(posted.body.entry_id);

    const res = await request(server, 'GET', '/fraud-lists?list_type=blacklist');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].account_id, 'u_bad');
  } finally {
    server.close();
  }
});

test('POST /fraud-lists: rejects an invalid list_type or missing account_id', async () => {
  const { server } = await freshServer();
  try {
    const badType = await request(server, 'POST', '/fraud-lists', { list_type: 'not_real', account_id: 'u_1' });
    assert.equal(badType.status, 400);

    const missingAccount = await request(server, 'POST', '/fraud-lists', { list_type: 'blacklist' });
    assert.equal(missingAccount.status, 400);
  } finally {
    server.close();
  }
});

test('DELETE /fraud-lists/:entryId: removes an entry, idempotently', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/fraud-lists', { list_type: 'watchlist', account_id: 'u_watch' });
    const del1 = await request(server, 'DELETE', `/fraud-lists/${posted.body.entry_id}`);
    assert.equal(del1.status, 204);
    const del2 = await request(server, 'DELETE', `/fraud-lists/${posted.body.entry_id}`);
    assert.equal(del2.status, 204);

    const res = await request(server, 'GET', '/fraud-lists');
    assert.equal(res.body.length, 0);
  } finally {
    server.close();
  }
});

test('fraud-lists routes require an API key', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/fraud-lists', null, { 'X-API-Key': undefined });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

// ---- Scoring pipeline integration ----

test('POST /transaction: a blacklisted sender is blocked even on an inbound (non-business) transaction', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/fraud-lists', { list_type: 'blacklist', account_id: 'u_blacklisted_sender', reason: 'known fraud ring' });

    const res = await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_blacklisted_sender', receiver_id: 'm_ordinary_store' }));

    assert.equal(res.status, 201);
    assert.equal(res.body.decision, 'block');
    assert.equal(res.body.severity, 'Critical');
    assert.ok(res.body.reasons.some((r) => r.includes('fraud blacklist')));
  } finally {
    server.close();
  }
});

test('POST /transaction: a blacklisted receiver is blocked on an otherwise-clean outbound payout', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_blacklist_test' });
    await request(server, 'POST', '/fraud-lists', { list_type: 'blacklist', account_id: 'u_blacklisted_receiver' });

    const res = await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_blacklist_test', receiver_id: 'u_blacklisted_receiver', amount: 10 }));

    assert.equal(res.status, 201);
    assert.equal(res.body.decision, 'block');
  } finally {
    server.close();
  }
});

test('POST /transaction: a whitelisted account reduces an otherwise-flagged outbound score', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_whitelist_test' });
    await request(server, 'POST', '/fraud-lists', { list_type: 'whitelist', account_id: 'u_trusted_customer' });

    // A large payout to a brand-new vendor would ordinarily flag heavily (newVendorRisk.js) --
    // whitelisting the receiver should suppress that down to the whitelist ceiling.
    const res = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({ sender_id: 'm_whitelist_test', receiver_id: 'u_trusted_customer', amount: 100, purpose: null })
    );

    assert.equal(res.status, 201);
    assert.equal(res.body.decision, 'allow');
  } finally {
    server.close();
  }
});
