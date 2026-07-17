const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.API_KEY = 'test-key-for-automated-tests';

function freshServer() {
  // Also clear rateLimit.js's (and websocket.js's, which captures a reference to it) cache, not
  // just server/index.js's own — rateLimit.js reads RATE_LIMIT_MAX_PER_MINUTE once at module-load
  // time into a module-level constant, so a stale cached instance would silently ignore an env
  // var change made between tests (see the rate-limit regression tests below, which rely on this).
  delete require.cache[require.resolve('../server/index')];
  delete require.cache[require.resolve('../server/middleware/rateLimit')];
  delete require.cache[require.resolve('../server/websocket')];
  const { app, server } = require('../server/index');
  return new Promise((resolve) => {
    if (server.listening) return resolve({ app, server });
    server.once('listening', () => resolve({ app, server }));
  });
}

// `headerOverrides` merges over the default headers; setting a key to `undefined` removes it
// entirely (used by the auth regression tests below to send a request with no X-API-Key at all,
// rather than each hand-rolling a second raw http.request call).
function request(server, method, path, body, headerOverrides = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY, ...headerOverrides };
    for (const key of Object.keys(headers)) {
      if (headers[key] === undefined) delete headers[key];
    }
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers },
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
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
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

test('POST /transaction: purpose round-trips through GET /transactions (merchant-initiated refund)', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({
        sender_id: 'm_test_merchant',
        receiver_id: 'u_test_customer',
        purpose: 'Refund - order #482913',
      })
    );
    assert.equal(posted.status, 201);

    const res = await request(server, 'GET', '/transactions?limit=10');
    const found = res.body.find((t) => t.transaction_id === posted.body.transaction_id);
    assert.ok(found, 'expected the posted transaction to appear in GET /transactions');
    assert.equal(found.purpose, 'Refund - order #482913');
    assert.equal(found.merchant_id, 'm_test');
  } finally {
    server.close();
  }
});

test('POST /transaction: purpose is optional and defaults to null when omitted', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/transaction', validTransaction());
    const res = await request(server, 'GET', '/transactions?limit=10');
    const found = res.body.find((t) => t.transaction_id === posted.body.transaction_id);
    assert.equal(found.purpose, null);
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

// ---- Security regression: every route requires a valid API key ----

test('POST /transaction: rejects a request with no X-API-Key header', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/transaction', validTransaction(), { 'X-API-Key': undefined });
    assert.equal(res.status, 401);
    assert.equal(typeof res.body.error, 'string');
  } finally {
    server.close();
  }
});

test('GET /transactions: rejects a request with the wrong X-API-Key', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/transactions', null, { 'X-API-Key': 'not-the-right-key' });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('GET /health: does not require an API key (liveness check stays open)', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/health', null, { 'X-API-Key': undefined });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('every response carries the standard security headers (regression)', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/health', null, { 'X-API-Key': undefined });
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  } finally {
    server.close();
  }
});

// ---- Auth-scoping regression: static dashboard assets must be servable with no API key at all,
// since <link>/<script src> tags can't attach the X-API-Key header the way authFetch()'s fetch()
// calls can ----

test('dashboard static assets (style.css, app.js, map.js, audit.js) are servable with no API key (regression)', async () => {
  // Regression, found live in an actual browser (not curl): requireApiKey was originally mounted
  // via `app.use('/', requireApiKey, transactionsRouter)` in server/index.js, which runs for
  // *every* request reaching that layer — not just paths transactionsRouter actually defines a
  // route for. That rejected the dashboard's own stylesheet and scripts with 401 before they
  // could ever reach express.static, since browsers don't attach custom headers to <link>/<script
  // src> loads. The entire dashboard rendered unstyled and inert as a result — no test in this
  // suite caught it because every existing test talks to the API directly, never loads the actual
  // HTML page and its sub-resources the way a browser does. Fixed by scoping requireApiKey to
  // each individual route inside server/routes/transactions.js instead of the whole router mount.
  const { server } = await freshServer();
  try {
    for (const asset of ['/style.css', '/app.js', '/map.js', '/audit.js']) {
      const res = await request(server, 'GET', asset, null, { 'X-API-Key': undefined });
      assert.equal(res.status, 200, `expected ${asset} to be servable with no API key, got ${res.status}`);
    }
  } finally {
    server.close();
  }
});

test('the dashboard shell (GET /) is servable with no API key, but the API routes it calls still require one (regression)', async () => {
  const { server } = await freshServer();
  try {
    const shell = await request(server, 'GET', '/', null, { 'X-API-Key': undefined });
    assert.equal(shell.status, 200);
    assert.match(shell.body, /sentinelpay-api-key/, 'expected the API key to be injected into the served HTML');

    const unauthedApi = await request(server, 'GET', '/transactions', null, { 'X-API-Key': undefined });
    assert.equal(unauthedApi.status, 401, 'the actual API routes must still require a key even though the shell page does not');
  } finally {
    server.close();
  }
});

// ---- Rate-limit regression: the limiter actually rejects over-cap traffic over real HTTP, and
// covers the dashboard-serving routes too, not just the API router it was originally scoped to ----

test('rate limiting rejects with 429 once a single IP exceeds the cap, over a real HTTP connection (regression)', async () => {
  const originalLimit = process.env.RATE_LIMIT_MAX_PER_MINUTE;
  process.env.RATE_LIMIT_MAX_PER_MINUTE = '5'; // small on purpose so this test runs fast
  try {
    const { server } = await freshServer();
    try {
      const results = [];
      for (let i = 0; i < 7; i += 1) {
        results.push(await request(server, 'GET', '/transactions'));
      }
      const statuses = results.map((r) => r.status);
      assert.ok(statuses.slice(0, 5).every((s) => s === 200), `expected the first 5 requests to succeed, got ${statuses}`);
      assert.ok(statuses.slice(5).every((s) => s === 429), `expected requests past the cap to be rejected, got ${statuses}`);
    } finally {
      server.close();
    }
  } finally {
    if (originalLimit === undefined) delete process.env.RATE_LIMIT_MAX_PER_MINUTE;
    else process.env.RATE_LIMIT_MAX_PER_MINUTE = originalLimit;
  }
});

test('rate limiting also covers the dashboard-serving routes (GET /), not just the API router (regression)', async () => {
  // Regression: rate limiting was originally scoped only to `transactionsRouter`, leaving GET /
  // and GET /index.html (which does real per-request work — reading and templating the dashboard
  // HTML) completely unthrottled.
  const originalLimit = process.env.RATE_LIMIT_MAX_PER_MINUTE;
  process.env.RATE_LIMIT_MAX_PER_MINUTE = '3';
  try {
    const { server } = await freshServer();
    try {
      const results = [];
      for (let i = 0; i < 5; i += 1) {
        results.push(await request(server, 'GET', '/', null, { 'X-API-Key': undefined }));
      }
      const statuses = results.map((r) => r.status);
      assert.ok(statuses.slice(0, 3).every((s) => s === 200), `expected the first 3 requests to succeed, got ${statuses}`);
      assert.ok(statuses.slice(3).every((s) => s === 429), `expected requests past the cap to be rejected, got ${statuses}`);
    } finally {
      server.close();
    }
  } finally {
    if (originalLimit === undefined) delete process.env.RATE_LIMIT_MAX_PER_MINUTE;
    else process.env.RATE_LIMIT_MAX_PER_MINUTE = originalLimit;
  }
});

test('GET /health stays exempt from rate limiting even after the cap is exceeded elsewhere (regression)', async () => {
  const originalLimit = process.env.RATE_LIMIT_MAX_PER_MINUTE;
  process.env.RATE_LIMIT_MAX_PER_MINUTE = '2';
  try {
    const { server } = await freshServer();
    try {
      for (let i = 0; i < 4; i += 1) {
        await request(server, 'GET', '/transactions'); // exhaust the (shared, per-IP) budget
      }
      const health = await request(server, 'GET', '/health', null, { 'X-API-Key': undefined });
      assert.equal(health.status, 200, '/health must stay reachable regardless of rate-limit state elsewhere');
    } finally {
      server.close();
    }
  } finally {
    if (originalLimit === undefined) delete process.env.RATE_LIMIT_MAX_PER_MINUTE;
    else process.env.RATE_LIMIT_MAX_PER_MINUTE = originalLimit;
  }
});

// ---- Validation regression: amount now has a sane upper bound ----

test('POST /transaction: rejects an amount above the sanity cap', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/transaction', validTransaction({ amount: 1e300 }));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /amount/);
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
