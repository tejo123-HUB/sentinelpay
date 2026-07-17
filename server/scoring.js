// Combines rule-based flags, the fast structuring-alert lookup, and the ML fraud probability
// into a single 0-100 fraud score. Pure/synchronous by design: callers (the ingestion route)
// are responsible for actually running the rules, the structuring lookup, and the ML client
// beforehand — this module only does the combining, which keeps it independently unit-testable.
const RULE_SCORE_CAP = 100; // cap on summed rule-flag weights before blending with ML, so no single burst of rule flags alone can exceed the 0-100 scale
const ML_MAX_CONTRIBUTION = 30; // max points the ML probability can contribute (probability 1.0 -> 30 points)
const STRUCTURING_ALERT_FLOOR = 90; // if an active structuring alert matches this sender/receiver, the score is floored here
// Section 15.16, Feature 16: any Critical-severity detector floors the score here, above
// decision.js's block threshold (80) -- so a Critical flag always forces a block regardless of
// how the numeric weight sum alone would have scored, the same explicit-floor pattern already
// used for STRUCTURING_ALERT_FLOOR above rather than a second, implicit mechanism. Circular
// laundering and known structuring/fraud rings are already covered by STRUCTURING_ALERT_FLOOR
// (an active structuring_alerts row, direct or circular); this floor is what makes a Critical
// *rule* detector (merchant account takeover, a suspected mule receiver) force the same outcome.
const CRITICAL_SEVERITY_FLOOR = 85;

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
 * Section 15.16, Feature 16/17: also floors the score when any flagged rule carries Critical
 * severity (`CRITICAL_SEVERITY_FLOOR`, above), and returns two additional explainability fields
 * beyond `reasons` -- `riskBreakdown` (one entry per contributing signal: detector type, reason,
 * weight, severity) and `severity` (the single highest severity among all contributing signals,
 * `'None'` if nothing flagged) -- so a caller can render "why" at whatever level of detail it
 * needs without re-deriving it from `reasons` strings.
 *
 * @param {Array<{ type: string, flagged: boolean, reason: string|null, weight: number, severity: string|null }>} ruleResults
 * @param {{ active: boolean, alert: object|null }} structuringLookup
 * @param {number} mlProbability - 0-1
 * @returns {{ score: number, reasons: string[], riskBreakdown: Array<{type: string, reason: string, weight: number, severity: string}>, severity: string }}
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
  const riskBreakdown = flaggedRules.map((r) => ({
    type: r.type || null,
    reason: r.reason,
    weight: r.weight,
    severity: r.severity || null,
  }));

  if (flaggedRules.some((r) => r.severity === 'Critical')) {
    score = Math.max(score, CRITICAL_SEVERITY_FLOOR);
  }

  if (structuringLookup && structuringLookup.active) {
    score = Math.max(score, STRUCTURING_ALERT_FLOOR);
    const alertReason =
      structuringLookup.alert && structuringLookup.alert.reason
        ? structuringLookup.alert.reason
        : 'account linked to a known structuring/laundering pattern';
    const structuringReason = `Structuring alert: ${alertReason}`;
    reasons.push(structuringReason);
    // An active structuring alert is, by definition, a known laundering/fraud-ring pattern --
    // always Critical, same rank as merchant takeover / suspected mule.
    riskBreakdown.push({ type: 'structuring_alert', reason: structuringReason, weight: STRUCTURING_ALERT_FLOOR, severity: 'Critical' });
  }

  const severity = riskBreakdown.reduce(
    (worst, r) => (SEVERITY_RANK[r.severity] > SEVERITY_RANK[worst] ? r.severity : worst),
    'None'
  );

  return { score: Math.round(score), reasons, riskBreakdown, severity };
}

const SEVERITY_RANK = { None: 0, Low: 1, Medium: 2, High: 3, Critical: 4 };

computeFraudScore.RULE_SCORE_CAP = RULE_SCORE_CAP;
computeFraudScore.ML_MAX_CONTRIBUTION = ML_MAX_CONTRIBUTION;
computeFraudScore.STRUCTURING_ALERT_FLOOR = STRUCTURING_ALERT_FLOOR;
computeFraudScore.CRITICAL_SEVERITY_FLOOR = CRITICAL_SEVERITY_FLOOR;
computeFraudScore.SEVERITY_RANK = SEVERITY_RANK;

module.exports = computeFraudScore;
