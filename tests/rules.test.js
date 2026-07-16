const { test } = require('node:test');
const assert = require('node:assert/strict');

const velocity = require('../server/rules/velocity');
const impossibleTravel = require('../server/rules/impossibleTravel');
const amountAnomaly = require('../server/rules/amountAnomaly');
const deviceMismatch = require('../server/rules/deviceMismatch');
const oddHour = require('../server/rules/oddHour');

const BASE_TIME = new Date('2026-07-18T12:00:00Z').getTime();

function isoAt(offsetMs) {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

// ---- velocity ----

test('velocity: flags a sender exceeding the transaction rate threshold', () => {
  const recentTransactions = Array.from({ length: 5 }, (_, i) => ({
    timestamp: isoAt(-(i + 1) * 5000), // 5 transactions in the last 25 seconds
  }));
  const transaction = { timestamp: isoAt(0) };

  const result = velocity(transaction, { recentTransactions });

  assert.equal(result.flagged, true);
  assert.match(result.reason, /transactions in/);
  assert.ok(result.weight > 0);
});

test('velocity: does not flag normal transaction frequency', () => {
  const recentTransactions = [{ timestamp: isoAt(-45000) }];
  const transaction = { timestamp: isoAt(0) };

  const result = velocity(transaction, { recentTransactions });

  assert.equal(result.flagged, false);
  assert.equal(result.weight, 0);
});

// ---- impossibleTravel ----

test('impossibleTravel: flags a location jump implying implausible speed', () => {
  const userHistory = {
    recentTransactions: [
      { timestamp: isoAt(-30000), location: { lat: 16.5062, lng: 80.6480 } }, // Vijayawada
    ],
  };
  const transaction = {
    timestamp: isoAt(0),
    location: { lat: 19.0760, lng: 72.8777 }, // Mumbai, ~700km away, 30s later
  };

  const result = impossibleTravel(transaction, userHistory);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /km location jump/);
});

test('impossibleTravel: does not flag a small, plausible location change', () => {
  const userHistory = {
    recentTransactions: [
      { timestamp: isoAt(-600000), location: { lat: 16.5062, lng: 80.6480 } },
    ],
  };
  const transaction = {
    timestamp: isoAt(0),
    location: { lat: 16.5100, lng: 80.6500 }, // a couple km away, 10 minutes later
  };

  const result = impossibleTravel(transaction, userHistory);

  assert.equal(result.flagged, false);
});

// ---- amountAnomaly ----

test('amountAnomaly: flags an amount far above the user average', () => {
  const userHistory = { user: { avg_transaction_amount: 200 }, transactionCount: 10 };
  const transaction = { amount: 4000 };

  const result = amountAnomaly(transaction, userHistory);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /average spend/);
});

test('amountAnomaly: does not flag an amount close to the user average', () => {
  const userHistory = { user: { avg_transaction_amount: 200 }, transactionCount: 10 };
  const transaction = { amount: 250 };

  const result = amountAnomaly(transaction, userHistory);

  assert.equal(result.flagged, false);
});

test('amountAnomaly: skips users without meaningful history', () => {
  const userHistory = { user: { avg_transaction_amount: 50 }, transactionCount: 1 };
  const transaction = { amount: 5000 };

  const result = amountAnomaly(transaction, userHistory);

  assert.equal(result.flagged, false);
});

// ---- deviceMismatch ----

test('deviceMismatch: flags a previously unseen device', () => {
  const userHistory = { knownDeviceIds: ['d_1', 'd_2'] };
  const transaction = { device_id: 'd_new' };

  const result = deviceMismatch(transaction, userHistory);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /unseen device/);
});

test('deviceMismatch: does not flag a known device', () => {
  const userHistory = { knownDeviceIds: ['d_1', 'd_2'] };
  const transaction = { device_id: 'd_1' };

  const result = deviceMismatch(transaction, userHistory);

  assert.equal(result.flagged, false);
});

test('deviceMismatch: does not flag a brand-new user\'s first device', () => {
  const userHistory = { knownDeviceIds: [] };
  const transaction = { device_id: 'd_1' };

  const result = deviceMismatch(transaction, userHistory);

  assert.equal(result.flagged, false);
});

// ---- oddHour ----

test('oddHour: flags a transaction outside typical active hours', () => {
  const userHistory = { user: { typical_active_hours: [[8, 22]] } };
  const transaction = { timestamp: '2026-07-18T03:00:00Z' };

  const result = oddHour(transaction, userHistory);

  assert.equal(result.flagged, true);
  assert.match(result.reason, /outside this user's typical active hours/);
});

test('oddHour: does not flag a transaction inside typical active hours', () => {
  const userHistory = { user: { typical_active_hours: [[8, 22]] } };
  const transaction = { timestamp: '2026-07-18T13:00:00Z' };

  const result = oddHour(transaction, userHistory);

  assert.equal(result.flagged, false);
});

test('oddHour: skips users without an established baseline', () => {
  const userHistory = { user: { typical_active_hours: null } };
  const transaction = { timestamp: '2026-07-18T03:00:00Z' };

  const result = oddHour(transaction, userHistory);

  assert.equal(result.flagged, false);
});
