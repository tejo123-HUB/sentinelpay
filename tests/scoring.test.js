const { test } = require('node:test');
const assert = require('node:assert/strict');

const computeFraudScore = require('../server/scoring');
const decide = require('../server/decision');

function ruleResult(flagged, weight, reason = 'flagged') {
  return { flagged, reason: flagged ? reason : null, weight: flagged ? weight : 0 };
}

test('scoring+decision: a clean transaction scores low and is allowed', () => {
  const ruleResults = [
    ruleResult(false, 35),
    ruleResult(false, 40),
    ruleResult(false, 45),
    ruleResult(false, 20),
    ruleResult(false, 20),
  ];
  const { score, reasons } = computeFraudScore(ruleResults, { active: false, alert: null }, 0.05);

  assert.ok(score < 40, `expected a low score, got ${score}`);
  assert.equal(reasons.length, 0);
  assert.equal(decide(score), 'allow');
});

test('scoring+decision: 2+ rule flags push the decision into step-up or block', () => {
  const ruleResults = [
    ruleResult(true, 20, 'device mismatch'),
    ruleResult(true, 20, 'odd hour'),
  ];
  const { score } = computeFraudScore(ruleResults, { active: false, alert: null }, 0.1);

  assert.ok(score >= 40, `expected at least step-up range, got ${score}`);
  assert.notEqual(decide(score), 'allow');
});

test('scoring+decision: several strong rule flags together reach the block tier', () => {
  const ruleResults = [
    ruleResult(true, 35, '5 transactions in 60 seconds'),
    ruleResult(true, 40, '400 km jump in 60 seconds'),
    ruleResult(true, 20, 'previously unseen device'),
  ];
  const { score, reasons } = computeFraudScore(ruleResults, { active: false, alert: null }, 0.2);

  assert.ok(score > 80, `expected block-tier score, got ${score}`);
  assert.equal(decide(score), 'block');
  assert.equal(reasons.length, 3);
});

test('scoring+decision: a single strong anomaly (amount only) lands in step-up, not allow or block', () => {
  const ruleResults = [ruleResult(true, 45, 'amount is 8x average spend')];
  const { score } = computeFraudScore(ruleResults, { active: false, alert: null }, 0.1);

  assert.equal(decide(score), 'step_up');
});

test('scoring+decision: an active structuring alert always forces block, regardless of transaction size', () => {
  const ruleResults = [ruleResult(false, 0), ruleResult(false, 0)];
  const structuringLookup = {
    active: true,
    alert: { reason: '24 accounts split into 6 receivers; 2 mule withdrawals' },
  };

  // Even a tiny, otherwise unremarkable transaction (no rule flags, near-zero ML score).
  const { score, reasons } = computeFraudScore(ruleResults, structuringLookup, 0.01);

  assert.ok(score > 80, `expected block-tier score from structuring alert alone, got ${score}`);
  assert.equal(decide(score), 'block');
  assert.ok(reasons.some((r) => r.includes('Structuring alert')));
});

test('decision: threshold boundaries are exact', () => {
  assert.equal(decide(39), 'allow');
  assert.equal(decide(40), 'step_up');
  assert.equal(decide(80), 'step_up');
  assert.equal(decide(81), 'block');
});
