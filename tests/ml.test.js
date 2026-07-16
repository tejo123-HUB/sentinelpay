const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getFraudProbability, scoreLocal } = require('../server/ml/mlClient');

const cleanTransaction = {
  amount: 150,
  timestamp: '2026-07-18T13:00:00Z',
  device_id: 'd_known',
};
const cleanHistory = {
  user: { avg_transaction_amount: 160, typical_active_hours: [[8, 22]] },
  recentTransactions: [],
  knownDeviceIds: ['d_known'],
};

const suspiciousTransaction = {
  amount: 9000,
  timestamp: '2026-07-18T03:00:00Z',
  device_id: 'd_unknown',
  location: { lat: 19.076, lng: 72.8777 },
};
const suspiciousHistory = {
  user: { avg_transaction_amount: 200, typical_active_hours: [[8, 22]] },
  recentTransactions: [
    { timestamp: '2026-07-18T02:59:00Z', location: { lat: 16.5062, lng: 80.648 } },
    { timestamp: '2026-07-18T02:58:00Z', location: null },
    { timestamp: '2026-07-18T02:57:30Z', location: null },
    { timestamp: '2026-07-18T02:57:00Z', location: null },
    { timestamp: '2026-07-18T02:56:30Z', location: null },
    { timestamp: '2026-07-18T02:56:00Z', location: null },
  ],
  knownDeviceIds: ['d_known'],
};

test('scoreLocal: returns a probability in [0, 1] for a clean transaction', () => {
  const p = scoreLocal(cleanTransaction, cleanHistory);
  assert.ok(p >= 0 && p <= 1, `expected [0,1], got ${p}`);
});

test('scoreLocal: a suspicious multi-signal transaction scores higher than a clean one', () => {
  const clean = scoreLocal(cleanTransaction, cleanHistory);
  const suspicious = scoreLocal(suspiciousTransaction, suspiciousHistory);
  assert.ok(suspicious > clean, `expected suspicious (${suspicious}) > clean (${clean})`);
});

test('getFraudProbability: resolves to a number in [0, 1] under the default local mode', async () => {
  const p = await getFraudProbability(cleanTransaction, cleanHistory);
  assert.equal(typeof p, 'number');
  assert.ok(p >= 0 && p <= 1);
});

test('getFraudProbability: fails open to 0 when ML_SERVING_MODE is an unimplemented backend', async () => {
  const original = process.env.ML_SERVING_MODE;
  process.env.ML_SERVING_MODE = 'vertex';
  try {
    const p = await getFraudProbability(cleanTransaction, cleanHistory);
    assert.equal(p, 0);
  } finally {
    if (original === undefined) delete process.env.ML_SERVING_MODE;
    else process.env.ML_SERVING_MODE = original;
  }
});
