const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';

function freshServer() {
  delete require.cache[require.resolve('../server/index')];
  const { server } = require('../server/index');
  return new Promise((resolve) => {
    if (server.listening) return resolve(server);
    server.once('listening', () => resolve(server));
  });
}

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
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
    location: { lat: 16.5062, lng: 80.648 },
    device_id: 'd_test',
    merchant_id: 'm_test',
    transaction_type: 'transfer',
    ...overrides,
  };
}

test('POST /transaction: valid input returns 201 with a populated score and decision', async () => {
  const server = await freshServer();
  try {
    const res = await request(server, 'POST', '/transaction', validTransaction());
    assert.equal(res.status, 201);
    assert.ok(res.body.transaction_id);
    assert.equal(typeof res.body.fraud_score, 'number');
    assert.ok(['allow', 'step_up', 'block'].includes(res.body.decision));
    assert.ok(Array.isArray(res.body.reasons));
  } finally {
    server.close();
  }
});

test('POST /transaction: missing required fields returns 400 with a clear message', async () => {
  const server = await freshServer();
  try {
    const res = await request(server, 'POST', '/transaction', { sender_id: 'u_1' });
    assert.equal(res.status, 400);
    assert.equal(typeof res.body.error, 'string');
    assert.ok(res.body.error.length > 0);
  } finally {
    server.close();
  }
});

test('GET /transactions and GET /alerts respond with arrays', async () => {
  const server = await freshServer();
  try {
    await request(server, 'POST', '/transaction', validTransaction());
    const tx = await request(server, 'GET', '/transactions?limit=10');
    const alerts = await request(server, 'GET', '/alerts');
    assert.ok(Array.isArray(tx.body));
    assert.ok(tx.body.length >= 1);
    assert.ok(Array.isArray(alerts.body));
  } finally {
    server.close();
  }
});
