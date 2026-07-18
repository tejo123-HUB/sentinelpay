// Dynamic Risk Engine core: Welford's online mean/variance + z-score, and the entity_baselines
// read/update helpers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { SCHEMA } = require('../server/db');
const { welfordUpdate, variance, stddev, zScore, getBaseline, updateBaseline } = require('../server/adaptiveBaseline');

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

// ---- welfordUpdate / variance / stddev (pure math) ----

test('welfordUpdate: matches the naive mean/variance formula over a known sample', () => {
  const sample = [10, 12, 23, 23, 16, 23, 21, 16];
  let count = 0;
  let mean = 0;
  let m2 = 0;
  for (const v of sample) {
    ({ count, mean, m2 } = welfordUpdate(count, mean, m2, v));
  }

  const naiveMean = sample.reduce((a, b) => a + b, 0) / sample.length;
  const naiveVariance = sample.reduce((a, b) => a + (b - naiveMean) ** 2, 0) / sample.length;

  assert.equal(count, sample.length);
  assert.ok(Math.abs(mean - naiveMean) < 1e-9);
  assert.ok(Math.abs(variance(count, m2) - naiveVariance) < 1e-9);
  assert.ok(Math.abs(stddev(count, m2) - Math.sqrt(naiveVariance)) < 1e-9);
});

test('welfordUpdate: a single observation has mean == value and zero variance', () => {
  const { count, mean, m2 } = welfordUpdate(0, 0, 0, 42);
  assert.equal(count, 1);
  assert.equal(mean, 42);
  assert.equal(variance(count, m2), 0);
});

test('variance/stddev: zero for no observations', () => {
  assert.equal(variance(0, 0), 0);
  assert.equal(stddev(0, 0), 0);
});

// ---- zScore ----

test('zScore: a value exactly at the mean is 0, above the mean is positive, below is negative', () => {
  assert.equal(zScore(100, 100, 10, 1), 0);
  assert.equal(zScore(120, 100, 10, 1), 2);
  assert.equal(zScore(80, 100, 10, 1), -2);
});

test('zScore: floors a near-zero stddev so it never divides by (near) zero', () => {
  const z = zScore(105, 100, 0, 1);
  assert.equal(z, 5); // (105-100)/max(0,1) = 5, not Infinity
});

// ---- getBaseline / updateBaseline (DB-backed) ----

test('getBaseline: returns a zeroed baseline for an entity/metric with no observations yet', () => {
  const db = buildTestDb();
  assert.deepEqual(getBaseline(db, 'u_1', 'amount'), { count: 0, mean: 0, m2: 0 });
});

test('updateBaseline: accumulates across multiple calls, matching a fresh Welford run over the same values', () => {
  const db = buildTestDb();
  const values = [50, 55, 200, 48, 52];
  let expected = { count: 0, mean: 0, m2: 0 };
  for (const v of values) {
    expected = welfordUpdate(expected.count, expected.mean, expected.m2, v);
    updateBaseline(db, 'u_2', 'amount', v, '2026-07-18T10:00:00Z');
  }

  const stored = getBaseline(db, 'u_2', 'amount');
  assert.equal(stored.count, expected.count);
  assert.ok(Math.abs(stored.mean - expected.mean) < 1e-9);
  assert.ok(Math.abs(stored.m2 - expected.m2) < 1e-9);
});

test('updateBaseline: different metrics for the same entity are tracked independently', () => {
  const db = buildTestDb();
  updateBaseline(db, 'u_3', 'amount', 100, '2026-07-18T10:00:00Z');
  updateBaseline(db, 'u_3', 'interval', 60000, '2026-07-18T10:00:00Z');

  assert.equal(getBaseline(db, 'u_3', 'amount').mean, 100);
  assert.equal(getBaseline(db, 'u_3', 'interval').mean, 60000);
});

test('updateBaseline: different entities with the same metric are tracked independently', () => {
  const db = buildTestDb();
  updateBaseline(db, 'u_4', 'amount', 100, '2026-07-18T10:00:00Z');
  updateBaseline(db, 'u_5', 'amount', 900, '2026-07-18T10:00:00Z');

  assert.equal(getBaseline(db, 'u_4', 'amount').mean, 100);
  assert.equal(getBaseline(db, 'u_5', 'amount').mean, 900);
});

test('updateBaseline: last_observed_at is persisted and updated on each call', () => {
  const db = buildTestDb();
  updateBaseline(db, 'u_6', 'amount', 100, '2026-07-18T10:00:00Z');
  updateBaseline(db, 'u_6', 'amount', 110, '2026-07-18T11:00:00Z');

  const row = db.prepare('SELECT last_observed_at FROM entity_baselines WHERE entity_id = ? AND metric = ?').get('u_6', 'amount');
  assert.equal(row.last_observed_at, '2026-07-18T11:00:00Z');
});
