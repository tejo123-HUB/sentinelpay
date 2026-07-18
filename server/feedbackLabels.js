// Continuous Learning Extension, Phase F: turns real analyst decisions this app already supports
// -- blacklisting/whitelisting an account (POST /fraud-lists), resolving a case with a definite
// verdict (PATCH /cases/:caseId's outcome) -- into feedback_labels rows, the literal "retrains
// from analyst decisions" mechanism ml/load_datasets.py's load_app_data() reads. No new UI: these
// are actions analysts already take in this app for other reasons (blocking a bad account,
// closing an investigation); this just also treats them as ground truth.
const FEEDBACK_LABEL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Bounds the per-account labeling cost regardless of lifetime transaction volume -- same
// "unbounded scan would grow per-request cost without limit" reasoning as
// MULE_SCORE_MAX_RECEIPTS_SCANNED (server/config.js).
const FEEDBACK_LABEL_MAX_TRANSACTIONS = 100;

/**
 * Upserts a single transaction's label -- idempotent (a transaction relabeled by a later,
 * different decision, e.g. blacklisted after being whitelisted, gets the newer verdict, not a
 * duplicate row: feedback_labels.transaction_id is the primary key).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} transactionId
 * @param {0|1} label
 * @param {string} source
 * @param {string} nowIso
 */
function labelTransaction(db, transactionId, label, source, nowIso) {
  db.prepare(
    `INSERT INTO feedback_labels (transaction_id, label, source, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET label = excluded.label, source = excluded.source, created_at = excluded.created_at`
  ).run(transactionId, label, source, nowIso);
}

/**
 * Labels an account's recent transactions (as sender or receiver) following a blacklist/whitelist
 * decision -- the account itself was judged, not one specific transaction, so every recent
 * transaction it touched inherits that verdict as a label.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} accountId
 * @param {0|1} label
 * @param {'blacklist'|'whitelist'} source
 * @param {number} nowMs
 * @returns {number} transactions labeled
 */
function labelRecentTransactionsForAccount(db, accountId, label, source, nowMs) {
  const sinceIso = new Date(nowMs - FEEDBACK_LABEL_LOOKBACK_MS).toISOString();
  const rows = db
    .prepare(
      'SELECT transaction_id FROM transactions WHERE (sender_id = ? OR receiver_id = ?) AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?'
    )
    .all(accountId, accountId, sinceIso, FEEDBACK_LABEL_MAX_TRANSACTIONS);

  const nowIso = new Date(nowMs).toISOString();
  for (const row of rows) labelTransaction(db, row.transaction_id, label, source, nowIso);
  return rows.length;
}

/**
 * Labels every transaction linked to a case following its resolution with a definite outcome.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} caseId
 * @param {0|1} label
 * @param {number} nowMs
 * @returns {number} transactions labeled
 */
function labelCaseTransactions(db, caseId, label, nowMs) {
  const rows = db.prepare('SELECT transaction_id FROM case_transactions WHERE case_id = ?').all(caseId);
  const nowIso = new Date(nowMs).toISOString();
  for (const row of rows) labelTransaction(db, row.transaction_id, label, 'case_resolution', nowIso);
  return rows.length;
}

module.exports = {
  labelTransaction,
  labelRecentTransactionsForAccount,
  labelCaseTransactions,
  FEEDBACK_LABEL_LOOKBACK_MS,
  FEEDBACK_LABEL_MAX_TRANSACTIONS,
};
