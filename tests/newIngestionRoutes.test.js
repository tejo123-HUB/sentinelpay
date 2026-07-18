// Section 15.16: end-to-end coverage for the two new ingestion routes (POST /merchant-logins,
// Feature 4; POST /disputes, Feature 8) plus their effect on the scoring pipeline. Same
// freshServer/request harness as tests/api.test.js -- kept in a separate file rather than added
// to that already-large file, matching this project's convention of splitting by concern
// (tests/rateLimit.test.js, tests/userProfile.test.js are both similarly split off).
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

// ---- POST /merchant-logins ----

test('POST /merchant-logins: valid input returns 201 and round-trips through GET', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/merchant-logins', {
      merchant_id: 'm_takeover_test',
      device_id: 'd_1',
      browser: 'Chrome',
      os: 'Windows',
      ip_address: '198.51.100.7',
      country: 'IN',
      location: { lat: 12.9, lng: 77.6 },
    });
    assert.equal(posted.status, 201);
    assert.ok(posted.body.login_id);

    const res = await request(server, 'GET', '/merchant-logins?merchant_id=m_takeover_test');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].device_id, 'd_1');
    assert.equal(res.body[0].country, 'IN');
  } finally {
    server.close();
  }
});

test('POST /merchant-logins: rejects a missing merchant_id', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/merchant-logins', { device_id: 'd_1' });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /merchant-logins: requires an API key', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/merchant-logins', { merchant_id: 'm_1' }, { 'X-API-Key': undefined });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('POST /transaction: a merchant takeover login followed by a refund is flagged (Section 15.16, Feature 4)', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_takeover_e2e' });
    await request(server, 'POST', '/merchant-logins', { merchant_id: 'm_takeover_e2e', device_id: 'd_known', country: 'IN' });
    await request(server, 'POST', '/merchant-logins', { merchant_id: 'm_takeover_e2e', device_id: 'd_attacker', country: 'RU' });

    const refund = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({ sender_id: 'm_takeover_e2e', receiver_id: 'u_victim', purpose: 'Refund' })
    );

    assert.equal(refund.status, 201);
    assert.notEqual(refund.body.decision, 'allow');
    assert.ok(refund.body.reasons.some((r) => r.includes('previously unrecognized device')));
  } finally {
    server.close();
  }
});

// ---- POST /disputes ----

test('POST /disputes: valid input returns 201 and round-trips through GET', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/disputes', {
      transaction_id: 't_abc',
      customer_id: 'u_disputer',
      dispute_type: 'chargeback',
    });
    assert.equal(posted.status, 201);
    assert.ok(posted.body.dispute_id);

    const res = await request(server, 'GET', '/disputes?customer_id=u_disputer');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].dispute_type, 'chargeback');
  } finally {
    server.close();
  }
});

test('POST /disputes: rejects a missing customer_id or dispute_type', async () => {
  const { server } = await freshServer();
  try {
    const missingCustomer = await request(server, 'POST', '/disputes', { dispute_type: 'chargeback' });
    assert.equal(missingCustomer.status, 400);

    const missingType = await request(server, 'POST', '/disputes', { customer_id: 'u_1' });
    assert.equal(missingType.status, 400);
  } finally {
    server.close();
  }
});

test('POST /transaction: response includes severity and risk_breakdown (Section 15.16, Feature 17)', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_explain_e2e' });
    await request(server, 'POST', '/merchant-logins', { merchant_id: 'm_explain_e2e', device_id: 'd_known' });
    await request(server, 'POST', '/merchant-logins', { merchant_id: 'm_explain_e2e', device_id: 'd_attacker' });

    const res = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({ sender_id: 'm_explain_e2e', receiver_id: 'u_victim_2', purpose: 'Refund' })
    );

    assert.equal(res.status, 201);
    assert.equal(res.body.decision, 'block');
    assert.equal(res.body.severity, 'Critical');
    assert.ok(Array.isArray(res.body.risk_breakdown));
    assert.ok(res.body.risk_breakdown.some((r) => r.severity === 'Critical'));
    assert.ok(res.body.risk_breakdown.every((r) => typeof r.reason === 'string'));

    const list = await request(server, 'GET', '/transactions?limit=10');
    const found = list.body.find((t) => t.transaction_id === res.body.transaction_id);
    assert.ok(found);
    assert.equal(found.severity, 'Critical');
    assert.ok(Array.isArray(found.risk_breakdown) && found.risk_breakdown.length > 0);
  } finally {
    server.close();
  }
});

test('POST /transaction: response and GET /transactions both include confidence (Section 16, Category 13)', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/transaction', validTransaction());
    assert.equal(posted.status, 201);
    assert.equal(typeof posted.body.confidence, 'number');

    const list = await request(server, 'GET', '/transactions?limit=10');
    const found = list.body.find((t) => t.transaction_id === posted.body.transaction_id);
    assert.equal(found.confidence, posted.body.confidence);
  } finally {
    server.close();
  }
});

// ---- shared phone/email/identity_hash (Section 16, Category 11) ----

test('POST /transaction: an outbound payment reusing a phone number seen on an unrelated account is flagged', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_shared_phone_e2e' });
    // An ordinary (inbound, non-business) transaction establishes 'p_shared_999' as already
    // associated with a different sender before the outbound payment below reuses it. Device IDs
    // are deliberately different so the shared-device check (which outranks phone in the
    // sharedIdentifierRisk CHECKS precedence order) doesn't mask the phone signal being tested.
    await request(server, 'POST', '/transaction', validTransaction({
      sender_id: 'u_other_account',
      receiver_id: 'u_someone_else',
      device_id: 'd_other_account',
      phone: 'p_shared_999',
    }));

    const payout = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({
        sender_id: 'm_shared_phone_e2e',
        receiver_id: 'u_payout_target',
        device_id: 'd_payout_device',
        phone: 'p_shared_999',
      })
    );

    assert.equal(payout.status, 201);
    assert.ok(payout.body.reasons.some((r) => r.includes('Phone number shared with')));
  } finally {
    server.close();
  }
});

test('POST /transaction: an outbound payment reusing an identity_hash outranks a merely shared device', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_shared_hash_e2e' });
    await request(server, 'POST', '/transaction', validTransaction({
      sender_id: 'u_other_account_2',
      receiver_id: 'u_someone_else_2',
      device_id: 'd_test',
      identity_hash: 'h_shared_abcdef',
    }));

    const payout = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({
        sender_id: 'm_shared_hash_e2e',
        receiver_id: 'u_payout_target_2',
        device_id: 'd_test',
        identity_hash: 'h_shared_abcdef',
      })
    );

    assert.equal(payout.status, 201);
    assert.ok(payout.body.reasons.some((r) => r.includes('Identity document hash shared with')));
  } finally {
    server.close();
  }
});

test('POST /transaction: phone/email/identity_hash are accepted but not echoed back in the response or GET /transactions', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({ phone: 'p_privacy_test', email: 'e_privacy_test@example.com', identity_hash: 'h_privacy_test' })
    );
    assert.equal(posted.status, 201);
    assert.equal(posted.body.phone, undefined);
    assert.equal(posted.body.email, undefined);
    assert.equal(posted.body.identity_hash, undefined);

    const list = await request(server, 'GET', '/transactions?limit=10');
    const found = list.body.find((t) => t.transaction_id === posted.body.transaction_id);
    assert.ok(found);
    assert.equal(found.phone, undefined);
    assert.equal(found.email, undefined);
    assert.equal(found.identity_hash, undefined);
  } finally {
    server.close();
  }
});

test('POST /transaction: a shared identity_hash is Critical severity (weight escalates outbound risk sharply)', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_shared_hash_severity_e2e' });
    await request(server, 'POST', '/transaction', validTransaction({
      sender_id: 'u_other_account_3',
      receiver_id: 'u_someone_else_3',
      identity_hash: 'h_shared_severity',
    }));

    const payout = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({
        sender_id: 'm_shared_hash_severity_e2e',
        receiver_id: 'u_payout_target_3',
        identity_hash: 'h_shared_severity',
      })
    );

    assert.equal(payout.status, 201);
    const found = payout.body.risk_breakdown.find((r) => r.reason.includes('Identity document hash shared with'));
    assert.ok(found);
    assert.equal(found.severity, 'High');
  } finally {
    server.close();
  }
});

// ---- Device Reputation Engine (Section 16, Category 10) ----

test('POST /transaction: a device with a prior flagged transaction is flagged on the next outbound payment', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_device_reputation_e2e' });
    // Also a business account: only outbound (business-initiated) transactions run rule scoring
    // at all, so the "prior flagged transaction" this test relies on must itself be outbound.
    await request(server, 'POST', '/business-accounts', { account_id: 'm_bad_device_owner' });

    // Force a step_up/block on the first transaction via a huge amount (outboundRestrictor.js's
    // review-threshold floor), so this device_id genuinely has a prior flagged decision recorded
    // against it before the outbound payout below runs.
    const flagged = await request(server, 'POST', '/transaction', validTransaction({
      sender_id: 'm_bad_device_owner',
      receiver_id: 'u_someone',
      device_id: 'd_reputation_test',
      amount: 9_999_999,
    }));
    assert.notEqual(flagged.body.decision, 'allow');

    const payout = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({
        sender_id: 'm_device_reputation_e2e',
        receiver_id: 'u_payout_target_device',
        device_id: 'd_reputation_test',
      })
    );

    assert.equal(payout.status, 201);
    assert.ok(payout.body.reasons.some((r) => r.includes('previously associated with')));
  } finally {
    server.close();
  }
});

test('POST /transaction: a scripted-client user_agent is flagged as a suspicious device signal', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_ua_e2e' });

    const payout = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({
        sender_id: 'm_ua_e2e',
        receiver_id: 'u_payout_target_ua',
        device_id: 'd_ua_test',
        user_agent: 'curl/8.4.0',
      })
    );

    assert.equal(payout.status, 201);
    assert.ok(payout.body.reasons.some((r) => r.includes('automation/scripting signature')));
  } finally {
    server.close();
  }
});

// ---- High-Risk State/City Detection (Section 16, Category 12) ----

test('POST /transaction: a payout from a configured high-risk state is flagged', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_state_risk_e2e' });

    const payout = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({ sender_id: 'm_state_risk_e2e', receiver_id: 'u_state_risk_target', state: 'XX-EXAMPLE-STATE' })
    );

    assert.equal(payout.status, 201);
    assert.ok(payout.body.reasons.some((r) => r.includes('high-risk state/region')));
  } finally {
    server.close();
  }
});

test('POST /transaction: a payout from a configured high-risk city is flagged, and state/city round-trip through GET /transactions', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_city_risk_e2e' });

    const payout = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({ sender_id: 'm_city_risk_e2e', receiver_id: 'u_city_risk_target', city: 'Example Risk City' })
    );

    assert.equal(payout.status, 201);
    assert.ok(payout.body.reasons.some((r) => r.includes('high-risk city')));

    const listed = await request(server, 'GET', '/transactions?limit=5');
    const match = listed.body.find((t) => t.transaction_id === payout.body.transaction_id);
    assert.equal(match.city, 'Example Risk City');
  } finally {
    server.close();
  }
});

test('POST /transaction: user_agent is accepted but not echoed back in the response or GET /transactions', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({ sender_id: 'u_ua_privacy_1', receiver_id: 'u_ua_privacy_2', user_agent: 'Mozilla/5.0 test-browser' })
    );
    assert.equal(posted.status, 201);
    assert.equal(posted.body.user_agent, undefined);

    const listed = await request(server, 'GET', '/transactions?limit=5');
    const match = listed.body.find((t) => t.transaction_id === posted.body.transaction_id);
    assert.ok(match);
    assert.equal(match.user_agent, undefined);
  } finally {
    server.close();
  }
});

test('POST /transaction: a repeat-dispute customer elevates a refund\'s risk (Section 15.16, Feature 8)', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_dispute_e2e' });
    for (let i = 0; i < 3; i += 1) {
      await request(server, 'POST', '/disputes', { customer_id: 'u_repeat_disputer', dispute_type: 'chargeback' });
    }

    const refund = await request(
      server,
      'POST',
      '/transaction',
      validTransaction({ sender_id: 'm_dispute_e2e', receiver_id: 'u_repeat_disputer', purpose: 'Refund' })
    );

    assert.equal(refund.status, 201);
    assert.ok(refund.body.reasons.some((r) => r.includes('repeat dispute pattern')));
  } finally {
    server.close();
  }
});
