// Section 16, Category 13/14 (investigation notes) and Category 20/21 (admin audit log). Same
// freshServer/request harness as tests/fraudLists.test.js.
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

// ---- Investigation notes ----

test('POST /investigation-notes: valid input returns 201 and round-trips through GET', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/transaction', validTransaction());
    const note = await request(server, 'POST', '/investigation-notes', {
      transaction_id: posted.body.transaction_id,
      note: 'Confirmed with customer -- legitimate transaction.',
      author: 'analyst_1',
    });
    assert.equal(note.status, 201);
    assert.ok(note.body.note_id);

    const res = await request(server, 'GET', `/investigation-notes?transaction_id=${posted.body.transaction_id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].author, 'analyst_1');
  } finally {
    server.close();
  }
});

test('POST /investigation-notes: rejects a note for a nonexistent transaction', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/investigation-notes', { transaction_id: 't_does_not_exist', note: 'test' });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('POST /investigation-notes: rejects a missing note', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/transaction', validTransaction());
    const res = await request(server, 'POST', '/investigation-notes', { transaction_id: posted.body.transaction_id });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('GET /investigation-notes: requires a transaction_id query param', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/investigation-notes');
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('investigation-notes routes require an API key', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/investigation-notes?transaction_id=t_1', null, { 'X-API-Key': undefined });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

// ---- Admin audit log ----

test('GET /admin-audit-log: records business-account and fraud-list mutations', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_audit_test' });
    await request(server, 'POST', '/fraud-lists', { list_type: 'blacklist', account_id: 'u_audit_test', reason: 'test' });
    await request(server, 'DELETE', '/business-accounts/m_audit_test');

    const res = await request(server, 'GET', '/admin-audit-log');
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 3);
    assert.ok(res.body.some((r) => r.action === 'create' && r.target_type === 'business_account' && r.target_id === 'm_audit_test'));
    assert.ok(res.body.some((r) => r.action === 'create' && r.target_type === 'fraud_list:blacklist' && r.target_id === 'u_audit_test'));
    assert.ok(res.body.some((r) => r.action === 'delete' && r.target_type === 'business_account' && r.target_id === 'm_audit_test'));
  } finally {
    server.close();
  }
});

test('admin-audit-log route requires an API key', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/admin-audit-log', null, { 'X-API-Key': undefined });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
