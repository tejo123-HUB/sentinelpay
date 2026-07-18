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
// Section 16, Categories 19/21: a blacklisted sender/receiver always forces block, regardless of
// direction -- same reasoning as STRUCTURING_ALERT_FLOOR, a confirmed bad actor doesn't get a
// pass just because scoring would otherwise skip this transaction (e.g. an inbound payment).
const BLACKLIST_FLOOR = 95;
// A whitelisted account's score is capped here UNLESS an active structuring alert or blacklist
// entry overrides it (checked first, below) -- whitelisting exists to reduce false positives on
// a known-good relationship, not to give a confirmed bad actor a way out.
const WHITELIST_CEILING = 5;
const WATCHLIST_WEIGHT = 15; // added to the score when watchlisted, not a hard floor/ceiling

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
 * Section 16 (Categories 19/21): also applies the fraud_lists registry (`fraudListCheck`,
 * optional -- callers that don't pass one get the pre-existing behavior unchanged). Precedence,
 * most to least authoritative: an active structuring alert or a blacklist entry always forces
 * block; a whitelist entry only reduces the score when neither of those apply; a watchlist entry
 * just nudges the score up and adds a reason, never forcing an outcome on its own.
 *
 * @param {Array<{ type: string, flagged: boolean, reason: string|null, weight: number, severity: string|null }>} ruleResults
 * @param {{ active: boolean, alert: object|null }} structuringLookup
 * @param {number} mlProbability - 0-1
 * @param {{ blacklisted: boolean, whitelisted: boolean, watchlisted: boolean, blacklistEntries: object[], whitelistEntries: object[] }} [fraudListCheck]
 * @returns {{ score: number, reasons: string[], riskBreakdown: Array<{type: string, reason: string, weight: number, severity: string}>, severity: string, confidence: number }}
 */
function computeFraudScore(ruleResults, structuringLookup, mlProbability, fraudListCheck) {
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

  if (fraudListCheck && fraudListCheck.watchlisted) {
    score = Math.min(100, score + WATCHLIST_WEIGHT);
    const watchlistReason = 'Account appears on the fraud watchlist';
    reasons.push(watchlistReason);
    riskBreakdown.push({ type: 'watchlist', reason: watchlistReason, weight: WATCHLIST_WEIGHT, severity: 'Medium' });
  }

  const structuringActive = !!(structuringLookup && structuringLookup.active);
  const hasCriticalRuleFlag = flaggedRules.some((r) => r.severity === 'Critical');
  if (fraudListCheck && fraudListCheck.blacklisted) {
    score = Math.max(score, BLACKLIST_FLOOR);
    const entryReason = fraudListCheck.blacklistEntries[0] && fraudListCheck.blacklistEntries[0].reason;
    const blacklistReason = `Account is on the fraud blacklist${entryReason ? `: ${entryReason}` : ''}`;
    reasons.push(blacklistReason);
    riskBreakdown.push({ type: 'blacklist', reason: blacklistReason, weight: BLACKLIST_FLOOR, severity: 'Critical' });
  } else if (fraudListCheck && fraudListCheck.whitelisted && !structuringActive && !hasCriticalRuleFlag) {
    // A cap, not a floor -- only ever lowers the score, never raises it above what rules/ML
    // alone already produced. Also never overrides a Critical-severity rule flag (merchant
    // takeover, suspected mule) -- whitelisting exists to reduce friction from routine
    // detectors on a known-good relationship, not to blind scoring to a genuine new red flag on
    // an account that used to be trustworthy.
    score = Math.min(score, WHITELIST_CEILING);
  }

  const severity = riskBreakdown.reduce(
    (worst, r) => (SEVERITY_RANK[r.severity] > SEVERITY_RANK[worst] ? r.severity : worst),
    'None'
  );

  // Section 16, Category 13: "confidence" measures how much independent corroboration backs
  // this decision, distinct from `score` (which measures how *risky* the transaction looks). A
  // single moderate rule flag with no ML/other-detector agreement is a real signal but a
  // low-confidence one; a direct hit against a known record (blacklist, active structuring
  // alert) is near-certain regardless of how many other detectors happened to also fire.
  const isDirectRecordMatch = structuringActive || !!(fraudListCheck && fraudListCheck.blacklisted);
  const mlAgrees = clampedProbability >= 0.5;
  let confidence;
  if (isDirectRecordMatch) {
    confidence = 99; // a direct match against an already-confirmed record, not an inference
  } else if (flaggedRules.length === 0) {
    // Nothing rule-based fired -- confidence here is about how clean the ML signal itself is,
    // not about corroboration (there's nothing to corroborate).
    confidence = clampedProbability < 0.2 ? 85 : clampedProbability < 0.5 ? 55 : 40;
  } else {
    confidence = Math.min(97, 30 + flaggedRules.length * 18 + (hasCriticalRuleFlag ? 15 : 0) + (mlAgrees ? 10 : 0));
  }

  return { score: Math.round(score), reasons, riskBreakdown, severity, confidence: Math.round(confidence) };
}

const SEVERITY_RANK = { None: 0, Low: 1, Medium: 2, High: 3, Critical: 4 };

computeFraudScore.RULE_SCORE_CAP = RULE_SCORE_CAP;
computeFraudScore.ML_MAX_CONTRIBUTION = ML_MAX_CONTRIBUTION;
computeFraudScore.STRUCTURING_ALERT_FLOOR = STRUCTURING_ALERT_FLOOR;
computeFraudScore.CRITICAL_SEVERITY_FLOOR = CRITICAL_SEVERITY_FLOOR;
computeFraudScore.SEVERITY_RANK = SEVERITY_RANK;
computeFraudScore.BLACKLIST_FLOOR = BLACKLIST_FLOOR;
computeFraudScore.WHITELIST_CEILING = WHITELIST_CEILING;
computeFraudScore.WATCHLIST_WEIGHT = WATCHLIST_WEIGHT;

module.exports = computeFraudScore;
