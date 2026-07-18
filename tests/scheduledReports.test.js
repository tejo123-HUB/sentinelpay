// Section 16, Category 18: unit tests for report generation (server/scheduledReports.js) plus
// end-to-end coverage for the routes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');

const { SCHEMA } = require('../server/db');
const { computeSummaryForPeriod, generateReport } = require('../server/scheduledReports');

const NOW_MS = new Date('2026-07-18T12:00:00Z').getTime();

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function insertTransaction(db, { senderId, receiverId, amount, decision, fraudScore, msAgo }) {
  db.prepare('INSERT OR IGNORE INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run(senderId, new Date(NOW_MS).toISOString());
  db.prepare('INSERT OR IGNORE INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run(receiverId, new Date(NOW_MS).toISOString());
  db.prepare(
    'INSERT INTO transactions (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, fraud_score, decision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(`t_${Math.random().toString(36).slice(2)}`, senderId, receiverId, amount, new Date(NOW_MS - msAgo).toISOString(), 'transfer', fraudScore, decision);
}

// ---- computeSummaryForPeriod ----

test('computeSummaryForPeriod: aggregates only transactions within the window', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'u_1', receiverId: 'u_2', amount: 100, decision: 'allow', fraudScore: 5, msAgo: 60 * 60 * 1000 }); // inside a 24h window
  insertTransaction(db, { senderId: 'u_3', receiverId: 'u_4', amount: 500, decision: 'block', fraudScore: 90, msAgo: 25 * 60 * 60 * 1000 }); // outside a 24h window

  const summary = computeSummaryForPeriod(db, new Date(NOW_MS - 24 * 60 * 60 * 1000).toISOString(), new Date(NOW_MS).toISOString());

  assert.equal(summary.total_processed, 1);
  assert.equal(summary.allowed, 1);
  assert.equal(summary.blocked, 0);
});

test('computeSummaryForPeriod: computes fraud percent and blocked/recovered amounts correctly', () => {
  const db = buildTestDb();
  insertTransaction(db, { senderId: 'u_1', receiverId: 'u_2', amount: 100, decision: 'allow', fraudScore: 5, msAgo: 1000 });
  insertTransaction(db, { senderId: 'u_3', receiverId: 'u_4', amount: 500, decision: 'block', fraudScore: 90, msAgo: 1000 });
  insertTransaction(db, { senderId: 'u_5', receiverId: 'u_6', amount: 200, decision: 'step_up', fraudScore: 50, msAgo: 1000 });

  const summary = computeSummaryForPeriod(db, new Date(NOW_MS - 24 * 60 * 60 * 1000).toISOString(), new Date(NOW_MS).toISOString());

  assert.equal(summary.total_processed, 3);
  assert.equal(summary.fraud_percent, 66.67);
  assert.equal(summary.blocked_amount, 500);
  assert.equal(summary.recovered_amount, 200); // the step_up transaction, score >= 40, not blocked
});

// ---- generateReport ----

test('generateReport: persists a report row and is idempotent for the same period', async () => {
  const db = buildTestDb();
  // period_end is aligned to the current period boundary (epoch-floor, same pattern as
  // analytics.js's trend bucketing), not raw "now" -- a daily report covers the most recently
  // *completed* day, not an in-progress partial today, so this needs to land in that completed
  // window, not "1 second ago."
  insertTransaction(db, { senderId: 'u_1', receiverId: 'u_2', amount: 100, decision: 'allow', fraudScore: 5, msAgo: 18 * 60 * 60 * 1000 });

  const first = await generateReport(db, 'daily', NOW_MS);
  assert.ok(first);
  assert.equal(first.report_type, 'daily');
  assert.equal(first.summary.total_processed, 1);

  const second = await generateReport(db, 'daily', NOW_MS);
  assert.equal(second, null, 'a second generation for the exact same period must be a no-op, not a duplicate row');

  const rows = db.prepare('SELECT * FROM scheduled_reports').all();
  assert.equal(rows.length, 1);
});

test('generateReport: emailed is false when no SMTP is configured (the default, unconfigured state)', async () => {
  delete process.env.SMTP_HOST;
  const db = buildTestDb();
  const report = await generateReport(db, 'weekly', NOW_MS);
  assert.equal(report.emailed, false);
});

// ---- routes (end-to-end) ----

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
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('POST /scheduled-reports/generate: generates on demand, 409s on a duplicate for the same period', async () => {
  const { server } = await freshServer();
  try {
    const posted = await request(server, 'POST', '/scheduled-reports/generate', { type: 'daily' });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.report_type, 'daily');

    const duplicate = await request(server, 'POST', '/scheduled-reports/generate', { type: 'daily' });
    assert.equal(duplicate.status, 409);
  } finally {
    server.close();
  }
});

test('GET /scheduled-reports: lists generated reports, filterable by type', async () => {
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/scheduled-reports/generate', { type: 'daily' });
    await request(server, 'POST', '/scheduled-reports/generate', { type: 'weekly' });

    const daily = await request(server, 'GET', '/scheduled-reports?type=daily');
    assert.equal(daily.status, 200);
    assert.equal(daily.body.length, 1);
    assert.equal(daily.body[0].report_type, 'daily');
    assert.equal(typeof daily.body[0].summary, 'object');
  } finally {
    server.close();
  }
});

test('scheduled-reports generation requires admin role', async () => {
  process.env.API_KEY_ANALYST = 'test-analyst-key';
  const path = require('node:path');
  const serverDir = path.join(__dirname, '..', 'server');
  for (const resolvedPath of Object.keys(require.cache)) {
    if (resolvedPath.startsWith(serverDir)) delete require.cache[resolvedPath];
  }
  const { app, server } = require('../server/index');
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  try {
    const res = await request(server, 'POST', '/scheduled-reports/generate', { type: 'daily' }, { 'X-API-Key': 'test-analyst-key' });
    assert.equal(res.status, 403);
  } finally {
    server.close();
    delete process.env.API_KEY_ANALYST;
  }
});
