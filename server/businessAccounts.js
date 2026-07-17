// Shared read-side check against the business_accounts registry (server/routes/
// businessAccounts.js owns the CRUD routes for editing it). Used by the scoring pipeline
// (server/routes/transactions.js) to decide whether a transaction is outbound -- money leaving
// the business -- which is what fraud/AML behavioral scoring is now scoped to.
function isBusinessAccount(db, accountId) {
  return Boolean(db.prepare('SELECT 1 FROM business_accounts WHERE account_id = ?').get(accountId));
}

module.exports = { isBusinessAccount };
