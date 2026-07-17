// Section 15.16, Feature 13: mule-account scoring. A "mule" receives money and quickly moves
// most of it back out -- the same signal withdrawalCorrelation.js already looks for, but that
// module only evaluates receivers caught up in an active structuring burst. This generalizes the
// same receive-then-quickly-drain pattern to *any* account's lifetime history, independent of
// whether a structuring alert ever fired, so a business can be warned "this payee looks like a
// mule" even outside a detected laundering ring.
const { MULE_DETECTION } = require('./config');

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} accountId
 * @param {number} nowMs
 * @returns {{ qualifyingCycles: number, receiptsScanned: number, isMule: boolean }}
 */
function computeMuleScore(db, accountId, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const receipts = db
    .prepare(
      'SELECT amount, timestamp FROM transactions WHERE receiver_id = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT ?'
    )
    .all(accountId, nowIso, MULE_DETECTION.MULE_SCORE_MAX_RECEIPTS_SCANNED);

  let qualifyingCycles = 0;
  for (const receipt of receipts) {
    if (!(receipt.amount > 0)) continue;
    const windowEnd = new Date(new Date(receipt.timestamp).getTime() + MULE_DETECTION.MULE_WINDOW_MS).toISOString();
    const outflow = db
      .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE sender_id = ? AND timestamp > ? AND timestamp <= ?')
      .get(accountId, receipt.timestamp, windowEnd);
    if (outflow.total / receipt.amount >= MULE_DETECTION.MULE_WITHDRAWAL_RATIO) {
      qualifyingCycles += 1;
    }
  }

  return {
    qualifyingCycles,
    receiptsScanned: receipts.length,
    isMule: qualifyingCycles >= MULE_DETECTION.MULE_MIN_QUALIFYING_CYCLES,
  };
}

module.exports = { computeMuleScore };
