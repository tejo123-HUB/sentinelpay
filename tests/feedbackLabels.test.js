// Continuous Learning Extension, Phase F: the feedback loop's label-capture mechanism
// (server/feedbackLabels.js) -- turning real analyst decisions (blacklist/whitelist, case
// resolution) into feedback_labels rows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const { SCHEMA } = require('../server/db');
const {
  labelTransaction,
  labelRecentTransactionsForAccount,
  labelCaseTransactions,
} = require('../server/feedbackLabels');

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function ensureUser(db, userId) {
  const existing = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(userId);
  if (!existing) db.prepare('INSERT INTO users (user_id, created_at) VALUES (?, ?)').run(userId, '2026-01-01T00:00:00.000Z');
}

function insertTransaction(db, overrides = {}) {
  const t = {
    transaction_id: `t_${Math.random().toString(36).slice(2)}`,
    sender_id: 'u_a',
    receiver_id: 'u_b',
    amount: 100,
    timestamp: '2026-07-18T10:00:00.000Z',
    transaction_type: 'transfer',
    ...overrides,
  };
  ensureUser(db, t.sender_id);
  ensureUser(db, t.receiver_id);
  db.prepare(
    'INSERT INTO transactions (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(t.transaction_id, t.sender_id, t.receiver_id, t.amount, t.timestamp, t.transaction_type);
  return t;
}

// ---- unit-level ----

test('labelTransaction: upserts, so a transaction relabeled by a later decision gets the newer verdict', () => {
  const db = buildTestDb();
  const t = insertTransaction(db);
  labelTransaction(db, t.transaction_id, 1, 'blacklist', '2026-07-18T10:00:00.000Z');
  labelTransaction(db, t.transaction_id, 0, 'whitelist', '2026-07-18T11:00:00.000Z');

  const row = db.prepare('SELECT * FROM feedback_labels WHERE transaction_id = ?').get(t.transaction_id);
  assert.equal(row.label, 0);
  assert.equal(row.source, 'whitelist');
});

test('labelRecentTransactionsForAccount: labels transactions where the account is either sender or receiver', () => {
  const db = buildTestDb();
  const asSender = insertTransaction(db, { sender_id: 'u_target', receiver_id: 'u_other' });
  const asReceiver = insertTransaction(db, { sender_id: 'u_other2', receiver_id: 'u_target' });
  const unrelated = insertTransaction(db, { sender_id: 'u_x', receiver_id: 'u_y' });

  const nowMs = new Date('2026-07-18T12:00:00.000Z').getTime();
  const count = labelRecentTransactionsForAccount(db, 'u_target', 1, 'blacklist', nowMs);

  assert.equal(count, 2);
  assert.ok(db.prepare('SELECT 1 FROM feedback_labels WHERE transaction_id = ?').get(asSender.transaction_id));
  assert.ok(db.prepare('SELECT 1 FROM feedback_labels WHERE transaction_id = ?').get(asReceiver.transaction_id));
  assert.equal(db.prepare('SELECT 1 FROM feedback_labels WHERE transaction_id = ?').get(unrelated.transaction_id), undefined);
});

test('labelRecentTransactionsForAccount: a transaction outside the lookback window is not labeled', () => {
  const db = buildTestDb();
  const old = insertTransaction(db, { sender_id: 'u_target', receiver_id: 'u_other', timestamp: '2026-01-01T00:00:00.000Z' });

  const nowMs = new Date('2026-07-18T12:00:00.000Z').getTime();
  const count = labelRecentTransactionsForAccount(db, 'u_target', 1, 'blacklist', nowMs);

  assert.equal(count, 0);
  assert.equal(db.prepare('SELECT 1 FROM feedback_labels WHERE transaction_id = ?').get(old.transaction_id), undefined);
});

test('labelCaseTransactions: labels every transaction linked to the case', () => {
  const db = buildTestDb();
  const t1 = insertTransaction(db);
  const t2 = insertTransaction(db);
  db.prepare('INSERT INTO cases (case_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'case_1',
    'Suspicious activity',
    'resolved',
    '2026-07-18T09:00:00.000Z',
    '2026-07-18T09:00:00.000Z'
  );
  db.prepare('INSERT INTO case_transactions (case_id, transaction_id, added_at) VALUES (?, ?, ?)').run('case_1', t1.transaction_id, '2026-07-18T09:00:00.000Z');
  db.prepare('INSERT INTO case_transactions (case_id, transaction_id, added_at) VALUES (?, ?, ?)').run('case_1', t2.transaction_id, '2026-07-18T09:00:00.000Z');

  const count = labelCaseTransactions(db, 'case_1', 1, new Date('2026-07-18T12:00:00.000Z').getTime());
  assert.equal(count, 2);
  assert.equal(db.prepare('SELECT label FROM feedback_labels WHERE transaction_id = ?').get(t1.transaction_id).label, 1);
  assert.equal(db.prepare('SELECT source FROM feedback_labels WHERE transaction_id = ?').get(t1.transaction_id).source, 'case_resolution');
});

// ---- end-to-end via the real HTTP routes ----

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

function validTransaction(overrides = {}) {
  return {
    sender_id: 'u_fb_1',
    receiver_id: 'u_fb_2',
    amount: 250,
    timestamp: '2026-07-18T10:15:00Z',
    device_id: 'd_test',
    transaction_type: 'transfer',
    ...overrides,
  };
}

test('POST /fraud-lists: blacklisting an account labels its recent transactions as positive', async () => {
  const { server, app } = await freshServer();
  try {
    await request(server, 'POST', '/transaction', validTransaction());
    await request(server, 'POST', '/fraud-lists', { list_type: 'blacklist', account_id: 'u_fb_1', reason: 'confirmed' });

    const db = app.locals.db;
    const rows = db
      .prepare(
        `SELECT fl.label, fl.source FROM feedback_labels fl
         JOIN transactions t ON t.transaction_id = fl.transaction_id
         WHERE t.sender_id = ?`
      )
      .all('u_fb_1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 1);
    assert.equal(rows[0].source, 'blacklist');
  } finally {
    server.close();
  }
});

test('PATCH /cases/:caseId: resolving with outcome=confirmed_fraud labels every linked transaction', async () => {
  const { server, app } = await freshServer();
  try {
    const txRes = await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_fb_case_1', receiver_id: 'u_fb_case_2' }));
    const transactionId = txRes.body.transaction_id;

    const caseRes = await request(server, 'POST', '/cases', { title: 'Investigate this', transaction_ids: [transactionId] });
    const caseId = caseRes.body.case_id;

    const patchRes = await request(server, 'PATCH', `/cases/${caseId}`, { status: 'resolved', outcome: 'confirmed_fraud' });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.outcome, 'confirmed_fraud');

    const db = app.locals.db;
    const row = db.prepare('SELECT * FROM feedback_labels WHERE transaction_id = ?').get(transactionId);
    assert.ok(row);
    assert.equal(row.label, 1);
    assert.equal(row.source, 'case_resolution');
  } finally {
    server.close();
  }
});

test('PATCH /cases/:caseId: re-saving with the same outcome does not error or duplicate labeling', async () => {
  const { server, app } = await freshServer();
  try {
    const txRes = await request(server, 'POST', '/transaction', validTransaction({ sender_id: 'u_fb_case_3', receiver_id: 'u_fb_case_4' }));
    const caseRes = await request(server, 'POST', '/cases', { title: 'x', transaction_ids: [txRes.body.transaction_id] });
    const caseId = caseRes.body.case_id;

    await request(server, 'PATCH', `/cases/${caseId}`, { outcome: 'false_positive' });
    const second = await request(server, 'PATCH', `/cases/${caseId}`, { outcome: 'false_positive', assigned_to: 'analyst_1' });
    assert.equal(second.status, 200);

    const db = app.locals.db;
    const count = db.prepare('SELECT COUNT(*) AS n FROM feedback_labels WHERE transaction_id = ?').get(txRes.body.transaction_id).n;
    assert.equal(count, 1);
  } finally {
    server.close();
  }
});

test('PATCH /cases/:caseId: rejects an invalid outcome value', async () => {
  const { server, app } = await freshServer();
  try {
    const caseRes = await request(server, 'POST', '/cases', { title: 'x' });
    const res = await request(server, 'PATCH', `/cases/${caseRes.body.case_id}`, { outcome: 'not_a_real_outcome' });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
