// The feature store: a versioned, point-in-time-correct per-entity behavior-vector layer, built
// on top of the Dynamic Risk Engine's generic (entity_id, metric) Welford accumulator
// (adaptiveBaseline.js / entity_baselines) instead of a bespoke accumulator per feature -- the
// same "one reusable mechanism, not a special-cased column per detector" reasoning
// entity_baselines was already built on.
//
// PROD: a real feature store (e.g. Vertex AI Feature Store) with online/offline stores kept in
// sync via a materialization pipeline -- DEMO: entity_baselines + training_examples in SQLite,
// with replayFeatureHistory below playing the role a real feature store's point-in-time join
// would (reconstructing "what did we know about this entity right before this transaction",
// not "what do we know now").
const { getBaseline, updateBaseline, stddev, zScore } = require('./adaptiveBaseline');
const getOutboundContext = require('./outboundContext');

// device_id/merchant_id/ip_address values share no schema-level guarantee of being disjoint from
// user_ids or from each other -- prefixing keeps them in distinct regions of entity_baselines'
// shared (entity_id, metric) keyspace. The existing user.amount/user.interval entries (raw
// sender_id, unprefixed) and the existing pair refund_interval entries (unprefixed
// "businessId:counterpartyId", via outboundContext.js's refundBaselineEntityId) predate this
// file and are deliberately left as-is below -- reusing outboundContext's own helper for the
// pair entity id rather than inventing a second, differently-formatted id for the same real-world
// pair, which would silently fragment that baseline's history across two keys.
function deviceEntityId(deviceId) {
  return `device:${deviceId}`;
}
function merchantEntityId(merchantId) {
  return `merchant:${merchantId}`;
}
function ipEntityId(ipAddress) {
  return `ip:${ipAddress}`;
}

// Declarative registry of every (entityType, metric) pair this store tracks -- one place that
// knows which behavior vectors exist for which entity types, rather than ad hoc DB calls
// scattered across detectors. Not consumed programmatically yet (each metric's read/update still
// has its own line below, since each needs a different entity-id shape and a different source
// column) -- kept as living documentation of the store's actual coverage, and a natural place to
// register a new metric before wiring its read/update sites.
const ENTITY_METRICS = [
  { entityType: 'user', metric: 'amount' },
  { entityType: 'user', metric: 'interval' },
  { entityType: 'device', metric: 'interval' },
  { entityType: 'merchant', metric: 'interval' },
  { entityType: 'ip', metric: 'interval' },
  { entityType: 'pair', metric: 'amount' },
  { entityType: 'pair', metric: 'refund_interval' },
];

/**
 * Reads every entity_baselines row a given transaction touches, keyed the same way the request
 * path already reads user/pair baselines (userProfile.getUserHistory, outboundContext.js) -- a
 * read-side aggregation over the existing table, not a new source of truth.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} transaction
 */
function readEntityBaselines(db, transaction) {
  const pairId = getOutboundContext.refundBaselineEntityId(transaction.sender_id, transaction.receiver_id);
  return {
    userAmount: getBaseline(db, transaction.sender_id, 'amount'),
    userInterval: getBaseline(db, transaction.sender_id, 'interval'),
    deviceInterval: transaction.device_id ? getBaseline(db, deviceEntityId(transaction.device_id), 'interval') : null,
    merchantInterval: transaction.merchant_id ? getBaseline(db, merchantEntityId(transaction.merchant_id), 'interval') : null,
    ipInterval: transaction.ip_address ? getBaseline(db, ipEntityId(transaction.ip_address), 'interval') : null,
    pairAmount: getBaseline(db, pairId, 'amount'),
    pairRefundInterval: getBaseline(db, pairId, 'refund_interval'),
  };
}

// A stddev floor scaled to 10% of the baseline's own mean (never below 1) -- same
// relative-floor reasoning amountAnomaly.js already uses, so a low-value entity (e.g. a device
// mostly seeing small transactions) doesn't get an artificially huge floor sized for a
// high-value one, or vice versa.
function relativeFloor(baseline, minFloor = 1) {
  return Math.max(minFloor, Math.abs(baseline && baseline.mean ? baseline.mean : 0) * 0.1);
}

function baselineZ(baseline, value) {
  if (!baseline || baseline.count < 2) return 0;
  const sd = stddev(baseline.count, baseline.m2);
  return zScore(value, baseline.mean, sd, relativeFloor(baseline));
}

/**
 * Composite named feature vector for a single transaction, built from entity_baselines z-scores
 * plus reputation/graph context when supplied (Phase B/C wire those in; both are optional here so
 * this function works standalone during Phase A). Supersedes server/ml/features.js's fixed
 * 6-feature list for anything trained on this vector -- features.js is kept as-is so the existing
 * logistic model keeps working unchanged (see server/ml/mlClient.js's model_type dispatch).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} transaction
 * @param {{ reputationContext?: {score: number}, graphContext?: {clusterRiskScore?: number} }} [context]
 * @returns {Record<string, number>}
 */
function computeFeatureVector(db, transaction, context = {}) {
  const baselines = readEntityBaselines(db, transaction);
  const pairId = getOutboundContext.refundBaselineEntityId(transaction.sender_id, transaction.receiver_id);
  const lastRefundBaseline = getBaseline(db, pairId, 'refund_interval');

  return {
    amount: transaction.amount,
    user_amount_z: baselineZ(baselines.userAmount, transaction.amount),
    user_history_count: baselines.userAmount.count,
    pair_amount_z: baselineZ(baselines.pairAmount, transaction.amount),
    pair_refund_history_count: lastRefundBaseline.count,
    device_history_count: baselines.deviceInterval ? baselines.deviceInterval.count : 0,
    merchant_history_count: baselines.merchantInterval ? baselines.merchantInterval.count : 0,
    ip_history_count: baselines.ipInterval ? baselines.ipInterval.count : 0,
    reputation_score: context.reputationContext ? context.reputationContext.score : 50,
    graph_cluster_risk: context.graphContext ? context.graphContext.clusterRiskScore || 0 : 0,
    // Set by ml/load_datasets.py's map_paysim_row when a training row came from the external
    // dataset rather than this app's own history -- lets the model weight provenance instead of
    // pretending the two sources are identical (see architecture.md Section 9).
    is_external_source: 0,
  };
}

// `whereCol` below is always one of the three hardcoded literals this file passes itself, never
// derived from request input -- same safe-interpolation reasoning already applied to
// outboundContext.js's findSharedAccountIds.
function updateIntervalBaseline(db, entityId, whereCol, whereVal, uptoRowid, nowIso) {
  const lastTwo = db
    .prepare(`SELECT timestamp FROM transactions WHERE ${whereCol} AND rowid <= ? ORDER BY rowid DESC LIMIT 2`)
    .all(whereVal, uptoRowid);
  if (lastTwo.length === 2) {
    const intervalMs = new Date(lastTwo[0].timestamp).getTime() - new Date(lastTwo[1].timestamp).getTime();
    if (intervalMs >= 0) {
      updateBaseline(db, entityId, 'interval', intervalMs, nowIso);
    }
  }
}

/**
 * Updates the device/merchant/ip/pair baselines a transaction touches. Takes the transaction's
 * own rowid explicitly (rather than always reading "the latest two rows") so the exact same
 * function is safe to call both live (right after INSERT, where uptoRowid is trivially "the only
 * row that could matter") and from replayFeatureHistory's offline backfill (where every row
 * already exists in the table and an unbounded query would leak future transactions into a past
 * entity's baseline -- the one thing point-in-time correctness cannot tolerate).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} transaction
 * @param {number} uptoRowid - this transaction's own rowid; bounds every lookback query
 */
function updateEntityBaselinesAfterTransaction(db, transaction, uptoRowid) {
  const nowIso = transaction.timestamp;

  if (transaction.device_id) {
    updateIntervalBaseline(db, deviceEntityId(transaction.device_id), 'device_id = ?', transaction.device_id, uptoRowid, nowIso);
  }
  if (transaction.merchant_id) {
    updateIntervalBaseline(db, merchantEntityId(transaction.merchant_id), 'merchant_id = ?', transaction.merchant_id, uptoRowid, nowIso);
  }
  if (transaction.ip_address) {
    updateIntervalBaseline(db, ipEntityId(transaction.ip_address), 'ip_address = ?', transaction.ip_address, uptoRowid, nowIso);
  }

  const pairId = getOutboundContext.refundBaselineEntityId(transaction.sender_id, transaction.receiver_id);
  updateBaseline(db, pairId, 'amount', transaction.amount, nowIso);
}

/**
 * Offline backfill: replays every transaction in chronological (rowid) order, computing each
 * one's feature vector from the entity-baseline state as it existed strictly *before* that
 * transaction, writes it to training_examples, then applies that transaction's own baseline
 * update -- the exact read-then-update order the live request path already follows. This is the
 * mechanism that makes point-in-time correctness real rather than aspirational: a transaction's
 * training features can never see a baseline update from a transaction that happened after it,
 * because updateEntityBaselinesAfterTransaction/updateBaseline are only ever called with that
 * transaction's own rowid as the upper bound.
 *
 * Resets entity_baselines before replaying (a real feature store's offline backfill recomputes
 * from scratch, not incrementally on top of whatever the online store happened to already have) --
 * safe to re-run, but not meant to run interleaved with a live server (same offline/maintenance
 * trust model as scripts/generate_demo_data.js).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} rows written to training_examples
 */
function replayFeatureHistory(db) {
  db.exec('DELETE FROM entity_baselines');

  const transactions = db.prepare('SELECT rowid AS rowid_, * FROM transactions ORDER BY rowid ASC').all();
  const runAt = new Date().toISOString();

  const insertStmt = db.prepare(
    `INSERT INTO training_examples (transaction_id, feature_json, label, computed_at)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET feature_json = excluded.feature_json, computed_at = excluded.computed_at`
  );

  let written = 0;
  for (const row of transactions) {
    const vectorBefore = computeFeatureVector(db, row);
    insertStmt.run(row.transaction_id, JSON.stringify(vectorBefore), runAt);
    written += 1;

    updateBaseline(db, row.sender_id, 'amount', row.amount, row.timestamp);
    const lastTwoForSender = db
      .prepare('SELECT timestamp FROM transactions WHERE sender_id = ? AND rowid <= ? ORDER BY rowid DESC LIMIT 2')
      .all(row.sender_id, row.rowid_);
    if (lastTwoForSender.length === 2) {
      const intervalMs = new Date(lastTwoForSender[0].timestamp).getTime() - new Date(lastTwoForSender[1].timestamp).getTime();
      if (intervalMs >= 0) updateBaseline(db, row.sender_id, 'interval', intervalMs, row.timestamp);
    }

    updateEntityBaselinesAfterTransaction(db, row, row.rowid_);
  }

  return written;
}

module.exports = {
  ENTITY_METRICS,
  computeFeatureVector,
  updateEntityBaselinesAfterTransaction,
  replayFeatureHistory,
  deviceEntityId,
  merchantEntityId,
  ipEntityId,
};
