// Section 15.16, Feature 18: end-to-end coverage for the analytics endpoints. Same
// freshServer/request harness as tests/newIngestionRoutes.test.js.
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
    merchant_id: 'm_gw_a',
    transaction_type: 'transfer',
    ...overrides,
  };
}

test('GET /analytics/summary: reflects processed transaction totals', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/transaction', validTransaction());
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_test_3', receiver_id: 'u_test_4' }));

    const res = await request(server, 'GET', '/analytics/summary');
    assert.equal(res.status, 200);
    assert.equal(res.body.total_processed, 2);
    assert.equal(res.body.allowed + res.body.step_up + res.body.blocked, 2);
    assert.equal(typeof res.body.avg_latency_ms, 'number');
  } finally {
    server.close();
  }
});

test('GET /analytics/top-frauds: counts flag types across transactions', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_frauds_test' });
    for (let i = 0; i < 6; i += 1) {
      await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_frauds_test', receiver_id: `u_${i}` }));
    }

    const res = await request(server, 'GET', '/analytics/top-frauds?limit=5');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.some((r) => r.count > 0));
  } finally {
    server.close();
  }
});

test('GET /analytics/top-risky: rejects an invalid dimension and accepts a valid one', async () => {
  const { server } = await freshServer();
  try {
    const invalid = await request(server, 'GET', '/analytics/top-risky?dimension=not_real');
    assert.equal(invalid.status, 400);

    await request(server, 'POST', '/business-accounts', { account_id: 'm_risky_test' });
    for (let i = 0; i < 6; i += 1) {
      await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_risky_test', receiver_id: `u_risky_${i}` }));
    }

    const merchants = await request(server, 'GET', '/analytics/top-risky?dimension=merchants');
    assert.equal(merchants.status, 200);
    assert.ok(merchants.body.some((r) => r.key === 'm_risky_test'));
  } finally {
    server.close();
  }
});

test('GET /analytics/mule-accounts: returns accounts with a qualifying receive-then-drain pattern', async () => {
  const { server } = await freshServer();
  try {
    // u_mule_test receives 1000 twice, draining ~90% each time within the mule window.
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_a', receiver_id: 'u_mule_test', amount: 1000, timestamp: '2026-07-18T09:00:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_mule_test', receiver_id: 'u_downstream_1', amount: 900, timestamp: '2026-07-18T09:05:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_b', receiver_id: 'u_mule_test', amount: 1000, timestamp: '2026-07-18T09:10:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_mule_test', receiver_id: 'u_downstream_2', amount: 950, timestamp: '2026-07-18T09:15:00Z' }));

    const res = await request(server, 'GET', '/analytics/mule-accounts');
    assert.equal(res.status, 200);
    assert.ok(res.body.some((r) => r.account_id === 'u_mule_test'));
  } finally {
    server.close();
  }
});

test('GET /analytics/mule-accounts: excludes the business\'s own registered accounts (regression)', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_mule_exclude_test' });
    // The business account receives customer payments and pays most of it back out via
    // refunds -- ordinary operation, satisfying the generic heuristic by construction.
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_a', receiver_id: 'm_mule_exclude_test', amount: 1000, timestamp: '2026-07-18T09:00:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_mule_exclude_test', receiver_id: 'u_b', amount: 900, purpose: 'Refund', timestamp: '2026-07-18T09:05:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_c', receiver_id: 'm_mule_exclude_test', amount: 1000, timestamp: '2026-07-18T09:10:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_mule_exclude_test', receiver_id: 'u_d', amount: 950, purpose: 'Refund', timestamp: '2026-07-18T09:15:00Z' }));

    const res = await request(server, 'GET', '/analytics/mule-accounts');
    assert.equal(res.status, 200);
    assert.ok(!res.body.some((r) => r.account_id === 'm_mule_exclude_test'));
  } finally {
    server.close();
  }
});

test('GET /analytics/gateway-comparison: aggregates by merchant_id', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/transaction', validTransaction({ merchant_id: 'gw_x' }));
    await request(server, 'POST', '/transaction', validTransaction({ merchant_id: 'gw_y', sender_id: 'u_5', receiver_id: 'u_6' }));

    const res = await request(server, 'GET', '/analytics/gateway-comparison');
    assert.equal(res.status, 200);
    const gateways = res.body.map((r) => r.merchant_id);
    assert.ok(gateways.includes('gw_x') && gateways.includes('gw_y'));
  } finally {
    server.close();
  }
});

test('GET /analytics/trend: buckets by the requested granularity', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/transaction', validTransaction());

    const hourly = await request(server, 'GET', '/analytics/trend?bucket=hour');
    assert.equal(hourly.status, 200);
    assert.equal(hourly.body.bucket, 'hour');
    assert.ok(Array.isArray(hourly.body.buckets));

    const invalidFallsBackToDay = await request(server, 'GET', '/analytics/trend?bucket=not_real');
    assert.equal(invalidFallsBackToDay.body.bucket, 'day');
  } finally {
    server.close();
  }
});

test('GET /analytics/export: supports both json and csv formats', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/transaction', validTransaction());

    const json = await request(server, 'GET', '/analytics/export?format=json');
    assert.equal(json.status, 200);
    assert.ok(Array.isArray(json.body));
    assert.ok(json.body.length >= 1);

    const csv = await request(server, 'GET', '/analytics/export?format=csv');
    assert.equal(csv.status, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(String(csv.body), /transaction_id,sender_id/);
  } finally {
    server.close();
  }
});

test('GET /analytics/export?format=excel: returns a real .xlsx file (Section 16, Category 18)', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/transaction', validTransaction());

    const excel = await request(server, 'GET', '/analytics/export?format=excel');
    assert.equal(excel.status, 200);
    assert.match(excel.headers['content-type'], /spreadsheetml/);
    assert.match(excel.headers['content-disposition'], /sentinelpay-export\.xlsx/);
    // ZIP files (which .xlsx always is) start with the two-byte magic "PK" -- a real smoke check
    // that this is genuinely a binary spreadsheet, not an error page or empty body. Full
    // structural validation (a valid ZIP + correct OOXML parts) is covered directly against the
    // Buffer output in tests/xlsxWriter.test.js, including cross-checking with Python's
    // independent zipfile module.
    assert.equal(String(excel.body).slice(0, 2), 'PK');
  } finally {
    server.close();
  }
});

test('analytics routes require an API key', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/analytics/summary', null, { 'X-API-Key': undefined });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
