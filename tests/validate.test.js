const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateTransactionInput, MAX_AMOUNT, MAX_PURPOSE_LENGTH } = require('../server/validate');

function baseInput(overrides = {}) {
  return {
    sender_id: 'u_1',
    receiver_id: 'u_2',
    amount: 100,
    timestamp: '2026-07-18T10:00:00Z',
    transaction_type: 'transfer',
    ...overrides,
  };
}

test('validateTransactionInput: accepts a well-formed request', () => {
  const result = validateTransactionInput(baseInput({ location: { lat: 16.5, lng: 80.6 } }));
  assert.equal(result.valid, true);
});

test('validateTransactionInput: rejects an out-of-range latitude', () => {
  const result = validateTransactionInput(baseInput({ location: { lat: 999, lng: 80.6 } }));
  assert.equal(result.valid, false);
  assert.match(result.error, /lat/);
});

test('validateTransactionInput: rejects an out-of-range longitude', () => {
  const result = validateTransactionInput(baseInput({ location: { lat: 16.5, lng: -999 } }));
  assert.equal(result.valid, false);
  assert.match(result.error, /lng/);
});

test('validateTransactionInput: accepts boundary lat/lng values', () => {
  const result = validateTransactionInput(baseInput({ location: { lat: -90, lng: 180 } }));
  assert.equal(result.valid, true);
});

test('validateTransactionInput: rejects an overlong sender_id', () => {
  const result = validateTransactionInput(baseInput({ sender_id: 'x'.repeat(200) }));
  assert.equal(result.valid, false);
  assert.match(result.error, /sender_id/);
});

test('validateTransactionInput: rejects an overlong device_id', () => {
  const result = validateTransactionInput(baseInput({ device_id: 'x'.repeat(200) }));
  assert.equal(result.valid, false);
  assert.match(result.error, /device_id/);
});

test('validateTransactionInput: rejects sender_id equal to receiver_id', () => {
  const result = validateTransactionInput(baseInput({ sender_id: 'u_1', receiver_id: 'u_1' }));
  assert.equal(result.valid, false);
});

test('validateTransactionInput: rejects a non-positive amount', () => {
  const result = validateTransactionInput(baseInput({ amount: 0 }));
  assert.equal(result.valid, false);
});

test('validateTransactionInput: rejects an amount above the sanity cap (regression)', () => {
  // Previously only checked amount > 0 and finite, so a pathological value like 1e300 passed
  // straight through into avg_transaction_amount and every dashboard total with no sanity check.
  const result = validateTransactionInput(baseInput({ amount: MAX_AMOUNT + 1 }));
  assert.equal(result.valid, false);
  assert.match(result.error, /amount/);
});

test('validateTransactionInput: accepts an amount exactly at the sanity cap', () => {
  const result = validateTransactionInput(baseInput({ amount: MAX_AMOUNT }));
  assert.equal(result.valid, true);
});

test('validateTransactionInput: rejects an invalid transaction_type', () => {
  const result = validateTransactionInput(baseInput({ transaction_type: 'refund' }));
  assert.equal(result.valid, false);
});

test('validateTransactionInput: accepts a purpose note and normalizes a missing one to null', () => {
  const withPurpose = validateTransactionInput(baseInput({ purpose: 'Refund - order #482913' }));
  assert.equal(withPurpose.valid, true);
  assert.equal(withPurpose.value.purpose, 'Refund - order #482913');

  const withoutPurpose = validateTransactionInput(baseInput());
  assert.equal(withoutPurpose.valid, true);
  assert.equal(withoutPurpose.value.purpose, null);
});

test('validateTransactionInput: rejects an overlong purpose', () => {
  const result = validateTransactionInput(baseInput({ purpose: 'x'.repeat(MAX_PURPOSE_LENGTH + 1) }));
  assert.equal(result.valid, false);
  assert.match(result.error, /purpose/);
});
