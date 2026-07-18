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

test('answerDeterministically: a transaction lookup includes its flags\' human-readable reasons and derived severity', () => {
  const db = buildTestDb();
  insertTx(db, { id: 't_flagged1', sender: 'a', receiver: 'b', amount: 500, decision: 'block', score: 95, msAgo: 1000 });
  db.prepare(
    `INSERT INTO flags (flag_id, transaction_id, flag_type, reason, weight, severity, created_at)
     VALUES ('fl_1', 't_flagged1', 'velocity', 'Too many transactions in 60s', 40, 'High', ?)`
  ).run(new Date().toISOString());
  const reply = answerDeterministically(db, 'tell me about t_flagged1');
  assert.match(reply, /High severity/);
  assert.match(reply, /velocity/);
  assert.match(reply, /Too many transactions in 60s/);
});

test('answerDeterministically: an unknown transaction id gets a clear "not found" reply, not a crash', () => {
  const db = buildTestDb();
  const reply = answerDeterministically(db, 'what happened with t_doesnotexist123?');
  assert.match(reply, /couldn't find/i);
});

test('answerDeterministically: gives a summary for a general question', () => {
  const db = buildTestDb();
  insertTx(db, { id: 't1', sender: 'a', receiver: 'b', amount: 100, decision: 'block', score: 90, msAgo: 1000 });
  const reply = answerDeterministically(db, 'give me a summary');
  assert.match(reply, /1 transaction/);
});

// Bug fix (post-audit): SQLite's SUM() over zero matching rows returns NULL, not 0 -- a brand-new
// deployment's very first chat "summary" reply used to literally say "null blocked, null step-up
// challenged" instead of 0. Regression test for the COALESCE fix.
test('answerDeterministically: a summary on an empty database reports zeros, never "null"', () => {
  const db = buildTestDb();
  const reply = answerDeterministically(db, 'give me a summary');
  assert.equal(reply, 'So far: 0 transaction(s) processed, 0 blocked, 0 step-up challenged.');
  assert.doesNotMatch(reply, /null/i);
});

test('answerDeterministically: greets and lists its own capabilities for a greeting/help message', () => {
  const db = buildTestDb();
  for (const message of ['hi', 'hello', 'help', 'what can you do?']) {
    const reply = answerDeterministically(db, message);
    assert.match(reply, /SentinelPay AI Assistant/, `expected a greeting for "${message}"`);
  }
});

test('answerDeterministically: a question containing "help" as part of a real question is not swallowed by the greeting', () => {
  const db = buildTestDb();
  const reply = answerDeterministically(db, 'help me understand how risky is u_risky_test');
  assert.doesNotMatch(reply, /SentinelPay AI Assistant/);
  assert.match(reply, /Reputation risk score/);
});

test('answerDeterministically: explains what each decision tier means, grounded in decision.js\'s real thresholds', () => {
  const db = buildTestDb();
  const blockReply = answerDeterministically(db, 'what does block mean');
  assert.match(blockReply, /above 80/);

  const stepUpReply = answerDeterministically(db, 'what does step_up mean');
  assert.match(stepUpReply, /between 40 and 80/);

  const allowReply = answerDeterministically(db, 'why do transactions get allowed');
  assert.match(allowReply, /below 40/);
});

test('answerDeterministically: explains a named fraud signal using the real fraudSignatures.js catalog', () => {
  const db = buildTestDb();
  const reply = answerDeterministically(db, 'what is impossible travel');
  assert.match(reply, /impossible_travel/);
  assert.match(reply, /physically impossible travel speed/);
});

test('answerDeterministically: a fraud-signal explanation reports its live occurrence count, not a fabricated one', () => {
  const db = buildTestDb();
  insertTx(db, { id: 't_mule1', sender: 'a', receiver: 'b', amount: 500, decision: 'block', score: 95, msAgo: 1000 });
  db.prepare(
    `INSERT INTO flags (flag_id, transaction_id, flag_type, reason, weight, severity, created_at)
     VALUES ('fl_mule1', 't_mule1', 'mule_receiver_risk', 'receive-then-drain pattern', 60, 'Critical', ?)`
  ).run(new Date().toISOString());
  const reply = answerDeterministically(db, 'what is a mule account');
  assert.match(reply, /fired 1 time\(s\)/);
});

test('answerDeterministically: explains how fraud scoring works, grounded in the real average score', () => {
  const db = buildTestDb();
  insertTx(db, { id: 't1', sender: 'a', receiver: 'b', amount: 100, decision: 'block', score: 80, msAgo: 1000 });
  const reply = answerDeterministically(db, 'how does fraud scoring work');
  assert.match(reply, /0-100 fraud score/);
  assert.match(reply, /80\.0\/100/);
});

test('answerDeterministically: gives a recent-activity pulse reusing generateFraudInsights', () => {
  const db = buildTestDb();
  const reply = answerDeterministically(db, "what's happening today");
  assert.match(reply, /No significant change|rose|fell/);
});

test('answerDeterministically: gives dispute/next-step guidance for a "why was I blocked" question', () => {
  const db = buildTestDb();
  const reply = answerDeterministically(db, 'why was my transaction blocked, what should I do');
  assert.match(reply, /investigation case/i);
});

test('answerDeterministically: looks up an account\'s composite reputation risk score', () => {
  const db = buildTestDb();
  const reply = answerDeterministically(db, 'how risky is u_brand_new_account');
  assert.match(reply, /Reputation risk score for u_brand_new_account/);
  assert.match(reply, /50\/100/); // neutral prior, no history yet
});

test('answerDeterministically: asking for a risk score with no account id asks for one instead of guessing', () => {
  const db = buildTestDb();
  const reply = answerDeterministically(db, 'how risky is this');
  assert.match(reply, /mention the account id/i);
});

test('answerDeterministically: falls back to a categorized help message for an unrecognized question', () => {
  const db = buildTestDb();
  const reply = answerDeterministically(db, 'what is the meaning of life');
  assert.match(reply, /didn't quite catch that/i);
});

test('llmConfigured: false with no ANTHROPIC_API_KEY set', () => {
  assert.equal(llmConfigured(), false);
});

// ---- routes ----

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.API_KEY = 'test-key-for-automated-tests';

// Full server-tree cache clear, not just index.js/rateLimit.js/websocket.js: a test below sets
// API_KEY_VIEWER, which server/middleware/apiKeyAuth.js reads once at module-load time -- every
// route file that captured a reference to its (then-stale) exports needs to be re-required too,
// same reasoning as tests/customRules.test.js / tests/caseEvidence.test.js.
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

// Security fix (post-merge audit): when ANTHROPIC_API_KEY is configured, this route makes a real,
// billed outbound call to the Claude API per invocation -- previously reachable by any valid key
// (including viewer), now requires analyst, the same "real-world consequence" floor already
// applied to POST /notifications/push-subscriptions.
test('POST /ai/chat: requires the analyst role, not just any valid key', async () => {
  process.env.API_KEY_VIEWER = 'test-viewer-key-ai-chat';
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/ai/chat', { message: 'give me a summary' }, { 'X-API-Key': 'test-viewer-key-ai-chat' });
    assert.equal(res.status, 403);
  } finally {
    delete process.env.API_KEY_VIEWER;
    server.close();
  }
});

test('POST /ai/search: a viewer-role key is still allowed (no external call, no cost)', async () => {
  process.env.API_KEY_VIEWER = 'test-viewer-key-ai-search';
  const { server } = await freshServer();
  try {
    const res = await request(server, 'POST', '/ai/search', { query: 'transactions over 100' }, { 'X-API-Key': 'test-viewer-key-ai-search' });
    assert.equal(res.status, 200);
  } finally {
    delete process.env.API_KEY_VIEWER;
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
