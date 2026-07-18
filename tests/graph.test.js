// Section 17 (FA041/FA043/FA044/FA045/FA053): end-to-end coverage for GET /graph/relationships.
// Same freshServer/request harness as tests/newIngestionRoutes.test.js.
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

test('GET /graph/relationships: rejects a missing account_id', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/graph/relationships');
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('GET /graph/relationships requires an API key', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/graph/relationships?account_id=u_a', null, { 'X-API-Key': undefined });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('GET /graph/relationships: an unknown account still returns a valid empty-ish graph (just the root node)', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/graph/relationships?account_id=u_never_seen');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.nodes, [{ id: 'u_never_seen', type: 'root' }]);
    assert.deepEqual(res.body.edges, []);
  } finally {
    server.close();
  }
});

test('GET /graph/relationships: direct transaction edges are aggregated by counterparty, not one row per transaction', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_graph_a', receiver_id: 'u_graph_b', amount: 100, timestamp: '2026-07-18T09:00:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_graph_a', receiver_id: 'u_graph_b', amount: 150, timestamp: '2026-07-18T09:05:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_graph_c', receiver_id: 'u_graph_a', amount: 50, timestamp: '2026-07-18T09:10:00Z' }));

    const res = await request(server, 'GET', '/graph/relationships?account_id=u_graph_a');
    assert.equal(res.status, 200);

    const nodeIds = res.body.nodes.map((n) => n.id).sort();
    assert.deepEqual(nodeIds, ['u_graph_a', 'u_graph_b', 'u_graph_c']);

    const aToB = res.body.edges.find((e) => e.source === 'u_graph_a' && e.target === 'u_graph_b');
    assert.ok(aToB);
    assert.equal(aToB.count, 2);
    assert.equal(aToB.total_amount, 250);

    const cToA = res.body.edges.find((e) => e.source === 'u_graph_c' && e.target === 'u_graph_a');
    assert.ok(cToA);
    assert.equal(cToA.count, 1);
  } finally {
    server.close();
  }
});

test('GET /graph/relationships: a shared device_id produces a shared_device edge to the other account', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_shared_a', receiver_id: 'u_other_1', device_id: 'd_shared_graph', timestamp: '2026-07-18T09:00:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_shared_b', receiver_id: 'u_other_2', device_id: 'd_shared_graph', timestamp: '2026-07-18T09:05:00Z' }));

    const res = await request(server, 'GET', '/graph/relationships?account_id=u_shared_a');
    assert.equal(res.status, 200);

    const sharedEdge = res.body.edges.find((e) => e.type === 'shared_device' && e.target === 'u_shared_b');
    assert.ok(sharedEdge);
    assert.equal(sharedEdge.detail, 'd_shared_graph');
    assert.ok(res.body.nodes.some((n) => n.id === 'u_shared_b'));
  } finally {
    server.close();
  }
});

test('GET /graph/relationships?depth=2: expands one more transaction hop beyond direct counterparties', async () => {
  const { server } = await freshServer();
  try {
    // u_depth_a -> u_depth_b -> u_depth_c: a chain. depth=1 from a sees only b; depth=2 also sees c.
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_depth_a', receiver_id: 'u_depth_b', timestamp: '2026-07-18T09:00:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_depth_b', receiver_id: 'u_depth_c', timestamp: '2026-07-18T09:05:00Z' }));

    const shallow = await request(server, 'GET', '/graph/relationships?account_id=u_depth_a&depth=1');
    assert.ok(!shallow.body.nodes.some((n) => n.id === 'u_depth_c'));

    const deep = await request(server, 'GET', '/graph/relationships?account_id=u_depth_a&depth=2');
    assert.equal(deep.status, 200);
    assert.equal(deep.body.depth, 2);
    assert.ok(deep.body.nodes.some((n) => n.id === 'u_depth_c'));
  } finally {
    server.close();
  }
});

test('GET /graph/relationships: an invalid depth value falls back to the default (1)', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/graph/relationships?account_id=u_x&depth=99');
    assert.equal(res.status, 200);
    assert.equal(res.body.depth, 1);
  } finally {
    server.close();
  }
});
