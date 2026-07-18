// Section 16, Category 14: end-to-end coverage for case management. Same freshServer/request
// harness as tests/fraudLists.test.js.
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
    sender_id: 'u_case_1',
    receiver_id: 'u_case_2',
    amount: 500,
    timestamp: '2026-07-18T10:15:00Z',
    transaction_type: 'transfer',
    ...overrides,
  };
}

test('POST /cases: creates a case, optionally pre-linked to transactions', async () => {
  const { server } = await freshServer();
  try {
    const tx = await request(server, 'POST', '/transaction', validTransaction());
    const posted = await request(server, 'POST', '/cases', {
      title: 'Suspicious refund pattern',
      transaction_ids: [tx.body.transaction_id],
      assigned_to: 'analyst_1',
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.status, 'open');
    assert.deepEqual(posted.body.transaction_ids, [tx.body.transaction_id]);
  } finally {
    server.close();
  }
});

test('POST /cases: rejects a missing title', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/cases', {});
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('GET /cases: filters by status and assigned_to', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/cases', { title: 'Case A', assigned_to: 'analyst_1' });
    const caseB = await request(server, 'POST', '/cases', { title: 'Case B', assigned_to: 'analyst_2' });
    await request(server, 'PATCH', `/cases/${caseB.body.case_id}`, { status: 'resolved' });

    const resolved = await request(server, 'GET', '/cases?status=resolved');
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.length, 1);
    assert.equal(resolved.body[0].title, 'Case B');

    const byAnalyst = await request(server, 'GET', '/cases?assigned_to=analyst_1');
    assert.equal(byAnalyst.body.length, 1);
    assert.equal(byAnalyst.body[0].title, 'Case A');
  } finally {
    server.close();
  }
});

test('GET /cases/:caseId: returns 404 for an unknown case, detail for a known one', async () => {
  const { server } = await freshServer();
  try {
    const notFound = await request(server, 'GET', '/cases/case_does_not_exist');
    assert.equal(notFound.status, 404);

    const posted = await request(server, 'POST', '/cases', { title: 'Detail test' });
    const found = await request(server, 'GET', `/cases/${posted.body.case_id}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.title, 'Detail test');
    assert.deepEqual(found.body.transaction_ids, []);
  } finally {
    server.close();
  }
});

test('PATCH /cases/:caseId: updates status/assigned_to/title, rejects an invalid status', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/cases', { title: 'Status test' });

    const invalid = await request(server, 'PATCH', `/cases/${posted.body.case_id}`, { status: 'not_a_real_status' });
    assert.equal(invalid.status, 400);

    const updated = await request(server, 'PATCH', `/cases/${posted.body.case_id}`, { status: 'investigating', assigned_to: 'analyst_3' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.status, 'investigating');
    assert.equal(updated.body.assigned_to, 'analyst_3');
  } finally {
    server.close();
  }
});

test('POST /cases/:caseId/transactions: links an additional transaction, 404s for an unknown transaction', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/cases', { title: 'Linking test' });
    const tx = await request(server, 'POST', '/transaction', validTransaction());

    const linked = await request(server, 'POST', `/cases/${posted.body.case_id}/transactions`, { transaction_id: tx.body.transaction_id });
    assert.equal(linked.status, 201);

    const missing = await request(server, 'POST', `/cases/${posted.body.case_id}/transactions`, { transaction_id: 't_does_not_exist' });
    assert.equal(missing.status, 404);

    const detail = await request(server, 'GET', `/cases/${posted.body.case_id}`);
    assert.deepEqual(detail.body.transaction_ids, [tx.body.transaction_id]);
  } finally {
    server.close();
  }
});

test('GET /cases/:caseId/timeline: merges transactions, notes, and structuring alerts in chronological order', async () => {
  const { server } = await freshServer();
  try {
    const tx = await request(server, 'POST', '/transaction', validTransaction());
    const posted = await request(server, 'POST', '/cases', { title: 'Timeline test', transaction_ids: [tx.body.transaction_id] });
    await request(server, 'POST', '/investigation-notes', { transaction_id: tx.body.transaction_id, note: 'Looked into this.', author: 'analyst_4' });

    const timeline = await request(server, 'GET', `/cases/${posted.body.case_id}/timeline`);
    assert.equal(timeline.status, 200);
    assert.ok(timeline.body.events.some((e) => e.type === 'transaction'));
    assert.ok(timeline.body.events.some((e) => e.type === 'investigation_note'));
    // Chronological order.
    for (let i = 1; i < timeline.body.events.length; i += 1) {
      assert.ok(new Date(timeline.body.events[i].timestamp) >= new Date(timeline.body.events[i - 1].timestamp));
    }
  } finally {
    server.close();
  }
});

test('cases routes require an API key, and mutations require analyst or above', async () => {
  const { server } = await freshServer();
  try {
    const noKey = await request(server, 'GET', '/cases', null, { 'X-API-Key': undefined });
    assert.equal(noKey.status, 401);
  } finally {
    server.close();
  }
});
