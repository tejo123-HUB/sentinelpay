// The Dynamic Risk Engine's statistical core: a generic, reusable per-entity/per-metric rolling
// baseline (mean + variance), updated incrementally on every observation via Welford's online
// algorithm, and a z-score helper for comparing a new observation against that baseline. This is
// what "adaptive baseline" honestly means in this codebase -- real incremental statistics over
// each entity's own history, computed in O(1) per update (no re-scanning history, no fixed
// per-business magic numbers like "amount > 10000" or "refunds > 5"). It is deliberately NOT a
// machine-learning model, a feature store, or an online-learning training loop -- this project
// runs on SQLite with a static local scikit-learn model (see architecture.md Section 9), not
// real ML infrastructure, and claiming otherwise would be exactly the kind of fake capability
// this project's own `// PROD: X — DEMO: Y` convention exists to prevent. What's real here: every
// threshold this powers moves with the entity's own history instead of being the same fixed
// number for a brand-new account and a ten-year power user.
//
// entity_baselines is intentionally generic (entity_id, metric) rather than one column per
// use case: any entity type (customer, business, a (business, customer) pair for refund pacing,
// a device, ...) can have any number of tracked metrics, all going through the same read/update
// path -- the literal "reusable service" this system's Dynamic Risk Engine needs, not a
// special-cased column per detector.

/**
 * Welford's online algorithm: given the existing (count, mean, m2) and a new observation,
 * returns the updated (count, mean, m2) in O(1), with no need to re-scan prior history.
 * `m2` is the running sum of squared differences from the mean -- variance = m2 / count.
 * @param {number} count
 * @param {number} mean
 * @param {number} m2
 * @param {number} value
 * @returns {{ count: number, mean: number, m2: number }}
 */
function welfordUpdate(count, mean, m2, value) {
  const newCount = count + 1;
  const delta = value - mean;
  const newMean = mean + delta / newCount;
  const delta2 = value - newMean;
  const newM2 = m2 + delta * delta2;
  return { count: newCount, mean: newMean, m2: newM2 };
}

/** Population variance (m2 / count) — 0 for count <= 0, matching "no data yet". */
function variance(count, m2) {
  return count > 0 ? m2 / count : 0;
}

/** @returns {number} standard deviation, always >= 0 */
function stddev(count, m2) {
  return Math.sqrt(variance(count, m2));
}

// A stddev of exactly 0 (every observation identical so far, e.g. a new account with one
// transaction) would make any deviation an infinite z-score -- not a meaningful signal yet, just
// an artifact of too little variety in the sample. Flooring stddev at a small positive value
// (configurable per caller, since the natural scale differs wildly between e.g. an amount in
// rupees and an interval in milliseconds) keeps the z-score finite and conservative instead.
/**
 * @param {number} value - the new observation
 * @param {number} mean - baseline mean
 * @param {number} sd - baseline standard deviation
 * @param {number} sdFloor - minimum stddev to divide by, avoids a divide-by-near-zero blowup
 * @returns {number} how many standard deviations `value` is above the mean (negative = below)
 */
function zScore(value, mean, sd, sdFloor) {
  return (value - mean) / Math.max(sd, sdFloor);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} entityId
 * @param {string} metric
 * @returns {{ count: number, mean: number, m2: number }}
 */
function getBaseline(db, entityId, metric) {
  const row = db
    .prepare('SELECT count, mean, m2 FROM entity_baselines WHERE entity_id = ? AND metric = ?')
    .get(entityId, metric);
  return row ? { count: row.count, mean: row.mean, m2: row.m2 } : { count: 0, mean: 0, m2: 0 };
}

/**
 * Reads the current baseline, applies one Welford update for `value`, and persists it. Read-then-
 * write (not a single atomic SQL statement): same documented trade-off userProfile.js's
 * avg_transaction_amount update already accepts for the exact same reason -- under the default
 * ML_SERVING_MODE=local, Node's single-threaded event loop can't interleave another request's
 * handler between the read and write for the *same* entity/metric pair, so there's no real race
 * in the default demo path. A genuine async ML mode reintroduces the same small, already-accepted
 * risk this project already lives with elsewhere, not a new one.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} entityId
 * @param {string} metric
 * @param {number} value
 * @param {string} nowIso
 * @returns {{ count: number, mean: number, m2: number }} the updated baseline
 */
function updateBaseline(db, entityId, metric, value, nowIso) {
  const existing = getBaseline(db, entityId, metric);
  const updated = welfordUpdate(existing.count, existing.mean, existing.m2, value);
  db.prepare(
    `INSERT INTO entity_baselines (entity_id, metric, count, mean, m2, last_observed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, metric) DO UPDATE SET count = excluded.count, mean = excluded.mean, m2 = excluded.m2, last_observed_at = excluded.last_observed_at`
  ).run(entityId, metric, updated.count, updated.mean, updated.m2, nowIso);
  return updated;
}

module.exports = { welfordUpdate, variance, stddev, zScore, getBaseline, updateBaseline };
