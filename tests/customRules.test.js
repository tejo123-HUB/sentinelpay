// Section 16, Category 19: unit tests for the pure evaluator (server/customRules.js) plus
// end-to-end coverage for the CRUD routes and live wiring into the scoring pipeline.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { evaluateCustomRules } = require('../server/customRules');

// ---- evaluateCustomRules (pure) ----

test('evaluateCustomRules: numeric operator matches and reports the configured weight/severity', () => {
  const transaction = { amount: 50000 };
  const rules = [{ rule_id: 'rule_1', name: 'Large amount', field: 'amount', operator: '>', value: '10000', weight: 40, severity: 'High' }];

  const results = evaluateCustomRules(transaction, rules);

  assert.equal(results.length, 1);
  assert.equal(results[0].flagged, true);
  assert.equal(results[0].weight, 40);
  assert.equal(results[0].severity, 'High');
  assert.match(results[0].reason, /Large amount/);
});

test('evaluateCustomRules: numeric operator does not match below threshold', () => {
  const transaction = { amount: 100 };
  const rules = [{ rule_id: 'rule_1', name: 'Large amount', field: 'amount', operator: '>', value: '10000', weight: 40, severity: 'High' }];

  assert.equal(evaluateCustomRules(transaction, rules).length, 0);
});

test('evaluateCustomRules: string "contains" operator is case-insensitive', () => {
  const transaction = { purpose: 'Refund - Suspicious Order' };
  const rules = [{ rule_id: 'rule_1', name: 'Suspicious purpose', field: 'purpose', operator: 'contains', value: 'suspicious', weight: 25, severity: 'Medium' }];

  assert.equal(evaluateCustomRules(transaction, rules).length, 1);
});

test('evaluateCustomRules: does not evaluate a field that is absent on the transaction', () => {
  const transaction = { amount: 100 };
  const rules = [{ rule_id: 'rule_1', name: 'Country check', field: 'country', operator: '==', value: 'KP', weight: 30, severity: 'Medium' }];

  assert.equal(evaluateCustomRules(transaction, rules).length, 0);
});

test('evaluateCustomRules: multiple rules can each independently match', () => {
  const transaction = { amount: 50000, country: 'KP' };
  const rules = [
    { rule_id: 'rule_1', name: 'Large amount', field: 'amount', operator: '>', value: '10000', weight: 40, severity: 'High' },
    { rule_id: 'rule_2', name: 'Risky country', field: 'country', operator: '==', value: 'KP', weight: 30, severity: 'Medium' },
  ];

  assert.equal(evaluateCustomRules(transaction, rules).length, 2);
});

// ---- CRUD + pipeline wiring (end-to-end) ----

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.API_KEY = 'test-key-for-automated-tests';

// Full server-tree cache clear, not just server/index.js/rateLimit.js/websocket.js: the last
// test in this file sets API_KEY_ANALYST, which server/middleware/apiKeyAuth.js reads once at
// module-load time -- every route file that captured a reference to its (then-stale) exports
// needs to be re-required too, same reasoning as tests/rbac.test.js.
const path = require('node:path');
function freshServer() {
  const serverDir = path.join(__dirname, '..', 'server');
  for (const resolvedPath of Object.keys(require.cache)) {
    if (resolvedPath.startsWith(serverDir)) delete require.cache[resolvedPath];
  }
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
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('POST /custom-rules: creates a rule, rejects an invalid field/operator', async () => {
  const { server } = await freshServer();
  try {
    const badField = await request(server, 'POST', '/custom-rules', { name: 'x', field: 'not_a_real_field', operator: '>', value: '1', weight: 10, severity: 'Low' });
    assert.equal(badField.status, 400);

    const badOperator = await request(server, 'POST', '/custom-rules', { name: 'x', field: 'amount', operator: 'not_a_real_op', value: '1', weight: 10, severity: 'Low' });
    assert.equal(badOperator.status, 400);

    const posted = await request(server, 'POST', '/custom-rules', { name: 'Large payout', field: 'amount', operator: '>', value: '75000', weight: 45, severity: 'High' });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.enabled, true);
  } finally {
    server.close();
  }
});

test('a custom rule actually flags a live transaction that matches it', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_custom_rule_test' });
    await request(server, 'POST', '/custom-rules', { name: 'Huge payout', field: 'amount', operator: '>', value: '80000', weight: 45, severity: 'High' });

    const res = await request(server, 'POST', '/transaction', {
      sender_id: 'm_custom_rule_test',
      receiver_id: 'u_custom_rule_target',
      amount: 90000,
      timestamp: '2026-07-18T10:00:00Z',
      transaction_type: 'transfer',
    });

    assert.equal(res.status, 201);
    assert.ok(res.body.reasons.some((r) => r.includes('Huge payout')));
  } finally {
    server.close();
  }
});

test('a disabled custom rule does not flag a matching transaction', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_disabled_rule_test' });
    const posted = await request(server, 'POST', '/custom-rules', { name: 'Should be off', field: 'amount', operator: '>', value: '10', weight: 45, severity: 'High' });
    await request(server, 'PATCH', `/custom-rules/${posted.body.rule_id}`, { enabled: false });

    const res = await request(server, 'POST', '/transaction', {
      sender_id: 'm_disabled_rule_test',
      receiver_id: 'u_disabled_rule_target',
      amount: 90000,
      timestamp: '2026-07-18T10:00:00Z',
      transaction_type: 'transfer',
    });

    assert.ok(!res.body.reasons.some((r) => r.includes('Should be off')));
  } finally {
    server.close();
  }
});

test('DELETE /custom-rules/:ruleId removes it', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/custom-rules', { name: 'temp', field: 'amount', operator: '>', value: '1', weight: 10, severity: 'Low' });
    const del = await request(server, 'DELETE', `/custom-rules/${posted.body.rule_id}`);
    assert.equal(del.status, 204);

    const list = await request(server, 'GET', '/custom-rules');
    assert.ok(!list.body.some((r) => r.rule_id === posted.body.rule_id));
  } finally {
    server.close();
  }
});

test('custom-rules mutations require admin role', async () => {
  process.env.API_KEY_ANALYST = 'test-analyst-key';
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/custom-rules', { name: 'x', field: 'amount', operator: '>', value: '1', weight: 10, severity: 'Low' }, { 'X-API-Key': 'test-analyst-key' });
    assert.equal(res.status, 403);
  } finally {
    server.close();
    delete process.env.API_KEY_ANALYST;
  }
});
