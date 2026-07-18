// Dynamic Risk Engine, end-to-end: proves the adaptive-baseline rework (server/adaptiveBaseline.js
// + velocity.js/amountAnomaly.js/multipleRefundDetection.js) actually changes live scoring
// outcomes through the real POST /transaction pipeline, not just in isolated unit tests. Same
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

test('Dynamic Risk Engine: the same absolute transaction rate is normal for a high-throughput account and flagged for a low-throughput one', async () => {
  const { app, server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_fast_biz' });
    await request(server, 'POST', '/business-accounts', { account_id: 'm_slow_biz' });

    // Seed each account's own interval baseline directly in the DB, the same way this project's
    // own scripts/generate_demo_data.js has to for any "established history over time" scenario:
    // POST /transaction deliberately overrides any client-supplied timestamp with server-received
    // time (architecture.md Section 15.2, a real security fix -- a caller can't backdate a
    // transaction's scoring window through the live API), so there is no way to build a genuinely
    // time-spread history through HTTP calls made a few milliseconds apart in a test.
    const { updateBaseline } = require('../server/adaptiveBaseline');
    const db = app.locals.db;
    const seedTime = '2026-07-18T09:00:00Z';
    // m_fast_biz: genuinely rapid, consistent pace (~3s apart).
    for (let i = 0; i < 10; i += 1) updateBaseline(db, 'm_fast_biz', 'interval', 3000, seedTime);
    // m_slow_biz: genuinely slow, consistent pace (~20 minutes apart).
    for (let i = 0; i < 10; i += 1) updateBaseline(db, 'm_slow_biz', 'interval', 20 * 60 * 1000, seedTime);

    // Now send the *identical* rapid burst (3 live transactions in quick succession -- the
    // minimum that clears VELOCITY_MIN_BURST_COUNT) to both. Deliberately short: each subsequent
    // transaction in the burst also *updates* the interval baseline with its own real (fast)
    // inter-request gap, same as genuine production traffic would -- a burst long enough will
    // eventually dilute the seeded baseline it's being compared against. Three is enough to prove
    // the point without fighting that self-correction.
    let fastLastResult;
    for (let i = 0; i < 3; i += 1) {
      fastLastResult = await request(server, 'POST', '/transaction', {
        sender_id: 'm_fast_biz',
        receiver_id: `u_fast_burst_${i}`,
        amount: 50,
        timestamp: '2026-07-18T12:00:00Z', // ignored by the server by design; real request timing governs
        merchant_id: 'm_gw_a',
        transaction_type: 'transfer',
      });
    }
    let slowLastResult;
    for (let i = 0; i < 3; i += 1) {
      slowLastResult = await request(server, 'POST', '/transaction', {
        sender_id: 'm_slow_biz',
        receiver_id: `u_slow_burst_${i}`,
        amount: 50,
        timestamp: '2026-07-18T12:00:00Z',
        merchant_id: 'm_gw_a',
        transaction_type: 'transfer',
      });
    }

    assert.ok(!fastLastResult.body.reasons.some((r) => r.includes('faster than this account')), 'the fast account\'s own normal pace must not be flagged as a velocity anomaly');
    assert.ok(slowLastResult.body.reasons.some((r) => r.includes('faster than this account')), 'the slow account bursting at the fast account\'s normal pace must be flagged for *them*');
  } finally {
    server.close();
  }
});

test('Dynamic Risk Engine: the same outlier amount is flagged for a low-variance spender and allowed for a high-variance one', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_tight_spender' });
    await request(server, 'POST', '/business-accounts', { account_id: 'm_wide_spender' });

    const base = Date.parse('2026-07-18T09:00:00Z');
    // m_tight_spender: consistently pays out close to 500, every time.
    const tightAmounts = [490, 505, 495, 510, 500, 495, 505];
    for (let i = 0; i < tightAmounts.length; i += 1) {
      await request(server, 'POST', '/transaction', {
        sender_id: 'm_tight_spender',
        receiver_id: `u_tight_${i}`,
        amount: tightAmounts[i],
        timestamp: new Date(base + i * 3600 * 1000).toISOString(),
        merchant_id: 'm_gw_a',
        transaction_type: 'transfer',
      });
    }
    // m_wide_spender: same average (~500), but routinely swings from near-0 to 2000+.
    const wideAmounts = [50, 1900, 300, 1600, 900, 100, 1650];
    for (let i = 0; i < wideAmounts.length; i += 1) {
      await request(server, 'POST', '/transaction', {
        sender_id: 'm_wide_spender',
        receiver_id: `u_wide_${i}`,
        amount: wideAmounts[i],
        timestamp: new Date(base + i * 3600 * 1000).toISOString(),
        merchant_id: 'm_gw_a',
        transaction_type: 'transfer',
      });
    }

    // Same test payout (1800) to both -- roughly 3.6x each account's own average.
    const tightResult = await request(server, 'POST', '/transaction', {
      sender_id: 'm_tight_spender',
      receiver_id: 'u_tight_test',
      amount: 1800,
      timestamp: new Date(base + 20 * 3600 * 1000).toISOString(),
      merchant_id: 'm_gw_a',
      transaction_type: 'transfer',
    });
    const wideResult = await request(server, 'POST', '/transaction', {
      sender_id: 'm_wide_spender',
      receiver_id: 'u_wide_test',
      amount: 1800,
      timestamp: new Date(base + 20 * 3600 * 1000).toISOString(),
      merchant_id: 'm_gw_a',
      transaction_type: 'transfer',
    });

    assert.ok(tightResult.body.reasons.some((r) => r.includes('average spend')), 'a 1800 payout must be flagged as anomalous for the consistently-~500 spender');
    assert.ok(!wideResult.body.reasons.some((r) => r.includes('average spend')), 'the same 1800 payout must NOT be flagged for the routinely-wide-swinging spender');
  } finally {
    server.close();
  }
});

test('Dynamic Risk Engine: a fast repeat refund is flagged for a pair with no history, but not for a pair whose own pacing is routinely this fast', async () => {
  const { app, server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_refund_biz' });
    const db = app.locals.db;
    const getOutboundContext = require('../server/outboundContext');
    const { updateBaseline } = require('../server/adaptiveBaseline');

    // POST /transaction overrides any client-supplied timestamp with server-received time (same
    // constraint as the velocity/amount tests above), so the "prior refund" row this test needs
    // outboundContext.js's lastRefundToCustomerAt to find is inserted directly, timed relative to
    // *real* now (not a hardcoded date) so the interval math below is deterministic regardless of
    // when this suite actually runs.
    const nowIso = new Date().toISOString();
    const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fiveMinAgoIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    db.prepare('INSERT OR IGNORE INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run('m_refund_biz', nowIso);
    db.prepare('INSERT OR IGNORE INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run('u_routine_refunds', nowIso);
    db.prepare('INSERT OR IGNORE INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run('u_first_time_refund', nowIso);
    // u_routine_refunds' prior refund landed almost exactly one baseline-interval ago -- arriving
    // "on schedule" for this pair's own established hourly rhythm.
    db.prepare(
      `INSERT INTO transactions (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, purpose, decision, fraud_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('t_prior_refund_routine', 'm_refund_biz', 'u_routine_refunds', 100, oneHourAgoIso, 'transfer', 'Refund', 'allow', 0);
    // u_first_time_refund's prior refund was only 5 minutes ago -- suspiciously soon, with no
    // established pattern to say otherwise.
    db.prepare(
      `INSERT INTO transactions (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, purpose, decision, fraud_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('t_prior_refund_first', 'm_refund_biz', 'u_first_time_refund', 100, fiveMinAgoIso, 'transfer', 'Refund', 'allow', 0);

    // u_routine_refunds: this pair's own established pattern is refunds roughly every hour, tightly.
    for (let i = 0; i < 6; i += 1) {
      updateBaseline(db, getOutboundContext.refundBaselineEntityId('m_refund_biz', 'u_routine_refunds'), 'refund_interval', 60 * 60 * 1000, oneHourAgoIso);
    }
    // u_first_time_refund: no established pacing baseline at all -- their first-ever prior
    // refund exists (so a second one has an interval to measure), but no accumulated pattern,
    // so multipleRefundDetection.js falls back to its conservative default assumption.

    const routineResult = await request(server, 'POST', '/transaction', {
      sender_id: 'm_refund_biz',
      receiver_id: 'u_routine_refunds',
      amount: 100,
      timestamp: nowIso, // shape-validated only; the server overrides it with its own received time
      merchant_id: 'm_gw_a',
      purpose: 'Refund',
      transaction_type: 'transfer',
    });
    const firstTimeResult = await request(server, 'POST', '/transaction', {
      sender_id: 'm_refund_biz',
      receiver_id: 'u_first_time_refund',
      amount: 100,
      timestamp: nowIso,
      merchant_id: 'm_gw_a',
      purpose: 'Refund',
      transaction_type: 'transfer',
    });

    assert.ok(
      !routineResult.body.reasons.some((r) => r.includes('Multiple refund attempts')),
      'a pair whose own history says hourly refunds are routine must not be flagged for another one'
    );
    assert.ok(
      firstTimeResult.body.reasons.some((r) => r.includes('Multiple refund attempts')),
      'a pair with no established pacing history refunding again almost immediately must be flagged'
    );
  } finally {
    server.close();
  }
});
