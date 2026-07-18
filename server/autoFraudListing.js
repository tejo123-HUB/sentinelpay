// Section 17 (FA198/199, "Auto Blacklisting"/"Auto Whitelisting"): genuine automated list
// population, closing a gap the Section 17 verification pass found -- fraud_lists was previously
// only ever populated via the operator-driven POST /fraud-lists (server/routes/fraudLists.js), so
// "Auto" oversold what was actually just an editable registry the scoring pipeline happened to
// check automatically. These two functions are the system's own triggers, each idempotent (a
// no-op if the account is already on an equal-or-stronger list) and audit-logged the same way a
// manual admin action already is, just with actorIp: 'system' instead of a request IP.
const crypto = require('node:crypto');
const { checkFraudLists } = require('./fraudLists');
const { recordAdminAction } = require('./adminAuditLog');

/**
 * Auto-blacklists a structuring/circular-flow alert's origin the moment the background job
 * persists the alert. A confirmed laundering pattern is exactly the "known bad actor" signal
 * scoring.js's STRUCTURING_ALERT_FLOOR already treats as an automatic block for the active
 * alert window -- extending that to the registry itself means every *future* transaction from
 * this account also floors via FRAUD_LISTS.BLACKLIST_FLOOR, not only the ones still inside that
 * window.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ alert_id: string, sender_id: string, reason: string }} alert
 */
function autoBlacklistStructuringOrigin(db, alert) {
  const existing = checkFraudLists(db, alert.sender_id, alert.sender_id);
  if (existing.blacklisted) return; // already blacklisted -- avoid duplicate spam entries

  const entryId = `fl_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();
  const reason = `Auto-blacklisted: structuring alert ${alert.alert_id} (${alert.reason})`;
  db.prepare('INSERT INTO fraud_lists (entry_id, list_type, account_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    entryId,
    'blacklist',
    alert.sender_id,
    reason,
    nowIso
  );
  recordAdminAction(db, {
    action: 'auto-create',
    targetType: 'fraud_list:blacklist',
    targetId: alert.sender_id,
    detail: reason,
    actorIp: 'system',
  });
}

/**
 * Auto-watchlists a confirmed mule account the first time it's observed during real-time outbound
 * scoring. Watchlist, not blacklist: mule detection is a behavioral heuristic with materially more
 * room for a false positive than a confirmed structuring pattern, so this nudges scoring
 * (FRAUD_LISTS.WATCHLIST_WEIGHT) rather than forcing a block outright -- the same caution level a
 * manually-added watchlist entry already carries.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} accountId
 * @param {number} qualifyingCycles
 */
function autoWatchlistConfirmedMule(db, accountId, qualifyingCycles) {
  const existing = checkFraudLists(db, accountId, accountId);
  if (existing.blacklisted || existing.watchlisted) return; // already flagged at this level or stronger

  const entryId = `fl_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();
  const reason = `Auto-watchlisted: confirmed mule account (${qualifyingCycles} qualifying receive-then-drain cycles)`;
  db.prepare('INSERT INTO fraud_lists (entry_id, list_type, account_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    entryId,
    'watchlist',
    accountId,
    reason,
    nowIso
  );
  recordAdminAction(db, {
    action: 'auto-create',
    targetType: 'fraud_list:watchlist',
    targetId: accountId,
    detail: reason,
    actorIp: 'system',
  });
}

module.exports = { autoBlacklistStructuringOrigin, autoWatchlistConfirmedMule };
