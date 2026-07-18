// Partial-Feature Completion Pass: Device Intelligence (emulator/rooted heuristics), Identity
// Intelligence (synthetic-identity pattern), and Graph Intelligence (shared bank account) --
// closing the three gaps the audit found under those categories.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { SCHEMA } = require('../server/db');
const getOutboundContext = require('../server/outboundContext');
const deviceIntegrityRisk = require('../server/rules/deviceIntegrityRisk');
const syntheticIdentityRisk = require('../server/rules/syntheticIdentityRisk');
const sharedIdentifierRisk = require('../server/rules/sharedIdentifierRisk');

const NOW_MS = new Date('2026-07-18T12:00:00Z').getTime();

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function insertUser(db, userId) {
  db.prepare('INSERT OR IGNORE INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run(
    userId,
    new Date(NOW_MS).toISOString()
  );
}

// ---- deviceIntegrityRisk ----

test('deviceIntegrityRisk: flags a known emulator device_id signature', () => {
  const result = deviceIntegrityRisk({ device_id: 'sdk_gphone_x86_64', user_agent: 'Dalvik/2.1.0' });
  assert.equal(result.flagged, true);
  assert.match(result.reason, /emulator/i);
});

test('deviceIntegrityRisk: flags a rooted-device user_agent signature', () => {
  const result = deviceIntegrityRisk({ device_id: 'dev123', user_agent: 'MyApp/1.0 (Magisk)' });
  assert.equal(result.flagged, true);
  assert.match(result.reason, /rooted|jailbroken/i);
});

test('deviceIntegrityRisk: does not flag an ordinary device_id/user_agent', () => {
  const result = deviceIntegrityRisk({ device_id: 'dev_abc123', user_agent: 'Mozilla/5.0 (iPhone)' });
  assert.equal(result.flagged, false);
});

test('deviceIntegrityRisk: handles missing fields without throwing', () => {
  const result = deviceIntegrityRisk({ device_id: null, user_agent: null });
  assert.equal(result.flagged, false);
});

// ---- syntheticIdentityRisk ----

test('syntheticIdentityRisk: flags when the device has been associated with many distinct identities', () => {
  const result = syntheticIdentityRisk({ phone: '+1555', email: null, identity_hash: null }, { deviceDistinctIdentityCount: 4 });
  assert.equal(result.flagged, true);
  assert.match(result.reason, /distinct identity/);
});

test('syntheticIdentityRisk: does not flag below the threshold', () => {
  const result = syntheticIdentityRisk({ phone: '+1555', email: null, identity_hash: null }, { deviceDistinctIdentityCount: 1 });
  assert.equal(result.flagged, false);
});

test('syntheticIdentityRisk: does not flag a transaction with no identity fields at all', () => {
  const result = syntheticIdentityRisk({ phone: null, email: null, identity_hash: null }, { deviceDistinctIdentityCount: 10 });
  assert.equal(result.flagged, false);
});

// ---- getOutboundContext: deviceDistinctIdentityCount + sharedBankAccountAccountIds ----

test('getOutboundContext: deviceDistinctIdentityCount counts distinct (phone,email,identity_hash) combos on this device_id', () => {
  const db = buildTestDb();
  insertUser(db, 'biz1');
  const identities = [
    { phone: '+1111', email: null, identity_hash: null },
    { phone: '+2222', email: null, identity_hash: null },
    { phone: '+3333', email: null, identity_hash: null },
  ];
  identities.forEach((idn, i) => {
    insertUser(db, `cust${i}`);
    db.prepare(
      `INSERT INTO transactions (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, fraud_score, decision, device_id, phone, email, identity_hash)
       VALUES (?, ?, ?, ?, ?, 'transfer', 0, 'allow', ?, ?, ?, ?)`
    ).run(`t_${i}`, `cust${i}`, 'biz1', 100, new Date(NOW_MS - (i + 1) * 1000).toISOString(), 'shared_device', idn.phone, idn.email, idn.identity_hash);
  });

  const context = getOutboundContext(db, { sender_id: 'biz1', receiver_id: 'newcust', device_id: 'shared_device', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);
  assert.equal(context.deviceDistinctIdentityCount, 3);
});

test('getOutboundContext: sharedBankAccountAccountIds finds other accounts using the same bank_account_hash', () => {
  const db = buildTestDb();
  insertUser(db, 'biz1');
  insertUser(db, 'other_acct');
  insertUser(db, 'someone');
  insertUser(db, 'recv1');
  db.prepare(
    `INSERT INTO transactions (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, fraud_score, decision, bank_account_hash)
     VALUES (?, ?, ?, ?, ?, 'transfer', 0, 'allow', ?)`
  ).run('t_other', 'other_acct', 'someone', 100, new Date(NOW_MS - 1000).toISOString(), 'hash_abc');

  const context = getOutboundContext(db, { sender_id: 'biz1', receiver_id: 'recv1', bank_account_hash: 'hash_abc', timestamp: new Date(NOW_MS).toISOString() }, NOW_MS);
  assert.deepEqual(context.sharedBankAccountAccountIds, ['other_acct']);
});

// ---- sharedIdentifierRisk: bank account ----

test('sharedIdentifierRisk: flags a shared bank account hash', () => {
  const result = sharedIdentifierRisk({}, { sharedBankAccountAccountIds: ['acct_x'] });
  assert.equal(result.flagged, true);
  assert.match(result.reason, /Bank account shared/);
});

// ---- end-to-end wiring regression: synthetic_identity_risk must receive outboundContext, not
// userHistory (caught during review -- registering it in the wrong detector list would silently
// zero out deviceDistinctIdentityCount and the detector would never fire).

const http = require('node:http');

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
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('POST /transaction: synthetic_identity_risk fires end-to-end when a device backs many distinct identities (regression)', async () => {
  process.env.DB_PATH = ':memory:';
  process.env.PORT = '0';
  process.env.API_KEY = process.env.API_KEY || 'test-key-for-automated-tests';
  const { server } = await freshServer();
  try {
    await request(server, 'POST', '/business-accounts', { account_id: 'm_synth_biz' });
    for (let i = 0; i < 3; i++) {
      await request(server, 'POST', '/transaction', {
        sender_id: `u_synth_id_${i}`,
        receiver_id: 'someone',
        amount: 10,
        timestamp: new Date().toISOString(),
        device_id: 'd_synth_regression',
        phone: `+100${i}`,
        transaction_type: 'transfer',
      });
    }
    const res = await request(server, 'POST', '/transaction', {
      sender_id: 'm_synth_biz',
      receiver_id: 'u_new_recv',
      amount: 50,
      timestamp: new Date().toISOString(),
      device_id: 'd_synth_regression',
      phone: '+9999',
      transaction_type: 'transfer',
    });
    assert.ok(
      res.body.reasons.some((r) => /distinct identity combinations/.test(r)),
      `expected synthetic-identity reason, got: ${JSON.stringify(res.body.reasons)}`
    );
  } finally {
    server.close();
  }
});
