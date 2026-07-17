const { test } = require('node:test');
const assert = require('node:assert/strict');

const computeFraudScore = require('../server/scoring');
const decide = require('../server/decision');

function ruleResult(flagged, weight, reason = 'flagged', severity = null, type = 'test_rule') {
  return { type, flagged, reason: flagged ? reason : null, weight: flagged ? weight : 0, severity: flagged ? severity : null };
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

// ---- Section 15.16, Feature 16/17: critical-severity floor + explainability fields ----

test('scoring: a Critical-severity flag forces block regardless of its own weight', () => {
  // A moderate weight (50) that alone would only reach step-up, but Critical severity forces
  // the CRITICAL_SEVERITY_FLOOR regardless.
  const ruleResults = [ruleResult(true, 50, 'Receiver is a Suspected Mule Account', 'Critical', 'mule_receiver_risk')];
  const { score } = computeFraudScore(ruleResults, { active: false, alert: null }, 0);

  assert.ok(score >= computeFraudScore.CRITICAL_SEVERITY_FLOOR, `expected the critical floor, got ${score}`);
  assert.equal(decide(score), 'block');
});

test('scoring: riskBreakdown carries type/reason/weight/severity for every contributing signal', () => {
  const ruleResults = [ruleResult(true, 35, 'velocity flag', 'Medium', 'velocity')];
  const structuringLookup = { active: true, alert: { reason: 'known ring' } };
  const { riskBreakdown } = computeFraudScore(ruleResults, structuringLookup, 0);

  assert.equal(riskBreakdown.length, 2);
  assert.deepEqual(riskBreakdown[0], { type: 'velocity', reason: 'velocity flag', weight: 35, severity: 'Medium' });
  assert.equal(riskBreakdown[1].type, 'structuring_alert');
  assert.equal(riskBreakdown[1].severity, 'Critical');
});

test('scoring: severity reflects the highest-ranked contributing signal', () => {
  const ruleResults = [
    ruleResult(true, 20, 'low signal', 'Low', 'device_mismatch'),
    ruleResult(true, 45, 'high signal', 'High', 'outbound_fan_out_burst'),
  ];
  const { severity } = computeFraudScore(ruleResults, { active: false, alert: null }, 0);

  assert.equal(severity, 'High');
});

test('scoring: severity is None when nothing is flagged', () => {
  const { severity, riskBreakdown } = computeFraudScore([ruleResult(false, 0)], { active: false, alert: null }, 0);

  assert.equal(severity, 'None');
  assert.equal(riskBreakdown.length, 0);
});

// ---- Section 16 (Categories 19/21): fraud_lists precedence ----

test('scoring: a blacklisted account forces block regardless of an otherwise clean score', () => {
  const { score, reasons } = computeFraudScore([], { active: false, alert: null }, 0, {
    blacklisted: true,
    whitelisted: false,
    watchlisted: false,
    blacklistEntries: [{ reason: 'confirmed chargeback fraud ring' }],
  });

  assert.ok(score >= computeFraudScore.BLACKLIST_FLOOR);
  assert.equal(decide(score), 'block');
  assert.ok(reasons.some((r) => r.includes('fraud blacklist') && r.includes('confirmed chargeback fraud ring')));
});

test('scoring: a whitelisted account caps an otherwise moderate score', () => {
  const ruleResults = [ruleResult(true, 45, 'amount anomaly', 'Medium', 'amount_anomaly')];
  const { score } = computeFraudScore(ruleResults, { active: false, alert: null }, 0, {
    blacklisted: false,
    whitelisted: true,
    watchlisted: false,
  });

  assert.ok(score <= computeFraudScore.WHITELIST_CEILING);
  assert.equal(decide(score), 'allow');
});

test('scoring: blacklist takes precedence over whitelist if an account is somehow on both', () => {
  const { score } = computeFraudScore([], { active: false, alert: null }, 0, {
    blacklisted: true,
    whitelisted: true,
    watchlisted: false,
    blacklistEntries: [{ reason: null }],
  });

  assert.ok(score >= computeFraudScore.BLACKLIST_FLOOR);
});

test('scoring: an active structuring alert overrides a whitelist entry', () => {
  const { score } = computeFraudScore([], { active: true, alert: { reason: 'known ring' } }, 0, {
    blacklisted: false,
    whitelisted: true,
    watchlisted: false,
  });

  assert.equal(decide(score), 'block');
});

test('scoring: whitelist does not suppress a Critical-severity rule flag', () => {
  const ruleResults = [ruleResult(true, 50, 'Suspected Mule Account', 'Critical', 'mule_receiver_risk')];
  const { score } = computeFraudScore(ruleResults, { active: false, alert: null }, 0, {
    blacklisted: false,
    whitelisted: true,
    watchlisted: false,
  });

  assert.ok(score >= computeFraudScore.CRITICAL_SEVERITY_FLOOR, 'a Critical rule flag must not be washed out by whitelisting');
});

test('scoring: a watchlisted account gets a moderate nudge, not a forced outcome', () => {
  const clean = computeFraudScore([], { active: false, alert: null }, 0, { blacklisted: false, whitelisted: false, watchlisted: false });
  const watchlisted = computeFraudScore([], { active: false, alert: null }, 0, { blacklisted: false, whitelisted: false, watchlisted: true });

  assert.equal(watchlisted.score, clean.score + computeFraudScore.WATCHLIST_WEIGHT);
  assert.ok(watchlisted.reasons.some((r) => r.includes('fraud watchlist')));
});

test('scoring: no fraudListCheck argument behaves exactly as before (backward compatible)', () => {
  const ruleResults = [ruleResult(true, 20, 'device mismatch', 'Low', 'device_mismatch')];
  const { score, severity } = computeFraudScore(ruleResults, { active: false, alert: null }, 0);

  assert.equal(score, 20);
  assert.equal(severity, 'Low');
});

test('decision: threshold boundaries are exact', () => {
  assert.equal(decide(39), 'allow');
  assert.equal(decide(40), 'step_up');
  assert.equal(decide(80), 'step_up');
  assert.equal(decide(81), 'block');
});
