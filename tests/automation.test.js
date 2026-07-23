// Partial-Feature Completion Pass: Automation's real Auto Whitelisting and Adaptive Rule Learning
// gaps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { SCHEMA } = require('../server/db');
const { autoWhitelistTrustedAccount, autoBlacklistStructuringOrigin } = require('../server/autoFraudListing');
const { checkFraudLists } = require('../server/fraudLists');
const { applyRuleWeightMultipliers, recomputeRuleWeightMultipliers } = require('../server/adaptiveRuleWeights');
const { ADAPTIVE_RULE_WEIGHTS, AUTO_WHITELIST } = require('../server/config');

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

// ---- autoWhitelistTrustedAccount ----

test('autoWhitelistTrustedAccount: whitelists an account with enough clean history and low risk', () => {
  const db = buildTestDb();
  autoWhitelistTrustedAccount(db, 'u_trusted', AUTO_WHITELIST.MIN_TXN_COUNT, AUTO_WHITELIST.MAX_REPUTATION_SCORE - 1);
  const check = checkFraudLists(db, 'u_trusted', 'u_trusted');
  assert.equal(check.whitelisted, true);
});

test('autoWhitelistTrustedAccount: does not whitelist below the minimum transaction count', () => {
  const db = buildTestDb();
  autoWhitelistTrustedAccount(db, 'u_new', AUTO_WHITELIST.MIN_TXN_COUNT - 1, 0);
  const check = checkFraudLists(db, 'u_new', 'u_new');
  assert.equal(check.whitelisted, false);
});

test('autoWhitelistTrustedAccount: does not whitelist an account whose reputation score is too high', () => {
  const db = buildTestDb();
  autoWhitelistTrustedAccount(db, 'u_risky', AUTO_WHITELIST.MIN_TXN_COUNT, AUTO_WHITELIST.MAX_REPUTATION_SCORE + 20);
  const check = checkFraudLists(db, 'u_risky', 'u_risky');
  assert.equal(check.whitelisted, false);
});

test('autoWhitelistTrustedAccount: does not whitelist an account that is already blacklisted', () => {
  const db = buildTestDb();
  const nowIso = new Date().toISOString();
  autoBlacklistStructuringOrigin(db, { alert_id: 'alert_1', sender_id: 'u_bad', reason: 'test' });
  autoWhitelistTrustedAccount(db, 'u_bad', 1000, 0);
  const check = checkFraudLists(db, 'u_bad', 'u_bad');
  assert.equal(check.blacklisted, true);
  assert.equal(check.whitelisted, false);
});

test('autoWhitelistTrustedAccount: does not override an existing watchlist entry (regression)', () => {
  // An analyst's own watchlist decision (unrelated to mule detection, a plain POST /fraud-lists
  // entry) must not be silently promoted to/overridden by an auto-whitelist just because the
  // account later racks up enough rule-clean outbound transactions -- that would defeat the
  // analyst's suspicion call the moment a transaction only trips a High- (not Critical-)severity
  // detector, since scoring.js's WHITELIST_CEILING only backs off for Critical flags/active
  // structuring alerts.
  const db = buildTestDb();
  const nowIso = new Date().toISOString();
  db.prepare('INSERT INTO fraud_lists (entry_id, list_type, account_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'fl_watch_1',
    'watchlist',
    'u_watched',
    'analyst suspicion',
    nowIso
  );
  autoWhitelistTrustedAccount(db, 'u_watched', AUTO_WHITELIST.MIN_TXN_COUNT + 50, 0);
  const check = checkFraudLists(db, 'u_watched', 'u_watched');
  assert.equal(check.watchlisted, true);
  assert.equal(check.whitelisted, false);
});

test('autoWhitelistTrustedAccount: is idempotent (a second call does not create a duplicate entry)', () => {
  const db = buildTestDb();
  autoWhitelistTrustedAccount(db, 'u_trusted2', AUTO_WHITELIST.MIN_TXN_COUNT, 0);
  autoWhitelistTrustedAccount(db, 'u_trusted2', AUTO_WHITELIST.MIN_TXN_COUNT + 5, 0);
  const rows = db.prepare("SELECT COUNT(*) AS n FROM fraud_lists WHERE account_id = ? AND list_type = 'whitelist'").get('u_trusted2');
  assert.equal(rows.n, 1);
});

// ---- applyRuleWeightMultipliers ----

test('applyRuleWeightMultipliers: leaves weights unchanged when no adjustments are stored', () => {
  const db = buildTestDb();
  const results = [{ type: 'velocity', flagged: true, weight: 20 }];
  const adjusted = applyRuleWeightMultipliers(db, results);
  assert.equal(adjusted[0].weight, 20);
});

test('applyRuleWeightMultipliers: scales a flagged detector by its stored multiplier', () => {
  const db = buildTestDb();
  db.prepare('INSERT INTO rule_weight_adjustments (flag_type, multiplier, sample_count, last_updated_at) VALUES (?, ?, ?, ?)').run(
    'velocity',
    1.4,
    20,
    new Date().toISOString()
  );
  const results = [
    { type: 'velocity', flagged: true, weight: 20 },
    { type: 'odd_hour', flagged: true, weight: 10 }, // no stored adjustment -- unchanged
    { type: 'velocity', flagged: false, weight: 0 }, // not flagged -- unchanged regardless of multiplier
  ];
  const adjusted = applyRuleWeightMultipliers(db, results);
  assert.equal(adjusted[0].weight, 28);
  assert.equal(adjusted[1].weight, 10);
  assert.equal(adjusted[2].weight, 0);
});

// ---- recomputeRuleWeightMultipliers ----

function seedFlaggedAndLabeled(db, flagType, count, fraudCount) {
  db.prepare('INSERT OR IGNORE INTO users (user_id, created_at) VALUES (?, ?)').run('s', new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO users (user_id, created_at) VALUES (?, ?)').run('r', new Date().toISOString());
  for (let i = 0; i < count; i++) {
    const txId = `t_${flagType}_${i}`;
    db.prepare(
      `INSERT INTO transactions (transaction_id, sender_id, receiver_id, amount, timestamp, transaction_type, fraud_score, decision)
       VALUES (?, 's', 'r', 100, ?, 'transfer', 50, 'step_up')`
    ).run(txId, new Date().toISOString());
    db.prepare('INSERT INTO flags (flag_id, transaction_id, flag_type, reason, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      `fl_${txId}`,
      txId,
      flagType,
      'test',
      20,
      new Date().toISOString()
    );
    db.prepare('INSERT INTO feedback_labels (transaction_id, label, source, created_at) VALUES (?, ?, ?, ?)').run(
      txId,
      i < fraudCount ? 1 : 0,
      'test',
      new Date().toISOString()
    );
  }
}

test('recomputeRuleWeightMultipliers: skips a flag_type below the minimum sample size', () => {
  const db = buildTestDb();
  seedFlaggedAndLabeled(db, 'velocity', ADAPTIVE_RULE_WEIGHTS.MIN_SAMPLE_SIZE - 1, ADAPTIVE_RULE_WEIGHTS.MIN_SAMPLE_SIZE - 1);
  const updated = recomputeRuleWeightMultipliers(db, new Date().toISOString());
  assert.equal(updated.length, 0);
});

test('recomputeRuleWeightMultipliers: a consistently-confirmed detector drifts its multiplier up toward MAX', () => {
  const db = buildTestDb();
  seedFlaggedAndLabeled(db, 'geo_risk', ADAPTIVE_RULE_WEIGHTS.MIN_SAMPLE_SIZE + 2, ADAPTIVE_RULE_WEIGHTS.MIN_SAMPLE_SIZE + 2); // 100% confirmed fraud
  const updated = recomputeRuleWeightMultipliers(db, new Date().toISOString());
  assert.equal(updated.length, 1);
  assert.ok(updated[0].multiplier > 1, `expected multiplier to rise above 1, got ${updated[0].multiplier}`);
  assert.ok(updated[0].multiplier <= ADAPTIVE_RULE_WEIGHTS.MAX_MULTIPLIER);
});

test('recomputeRuleWeightMultipliers: a consistently-wrong detector drifts its multiplier down toward MIN', () => {
  const db = buildTestDb();
  seedFlaggedAndLabeled(db, 'odd_hour', ADAPTIVE_RULE_WEIGHTS.MIN_SAMPLE_SIZE + 2, 0); // 0% confirmed fraud -- every labeled flag was a false positive
  const updated = recomputeRuleWeightMultipliers(db, new Date().toISOString());
  assert.equal(updated.length, 1);
  assert.ok(updated[0].multiplier < 1, `expected multiplier to fall below 1, got ${updated[0].multiplier}`);
  assert.ok(updated[0].multiplier >= ADAPTIVE_RULE_WEIGHTS.MIN_MULTIPLIER);
});

test('recomputeRuleWeightMultipliers: moves gradually (damped), not straight to the target, on a single scan', () => {
  const db = buildTestDb();
  seedFlaggedAndLabeled(db, 'device_mismatch', ADAPTIVE_RULE_WEIGHTS.MIN_SAMPLE_SIZE + 2, ADAPTIVE_RULE_WEIGHTS.MIN_SAMPLE_SIZE + 2); // target would be MAX_MULTIPLIER
  const updated = recomputeRuleWeightMultipliers(db, new Date().toISOString());
  assert.ok(updated[0].multiplier < ADAPTIVE_RULE_WEIGHTS.MAX_MULTIPLIER, 'a single scan should not jump straight to the clamped target');
});
