// Combines rule-based flags, the fast structuring-alert lookup, and the ML fraud probability
// into a single 0-100 fraud score. Pure/synchronous by design: callers (the ingestion route)
// are responsible for actually running the rules, the structuring lookup, and the ML client
// beforehand — this module only does the combining, which keeps it independently unit-testable.
const RULE_SCORE_CAP = 100; // cap on summed rule-flag weights before blending with ML, so no single burst of rule flags alone can exceed the 0-100 scale
const ML_MAX_CONTRIBUTION = 30; // max points the ML probability can contribute (probability 1.0 -> 30 points)
const STRUCTURING_ALERT_FLOOR = 90; // if an active structuring alert matches this sender/receiver, the score is floored here

/**
 * Weighting formula:
 *   1. Sum the `weight` of every flagged rule (server/rules/*.js), capped at RULE_SCORE_CAP.
 *   2. Add the ML fraud probability (0-1, from server/ml/mlClient.js) scaled to a max of
 *      ML_MAX_CONTRIBUTION points.
 *   3. Clamp the running total to [0, 100].
 *   4. If the structuring-alert fast lookup (server/structuring/alertLookup.js) found an
 *      active alert for this sender/receiver, floor the score at STRUCTURING_ALERT_FLOOR —
 *      a known laundering pattern always dominates, regardless of how small or ordinary this
 *      individual transaction looks on its own (Task 7 DoD requirement).
 *
 * @param {Array<{ flagged: boolean, reason: string|null, weight: number }>} ruleResults
 * @param {{ active: boolean, alert: object|null }} structuringLookup
 * @param {number} mlProbability - 0-1
 * @returns {{ score: number, reasons: string[] }}
 */
function computeFraudScore(ruleResults, structuringLookup, mlProbability) {
  const flaggedRules = (ruleResults || []).filter((r) => r.flagged);
  const ruleWeightSum = Math.min(
    flaggedRules.reduce((sum, r) => sum + r.weight, 0),
    RULE_SCORE_CAP
  );

  const clampedProbability = Math.max(0, Math.min(mlProbability || 0, 1));
  const mlContribution = clampedProbability * ML_MAX_CONTRIBUTION;

  let score = Math.max(0, Math.min(100, ruleWeightSum + mlContribution));
  const reasons = flaggedRules.map((r) => r.reason);

  if (structuringLookup && structuringLookup.active) {
    score = Math.max(score, STRUCTURING_ALERT_FLOOR);
    const alertReason =
      structuringLookup.alert && structuringLookup.alert.reason
        ? structuringLookup.alert.reason
        : 'account linked to a known structuring/laundering pattern';
    reasons.push(`Structuring alert: ${alertReason}`);
  }

  return { score: Math.round(score), reasons };
}

computeFraudScore.RULE_SCORE_CAP = RULE_SCORE_CAP;
computeFraudScore.ML_MAX_CONTRIBUTION = ML_MAX_CONTRIBUTION;
computeFraudScore.STRUCTURING_ALERT_FLOOR = STRUCTURING_ALERT_FLOOR;

module.exports = computeFraudScore;
