const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { SCHEMA } = require('../server/db');
const {
  computeTypicalActiveHoursRange,
  updateUserAfterTransaction,
  ACTIVE_HOURS_LOOKBACK_MS,
} = require('../server/userProfile');

const NOW_MS = new Date('2026-07-18T12:00:00Z').getTime(); // hour 12 UTC

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare('INSERT OR IGNORE INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run(
    'receiver',
    new Date(NOW_MS).toISOString()
  );
  return db;
}

function insertUser(db, userId) {
  db.prepare('INSERT OR IGNORE INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run(
    userId,
    new Date(NOW_MS).toISOString()
  );
}

function insertTransaction(db, senderId, timestampIso) {
  db.prepare(
    `INSERT INTO transactions
      (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, fraud_score, decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(`t_${Math.random().toString(36).slice(2)}`, senderId, 'receiver', 100, timestampIso, 'transfer', 0, 'allow');
}

// Builds an ISO timestamp `msAgo` milliseconds before NOW_MS, with its UTC hour forced to `hour`
// — used to place a transaction at a specific, unambiguous hour without fragile string surgery.
function isoAtHour(msAgo, hour) {
  const d = new Date(NOW_MS - msAgo);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

// Regression: computeTypicalActiveHoursRange used to scan a sender's entire lifetime history
// with no bound, so a single off-hour transaction from months or years ago would permanently
// widen (and never narrow) the "typical active hours" range — a false sense of "this is normal
// for this user" that never expired, and unbounded query growth as a user's history grew.
test('computeTypicalActiveHoursRange: an old outlier hour outside the lookback window is excluded (regression)', () => {
  const db = buildTestDb();
  insertUser(db, 'u_narrow');

  // A single 3am transaction from well before the lookback window (would previously widen the
  // range down to hour 3 forever), plus recent transactions clustered in the afternoon.
  insertTransaction(db, 'u_narrow', isoAtHour(ACTIVE_HOURS_LOOKBACK_MS + 24 * 60 * 60 * 1000, 3));
  insertTransaction(db, 'u_narrow', isoAtHour(60 * 60 * 1000, 11)); // ~1 hour ago, hour 11
  insertTransaction(db, 'u_narrow', isoAtHour(2 * 60 * 60 * 1000, 10)); // hour 10

  const range = computeTypicalActiveHoursRange(db, 'u_narrow', NOW_MS);

  assert.ok(range, 'expected a computed range');
  const [start] = range[0];
  assert.ok(start >= 10, `expected the old 3am transaction to be excluded from the range, got start=${start}`);
});

test('computeTypicalActiveHoursRange: a recent outlier hour is still included', () => {
  const db = buildTestDb();
  insertUser(db, 'u_include');

  insertTransaction(db, 'u_include', isoAtHour(60 * 60 * 1000, 11)); // hour 11
  insertTransaction(db, 'u_include', isoAtHour(5 * 24 * 60 * 60 * 1000, 3)); // 5 days ago, hour 3 — inside the lookback window

  const range = computeTypicalActiveHoursRange(db, 'u_include', NOW_MS);

  assert.ok(range, 'expected a computed range');
  const [start] = range[0];
  assert.equal(start, 3, 'a recent (within-window) outlier hour must still widen the range');
});

test('updateUserAfterTransaction: recomputes typical_active_hours from the transaction it was called with, not real time', () => {
  const db = buildTestDb();
  insertUser(db, 'u_recompute');
  for (let i = 0; i < 5; i += 1) {
    insertTransaction(db, 'u_recompute', new Date(NOW_MS - i * 60 * 60 * 1000).toISOString());
  }

  updateUserAfterTransaction(db, 'u_recompute', { amount: 100, location: null, timestamp: new Date(NOW_MS).toISOString() });

  const row = db.prepare('SELECT typical_active_hours FROM users WHERE user_id = ?').get('u_recompute');
  assert.ok(row.typical_active_hours, 'expected a typical_active_hours baseline to have been computed');
  const parsed = JSON.parse(row.typical_active_hours);
  assert.ok(Array.isArray(parsed) && Array.isArray(parsed[0]));
});
