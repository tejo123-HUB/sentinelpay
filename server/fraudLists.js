// Section 16, Categories 19/21: read-side check against the fraud_lists registry, used by the
// scoring pipeline. Mirrors businessAccounts.js's isBusinessAccount -- a small, focused read
// helper separate from server/routes/fraudLists.js, which owns the CRUD routes for editing it.
// Unlike the outbound-only rule detectors, this check runs for every transaction regardless of
// direction: a blacklisted account doesn't get a pass just because it's receiving rather than
// sending, mirroring the structuring-alert lookup's universal scope (Section 15.12).

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} senderId
 * @param {string} receiverId
 * @returns {{ blacklisted: boolean, whitelisted: boolean, watchlisted: boolean, blacklistEntries: object[], whitelistEntries: object[], watchlistEntries: object[] }}
 */
function checkFraudLists(db, senderId, receiverId) {
  const rows = db
    .prepare('SELECT list_type, account_id, reason FROM fraud_lists WHERE account_id = ? OR account_id = ?')
    .all(senderId, receiverId);

  const blacklistEntries = rows.filter((r) => r.list_type === 'blacklist');
  const whitelistEntries = rows.filter((r) => r.list_type === 'whitelist');
  const watchlistEntries = rows.filter((r) => r.list_type === 'watchlist');

  return {
    blacklisted: blacklistEntries.length > 0,
    whitelisted: whitelistEntries.length > 0,
    watchlisted: watchlistEntries.length > 0,
    blacklistEntries,
    whitelistEntries,
    watchlistEntries,
  };
}

module.exports = { checkFraudLists };
