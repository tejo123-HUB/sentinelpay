// Continuous Learning Extension, Phase B: self-updating composite reputation, per entity.
// Distinct from server/muleScore.js (a specific, narrow "receive-then-quickly-drain" pattern) --
// this is the general "how has this entity's own history looked so far" score, incrementally
// updated on every transaction it's a party to, covering every entity type featureStore.js
// already tracks baselines for (user, device, merchant, ip, business:customer pair).
//
// PROD: a real online-learning reputation model, continuously retrained -- DEMO: a Laplace-
// smoothed flag-rate over entity_reputation's own running counters, with hard floors for
// confirmed-bad accounts (blacklist, mule). Real in the sense that it's genuinely computed from
// this entity's own accumulated history and updated on every transaction, not a static number --
// just not a trained model.
const { REPUTATION } = require('./config');
const { checkFraudLists } = require('./fraudLists');
const { deviceEntityId, merchantEntityId, ipEntityId } = require('./featureStore');
const getOutboundContext = require('./outboundContext');

function readReputationRow(db, entityId, entityType) {
  return (
    db.prepare('SELECT * FROM entity_reputation WHERE entity_id = ? AND entity_type = ?').get(entityId, entityType) || {
      entity_id: entityId,
      entity_type: entityType,
      score: 50,
      flag_count: 0,
      txn_count: 0,
      last_updated_at: null,
    }
  );
}

function smoothedRiskScore(flagCount, txnCount) {
  return (100 * (flagCount + REPUTATION.PRIOR_FLAGGED)) / (txnCount + REPUTATION.PRIOR_TOTAL);
}

/**
 * Composite 0-100 risk score for a single entity (0 = clean, 100 = maximally risky), always paired
 * with a human-readable reasonBreakdown -- never a bare number, per CLAUDE.md's hard rule.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} entityId
 * @param {'user'|'device'|'merchant'|'ip'|'pair'} entityType
 * @returns {{ score: number, reasonBreakdown: string[], flagCount: number, txnCount: number }}
 */
function computeReputationScore(db, entityId, entityType) {
  const row = readReputationRow(db, entityId, entityType);
  const reasonBreakdown = [];

  let score = smoothedRiskScore(row.flag_count, row.txn_count);
  if (row.txn_count > 0) {
    const pct = ((row.flag_count / row.txn_count) * 100).toFixed(0);
    reasonBreakdown.push(`${row.flag_count}/${row.txn_count} (${pct}%) of this entity's transactions have been flagged`);
  } else {
    reasonBreakdown.push('No transaction history yet for this entity');
  }

  // Blacklist/mule status only applies to user accounts -- fraud_lists.account_id and
  // mule_accounts.account_id are both user-account ids, not device/merchant/ip/pair keys.
  if (entityType === 'user') {
    const listCheck = checkFraudLists(db, entityId, entityId);
    if (listCheck.blacklisted) {
      score = Math.max(score, REPUTATION.BLACKLIST_SCORE_FLOOR);
      reasonBreakdown.push('Account is on the fraud blacklist');
    }
    const muleRow = db.prepare('SELECT qualifying_cycles FROM mule_accounts WHERE account_id = ?').get(entityId);
    if (muleRow) {
      score = Math.max(score, REPUTATION.MULE_SCORE_FLOOR);
      reasonBreakdown.push(`Confirmed mule account (${muleRow.qualifying_cycles} qualifying cycles)`);
    }
  }

  return { score: Math.min(100, score), reasonBreakdown, flagCount: row.flag_count, txnCount: row.txn_count };
}

function bumpReputation(db, entityId, entityType, wasFlagged, nowIso) {
  const row = readReputationRow(db, entityId, entityType);
  const txnCount = row.txn_count + 1;
  const flagCount = row.flag_count + (wasFlagged ? 1 : 0);
  const score = Math.min(100, smoothedRiskScore(flagCount, txnCount));

  db.prepare(
    `INSERT INTO entity_reputation (entity_id, entity_type, score, flag_count, txn_count, last_updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, entity_type) DO UPDATE SET score = excluded.score, flag_count = excluded.flag_count, txn_count = excluded.txn_count, last_updated_at = excluded.last_updated_at`
  ).run(entityId, entityType, score, flagCount, txnCount, nowIso);
}

/**
 * Cheap O(1) incremental update (running counters, one upsert per touched entity) -- called
 * synchronously in the request path, same cost class as featureStore.js's
 * updateEntityBaselinesAfterTransaction, so this stays inside CLAUDE.md's synchronous-scoring
 * rule rather than needing an async/background pass.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} transaction
 * @param {Array<{flagged: boolean}>} ruleResults - this transaction's own detector results
 */
function updateReputationAfterTransaction(db, transaction, ruleResults) {
  const nowIso = transaction.timestamp;
  const wasFlagged = (ruleResults || []).some((r) => r.flagged);

  bumpReputation(db, transaction.sender_id, 'user', wasFlagged, nowIso);
  bumpReputation(db, transaction.receiver_id, 'user', wasFlagged, nowIso);
  if (transaction.device_id) bumpReputation(db, deviceEntityId(transaction.device_id), 'device', wasFlagged, nowIso);
  if (transaction.merchant_id) bumpReputation(db, merchantEntityId(transaction.merchant_id), 'merchant', wasFlagged, nowIso);
  if (transaction.ip_address) bumpReputation(db, ipEntityId(transaction.ip_address), 'ip', wasFlagged, nowIso);

  const pairId = getOutboundContext.refundBaselineEntityId(transaction.sender_id, transaction.receiver_id);
  bumpReputation(db, pairId, 'pair', wasFlagged, nowIso);
}

module.exports = { computeReputationScore, updateReputationAfterTransaction };
