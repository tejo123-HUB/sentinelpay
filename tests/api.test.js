const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';

function freshServer() {
  delete require.cache[require.resolve('../server/index')];
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
  const { server } = await freshServer();
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
  const { server } = await freshServer();
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
  const { server } = await freshServer();
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

test('GET /transactions includes each transaction\'s flag reasons', async () => {
  const { server } = await freshServer();
  try {
    // Same 5-transaction-in-60s burst pattern used elsewhere to reliably trip velocity.
    for (let i = 0; i < 6; i += 1) {
      await request(server, 'POST', '/transaction', validTransaction({ timestamp: `2026-07-18T10:15:0${i}Z` }));
    }
    const res = await request(server, 'GET', '/transactions?limit=10');
    const flagged = res.body.find((t) => t.reasons && t.reasons.length > 0);
    assert.ok(flagged, 'expected at least one transaction with reasons after a velocity burst');
    assert.match(flagged.reasons[0], /transactions in/);
  } finally {
    server.close();
  }
});

test('GET /transactions?decision= filters correctly and rejects an invalid value', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/transaction', validTransaction());

    const allowOnly = await request(server, 'GET', '/transactions?decision=allow');
    assert.ok(allowOnly.body.every((t) => t.decision === 'allow'));

    const noBlocks = await request(server, 'GET', '/transactions?decision=block');
    assert.equal(noBlocks.body.length, 0);

    const invalid = await request(server, 'GET', '/transactions?decision=not_a_real_decision');
    assert.equal(invalid.status, 400);
  } finally {
    server.close();
  }
});

test('GET /transactions?decision= handles a repeated query param, not just a single value (regression)', async () => {
  // Regression test: Express parses ?decision=block&decision=allow as an array, not a string.
  // Without normalizing that, the `typeof === 'string'` check silently failed and returned
  // every transaction unfiltered, instead of filtering by both values or rejecting the request.
  // Uses a step_up transaction (excluded from the filter below) so an unfiltered response is
  // actually distinguishable from a correctly-filtered one — asserting only "every result is
  // block or allow" would pass even on the buggy code if allow happened to be the only decision
  // present, since allow is itself one of the filtered-for values.
  const { server } = await freshServer();
  try {
    // Same 6-transaction-in-60s burst used elsewhere in this file to reliably trip velocity
    // and land the last one in step_up.
    for (let i = 0; i < 6; i += 1) {
      await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_repeat_filter' }));
    }

    const res = await request(server, 'GET', '/transactions?decision=block&decision=allow');
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0, 'expected at least the allow-decision transactions to be present');
    assert.ok(
      res.body.every((t) => t.decision !== 'step_up'),
      'the step_up transaction must be excluded by the decision=block&decision=allow filter'
    );
  } finally {
    server.close();
  }
});

test('GET /audit/summary buckets transactions by time and decision', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/transaction', validTransaction());
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_test_3' }));

    const res = await request(server, 'GET', '/audit/summary?hours=24&bucketMinutes=60');
    assert.equal(res.status, 200);
    assert.equal(res.body.totalTransactions, 2);
    assert.ok(Array.isArray(res.body.buckets));
    assert.ok(res.body.buckets.length >= 1);
    const total = res.body.buckets.reduce((s, b) => s + b.allow + b.step_up + b.block, 0);
    assert.equal(total, 2);
  } finally {
    server.close();
  }
});

// ---- Security regression: client-supplied timestamp must not defeat time-window checks ----

test('POST /transaction: a future-dated client timestamp cannot bypass an active structuring alert', async () => {
  const { app, server } = await freshServer();
  try {
    const db = app.locals.db;
    const senderId = 'u_evader';
    const receiverId = 'u_evader_target';

    // Seed both accounts and an active structuring alert directly, as the background job would
    // have created moments earlier from a real detected pattern.
    db.prepare('INSERT INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run(
      senderId,
      new Date().toISOString()
    );
    db.prepare('INSERT INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run(
      receiverId,
      new Date().toISOString()
    );
    db.prepare(
      `INSERT INTO structuring_alerts
        (alert_id, sender_id, receiver_ids, total_amount, transaction_count, window_start, window_end, withdrawal_ratio, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'sa_test_1',
      senderId,
      JSON.stringify([receiverId]),
      24000,
      6,
      new Date().toISOString(),
      new Date().toISOString(),
      0.85,
      'test seeded structuring alert',
      new Date().toISOString()
    );

    // Attacker claims a timestamp far in the future, attempting to shift the alert-lookup's
    // "active window" cutoff forward past the alert's real created_at, evading the block.
    const farFutureTimestamp = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 5).toISOString();

    const res = await request(server, 'POST', '/transaction', {
      sender_id: senderId,
      receiver_id: receiverId,
      amount: 50,
      timestamp: farFutureTimestamp,
      transaction_type: 'transfer',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.decision, 'block', 'a manipulated future timestamp must not evade the structuring alert');
    assert.ok(res.body.fraud_score > 80);
  } finally {
    server.close();
  }
});

test('POST /transaction: the stored timestamp is server-received time, not the client-supplied value', async () => {
  const { server } = await freshServer();
  try {
    const beforeMs = Date.now();
    await request(server, 'POST', '/transaction', validTransaction({ timestamp: '2099-01-01T00:00:00Z' }));
    const afterMs = Date.now();

    const res = await request(server, 'GET', '/transactions?limit=1');
    const storedMs = new Date(res.body[0].timestamp).getTime();

    assert.ok(
      storedMs >= beforeMs && storedMs <= afterMs,
      `expected stored timestamp to be server-received time (between ${beforeMs} and ${afterMs}), got ${storedMs}`
    );
  } finally {
    server.close();
  }
});
