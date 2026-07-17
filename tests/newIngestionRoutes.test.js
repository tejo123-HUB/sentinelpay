// Section 15.16: end-to-end coverage for the two new ingestion routes (POST /merchant-logins,
// Feature 4; POST /disputes, Feature 8) plus their effect on the scoring pipeline. Same
// freshServer/request harness as tests/api.test.js -- kept in a separate file rather than added
// to that already-large file, matching this project's convention of splitting by concern
// (tests/rateLimit.test.js, tests/userProfile.test.js are both similarly split off).
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

// ---- POST /merchant-logins ----

test('POST /merchant-logins: valid input returns 201 and round-trips through GET', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/merchant-logins', {
      merchant_id: 'm_takeover_test',
      device_id: 'd_1',
      browser: 'Chrome',
      os: 'Windows',
      ip_address: '198.51.100.7',
      country: 'IN',
      location: { lat: 12.9, lng: 77.6 },
    });
    assert.equal(posted.status, 201);
    assert.ok(posted.body.login_id);

    const res = await request(server, 'GET', '/merchant-logins?merchant_id=m_takeover_test');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].device_id, 'd_1');
    assert.equal(res.body[0].country, 'IN');
  } finally {
    server.close();
  }
});

test('POST /merchant-logins: rejects a missing merchant_id', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/merchant-logins', { device_id: 'd_1' });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /merchant-logins: requires an API key', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/merchant-logins', { merchant_id: 'm_1' }, { 'X-API-Key': undefined });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('POST /transaction: a merchant takeover login followed by a refund is flagged (Section 15.16, Feature 4)', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_takeover_e2e' });
    await request(server, 'POST', '/merchant-logins', { merchant_id: 'm_takeover_e2e', device_id: 'd_known', country: 'IN' });
    await request(server, 'POST', '/merchant-logins', { merchant_id: 'm_takeover_e2e', device_id: 'd_attacker', country: 'RU' });

    const refund = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({ sender_id: 'm_takeover_e2e', receiver_id: 'u_victim', purpose: 'Refund' })
    );

    assert.equal(refund.status, 201);
    assert.notEqual(refund.body.decision, 'allow');
    assert.ok(refund.body.reasons.some((r) => r.includes('previously unrecognized device')));
  } finally {
    server.close();
  }
});

// ---- POST /disputes ----

test('POST /disputes: valid input returns 201 and round-trips through GET', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/disputes', {
      transaction_id: 't_abc',
      customer_id: 'u_disputer',
      dispute_type: 'chargeback',
    });
    assert.equal(posted.status, 201);
    assert.ok(posted.body.dispute_id);

    const res = await request(server, 'GET', '/disputes?customer_id=u_disputer');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].dispute_type, 'chargeback');
  } finally {
    server.close();
  }
});

test('POST /disputes: rejects a missing customer_id or dispute_type', async () => {
  const { server } = await freshServer();
  try {
    const missingCustomer = await request(server, 'POST', '/disputes', { dispute_type: 'chargeback' });
    assert.equal(missingCustomer.status, 400);

    const missingType = await request(server, 'POST', '/disputes', { customer_id: 'u_1' });
    assert.equal(missingType.status, 400);
  } finally {
    server.close();
  }
});

test('POST /transaction: a repeat-dispute customer elevates a refund\'s risk (Section 15.16, Feature 8)', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_dispute_e2e' });
    for (let i = 0; i < 3; i += 1) {
      await request(server, 'POST', '/disputes', { customer_id: 'u_repeat_disputer', dispute_type: 'chargeback' });
    }

    const refund = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({ sender_id: 'm_dispute_e2e', receiver_id: 'u_repeat_disputer', purpose: 'Refund' })
    );

    assert.equal(refund.status, 201);
    assert.ok(refund.body.reasons.some((r) => r.includes('repeat dispute pattern')));
  } finally {
    server.close();
  }
});
