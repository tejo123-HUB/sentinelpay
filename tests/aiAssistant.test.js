// Partial-Feature Completion Pass: Section 26 "Future AI Features" (AI Chat Assistant, Natural
// Language Fraud Search, AI Fraud Investigation Assistant, AI Fraud Report Generator, AI Fraud
// Insights). Every function under test here works with no ANTHROPIC_API_KEY configured -- the
// deterministic path is the default, not a degraded fallback.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');

delete process.env.ANTHROPIC_API_KEY;

const {
  parseNaturalLanguageQuery,
  executeNaturalLanguageSearch,
  generateFraudInsights,
  generateReportNarrative,
  answerDeterministically,
  llmConfigured,
} = require('../server/aiAssistant');
const { SCHEMA } = require('../server/db');

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function insertUser(db, id) {
  db.prepare('INSERT OR IGNORE INTO users (user_id, created_at) VALUES (?, ?)').run(id, new Date().toISOString());
}

function insertTx(db, { id, sender, receiver, amount, decision, score, msAgo }) {
  insertUser(db, sender);
  insertUser(db, receiver);
  db.prepare(
    `INSERT INTO transactions (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, fraud_score, decision)
     VALUES (?, ?, ?, ?, ?, 'transfer', ?, ?)`
  ).run(id, sender, receiver, amount, new Date(Date.now() - msAgo).toISOString(), score, decision);
}

// ---- parseNaturalLanguageQuery ----

test('parseNaturalLanguageQuery: understands decision + amount + time window together', () => {
  const parsed = parseNaturalLanguageQuery('show me blocked transactions over 5000 in the last 7 days');
  assert.deepEqual(parsed.decisions, ['block']);
  assert.equal(parsed.minAmount, 5000);
  assert.ok(parsed.sinceIso);
  assert.ok(parsed.understood.length >= 3);
});

test('parseNaturalLanguageQuery: "flagged" maps to step_up + block', () => {
  const parsed = parseNaturalLanguageQuery('flagged transactions today');
  assert.deepEqual(parsed.decisions, ['step_up', 'block']);
});

test('parseNaturalLanguageQuery: handles a query with no recognizable filters gracefully', () => {
  const parsed = parseNaturalLanguageQuery('asdkjhaskjdh');
  assert.equal(parsed.decisions, null);
  assert.equal(parsed.minAmount, null);
  assert.equal(parsed.sinceIso, null);
  assert.equal(parsed.limit, 50);
});

test('parseNaturalLanguageQuery: "under" sets a max amount', () => {
  const parsed = parseNaturalLanguageQuery('allowed transactions under 100');
  assert.deepEqual(parsed.decisions, ['allow']);
  assert.equal(parsed.maxAmount, 100);
});

// ---- executeNaturalLanguageSearch ----

test('executeNaturalLanguageSearch: filters by decision and amount', () => {
  const db = buildTestDb();
  insertTx(db, { id: 't1', sender: 'a', receiver: 'b', amount: 10000, decision: 'block', score: 90, msAgo: 1000 });
  insertTx(db, { id: 't2', sender: 'a', receiver: 'b', amount: 100, decision: 'allow', score: 5, msAgo: 1000 });

  const parsed = parseNaturalLanguageQuery('blocked transactions over 5000');
  const results = executeNaturalLanguageSearch(db, parsed);
  assert.equal(results.length, 1);
  assert.equal(results[0].transaction_id, 't1');
});

// ---- generateFraudInsights ----

test('generateFraudInsights: flags a large rise in blocked transactions', () => {
  const db = buildTestDb();
  // Prior period (48h-24h ago): 1 blocked. Current period (last 24h): 5 blocked.
  insertTx(db, { id: 'p1', sender: 'a', receiver: 'b', amount: 100, decision: 'block', score: 90, msAgo: 30 * 3600000 });
  for (let i = 0; i < 5; i++) {
    insertTx(db, { id: `c${i}`, sender: 'a', receiver: 'b', amount: 100, decision: 'block', score: 90, msAgo: 3600000 });
  }

  const insights = generateFraudInsights(db, 24 * 3600000);
  assert.ok(insights.some((i) => /Blocked transaction count rose/.test(i)), insights.join(' | '));
});

test('generateFraudInsights: falls back to a "no significant change" message when nothing moved', () => {
  const db = buildTestDb();
  const insights = generateFraudInsights(db, 24 * 3600000);
  assert.equal(insights.length, 1);
  assert.match(insights[0], /No significant change/);
});

// ---- generateReportNarrative ----

test('generateReportNarrative: produces a narrative grounded in the given numbers only', () => {
  const summary = { total_processed: 100, allowed: 80, step_up: 15, blocked: 5, fraud_percent: 20, blocked_amount: 5000, recovered_amount: 2000 };
  const narrative = generateReportNarrative(summary, ['Test insight.'], [{ flag_type: 'velocity', count: 10 }]);
  assert.match(narrative, /100 transaction/);
  assert.match(narrative, /velocity/);
  assert.match(narrative, /Test insight\./);
});

// ---- answerDeterministically ----

test('answerDeterministically: looks up a specific transaction by id', () => {
  const db = buildTestDb();
  insertTx(db, { id: 't_lookup123', sender: 'a', receiver: 'b', amount: 500, decision: 'block', score: 95, msAgo: 1000 });
  const reply = answerDeterministically(db, 'what happened with t_lookup123?');
  assert.match(reply, /t_lookup123/);
  assert.match(reply, /block/);
});

test('answerDeterministically: gives a summary for a general question', () => {
  const db = buildTestDb();
  insertTx(db, { id: 't1', sender: 'a', receiver: 'b', amount: 100, decision: 'block', score: 90, msAgo: 1000 });
  const reply = answerDeterministically(db, 'give me a summary');
  assert.match(reply, /1 transaction/);
});

test('answerDeterministically: falls back to a helpful message for an unrecognized question', () => {
  const db = buildTestDb();
  const reply = answerDeterministically(db, 'what is the meaning of life');
  assert.match(reply, /I can answer/);
});

test('llmConfigured: false with no ANTHROPIC_API_KEY set', () => {
  assert.equal(llmConfigured(), false);
});

// ---- routes ----

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
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('POST /ai/search: rejects a missing query', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/ai/search', {});
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /ai/search: returns matching transactions with an explanation of what was understood', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_ai_biz' });
    await request(server, 'POST', '/transaction', { sender_id: 'u_customer', receiver_id: 'm_ai_biz', amount: 20000, timestamp: '2026-07-18T09:00:00Z', device_id: 'd1', transaction_type: 'transfer' });

    const res = await request(server, 'POST', '/ai/search', { query: 'transactions over 100' });
    assert.equal(res.status, 200);
    assert.ok(res.body.understood.length > 0);
    assert.ok(res.body.result_count >= 1);
  } finally {
    server.close();
  }
});

test('POST /ai/chat: replies deterministically with no ANTHROPIC_API_KEY configured', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/ai/chat', { message: 'give me a summary' });
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'rule_based');
    assert.ok(res.body.reply.length > 0);
  } finally {
    server.close();
  }
});

test('POST /ai/chat: 404s for an unknown case_id', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/ai/chat', { message: 'summarize this case', case_id: 'case_nonexistent' });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('GET /ai/insights: returns an array of insights', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/ai/insights');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.insights));
    assert.ok(res.body.insights.length > 0);
  } finally {
    server.close();
  }
});

test('GET /ai/report: returns a narrative grounded in a real summary', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/ai/report?period=daily');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.narrative, 'string');
    assert.ok(res.body.narrative.length > 0);
    assert.equal(res.body.summary.total_processed, res.body.summary.allowed + res.body.summary.step_up + res.body.summary.blocked);
  } finally {
    server.close();
  }
});
