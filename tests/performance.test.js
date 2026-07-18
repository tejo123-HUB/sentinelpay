// Section 17 (FA242, Performance Tests): wires a real latency assertion into the automated suite
// (`npm test`), so a genuine performance regression fails CI instead of only showing up if someone
// remembers to run simulator/benchmark.js or simulator/loadTest.js by hand. Deliberately
// lightweight (tens of transactions, not simulator/loadTest.js's sustained-concurrency run) --
// this is a regression guard against gross slowdowns (e.g. an accidentally unindexed query added
// to the hot path), not a substitute for the dedicated load-test tooling.
//
// Asserts against transactions.latency_ms (server-side processing time only, recorded by
// server/routes/transactions.js) via GET /analytics/summary's avg_latency_ms -- not client-side
// wall-clock round-trip time, which would also bundle in Node's HTTP stack and this test
// environment's own overhead, making the threshold less meaningful and more flaky.
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

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY };
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
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// architecture.md Section 11's own stated target -- this is a genuine regression guard tied to a
// real project commitment, not an arbitrary number.
const LATENCY_TARGET_MS = 150;

test('POST /transaction: average server-side processing latency stays under the 150ms target (Section 11) across a realistic batch', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_perf_test' });

    // 30 outbound transactions -- enough to exercise the full rule+structuring+ML pipeline
    // repeatedly (not just a single cold-cache request) while staying fast enough not to slow
    // down `npm test` noticeably.
    for (let i = 0; i < 30; i += 1) {
      const res = await request(server, 'POST', '/transaction', {
        sender_id: 'm_perf_test',
        receiver_id: `u_perf_${i % 5}`,
        amount: 50 + i,
        timestamp: new Date(Date.now() - (30 - i) * 1000).toISOString(),
        device_id: `d_perf_${i}`,
        merchant_id: 'm_perf_gateway',
        transaction_type: 'transfer',
      });
      assert.equal(res.status, 201);
    }

    const summary = await request(server, 'GET', '/analytics/summary');
    assert.equal(summary.status, 200);
    assert.equal(summary.body.total_processed, 30);
    assert.ok(
      summary.body.avg_latency_ms < LATENCY_TARGET_MS,
      `expected avg_latency_ms < ${LATENCY_TARGET_MS}, got ${summary.body.avg_latency_ms}`
    );
  } finally {
    server.close();
  }
});
