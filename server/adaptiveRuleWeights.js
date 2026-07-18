// Partial-Feature Completion Pass: Automation's "Adaptive Rule Learning" gap. Real, incremental
// per-flag_type weight adjustment, learned from feedback_labels (real analyst verdicts -- see
// server/feedbackLabels.js), not the fixed per-detector weight every flag_type has carried since
// Feature 16/17. Same "reuse the existing periodic background job, too expensive for the
// synchronous per-request path" reasoning as server/graphIntelligence.js's cluster discovery --
// this recomputes on the structuring background job's cycle, and applyRuleWeightMultipliers reads
// the already-computed table on the hot path (one cheap SELECT, same cost class as
// server/customRules.js's per-request rule fetch).
const { ADAPTIVE_RULE_WEIGHTS } = require('./config');

/**
 * Reads every stored multiplier once and applies it to a batch of rule results -- one query
 * regardless of how many flag_types appear, not one lookup per detector.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{type: string, flagged: boolean, weight: number}>} ruleResults
 * @returns {Array<object>} the same results, with `weight` scaled for flagged, adjusted entries
 */
function applyRuleWeightMultipliers(db, ruleResults) {
  if (!ruleResults || ruleResults.length === 0) return ruleResults;
  const rows = db.prepare('SELECT flag_type, multiplier FROM rule_weight_adjustments').all();
  if (rows.length === 0) return ruleResults;
  const multiplierByType = new Map(rows.map((r) => [r.flag_type, r.multiplier]));

  return ruleResults.map((r) => {
    if (!r.flagged || !multiplierByType.has(r.type)) return r;
    return { ...r, weight: r.weight * multiplierByType.get(r.type) };
  });
}

/**
 * Recomputes every flag_type's multiplier from feedback_labels: precision = the fraction of this
 * flag_type's flagged transactions that were later labeled real fraud (label=1), among only those
 * with a label at all (unlabeled transactions carry no verdict either way, so they're excluded,
 * not treated as 0). Target multiplier = precision / 0.5 (a flag_type whose flags are confirmed
 * fraud exactly half the time -- a coin flip -- stays neutral at 1.0; consistently-right detectors
 * drift up toward MAX_MULTIPLIER, consistently-wrong ones drift down toward MIN_MULTIPLIER), moved
 * toward gradually (LEARNING_RATE), not snapped, so one noisy scan can't swing a rule's effective
 * weight wildly.
 *
 * Known limitation (code-review follow-up): a feedback_labels row is a verdict on one
 * *transaction*, not on one *flag* -- a transaction with several co-firing flag_types credits
 * every one of them equally for that verdict, even if only one was the actual signal. A weak
 * detector that frequently co-fires alongside a strong one can therefore have its precision (and
 * so its multiplier) pulled up by flags it didn't itself earn. MIN_SAMPLE_SIZE, the
 * [MIN_MULTIPLIER, MAX_MULTIPLIER] clamp, and LEARNING_RATE's damping all bound how far this can
 * drift a single detector's effective weight -- an accepted trade-off for a real, working
 * per-flag_type learning signal without needing per-flag (not per-transaction) analyst labels,
 * which this app has no mechanism to collect.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} nowIso
 * @returns {Array<{flag_type: string, multiplier: number, sample_count: number}>} updated rows
 */
function recomputeRuleWeightMultipliers(db, nowIso) {
  const rows = db
    .prepare(
      `SELECT f.flag_type AS flag_type, COUNT(*) AS sample_count, COALESCE(SUM(l.label), 0) AS fraud_count
       FROM flags f
       JOIN feedback_labels l ON l.transaction_id = f.transaction_id
       GROUP BY f.flag_type`
    )
    .all();

  const updated = [];
  const upsertStmt = db.prepare(
    `INSERT INTO rule_weight_adjustments (flag_type, multiplier, sample_count, last_updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(flag_type) DO UPDATE SET multiplier = excluded.multiplier, sample_count = excluded.sample_count, last_updated_at = excluded.last_updated_at`
  );
  const existingStmt = db.prepare('SELECT multiplier FROM rule_weight_adjustments WHERE flag_type = ?');

  for (const row of rows) {
    if (row.sample_count < ADAPTIVE_RULE_WEIGHTS.MIN_SAMPLE_SIZE) continue;

    const precision = row.fraud_count / row.sample_count;
    const targetMultiplier = Math.min(ADAPTIVE_RULE_WEIGHTS.MAX_MULTIPLIER, Math.max(ADAPTIVE_RULE_WEIGHTS.MIN_MULTIPLIER, precision / 0.5));

    const existing = existingStmt.get(row.flag_type);
    const currentMultiplier = existing ? existing.multiplier : 1;
    const nextMultiplier = currentMultiplier + ADAPTIVE_RULE_WEIGHTS.LEARNING_RATE * (targetMultiplier - currentMultiplier);
    const clampedMultiplier = Math.min(ADAPTIVE_RULE_WEIGHTS.MAX_MULTIPLIER, Math.max(ADAPTIVE_RULE_WEIGHTS.MIN_MULTIPLIER, nextMultiplier));

    upsertStmt.run(row.flag_type, clampedMultiplier, row.sample_count, nowIso);
    updated.push({ flag_type: row.flag_type, multiplier: clampedMultiplier, sample_count: row.sample_count });
  }

  return updated;
}

module.exports = { applyRuleWeightMultipliers, recomputeRuleWeightMultipliers };
