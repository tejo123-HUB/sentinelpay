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
    // ">=" not ">" on the lower bound: timestamps are server-assigned at millisecond
    // resolution, so a receipt immediately followed by an outflow (the exact pattern this
    // function exists to catch) can legitimately land on the same millisecond -- a strict ">"
    // would silently exclude that outflow from the ratio. A row can never match both sides of
    // this comparison (validate.js enforces sender_id != receiver_id), so there's no risk of the
    // receipt counting as its own outflow. Same fix as the same-millisecond race already found
    // and fixed in outboundContext.js (Section 15.13, finding #3) and getOutboundContext's
    // merchant-login-takeover query (Section 15.16).
    const outflow = db
      .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE sender_id = ? AND timestamp >= ? AND timestamp <= ?')
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

// Section 17 (FA217, "Known Mule Database"): persists a confirmed mule to a standing record,
// distinct from computeMuleScore's on-demand scoring above -- called once per outbound
// transaction whose receiver is confirmed a mule (server/routes/transactions.js), not on every
// score computation, so an account that stops qualifying later doesn't silently vanish from the
// record the way a purely live-computed view would.
/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} accountId
 * @param {number} qualifyingCycles
 * @param {number} nowMs
 */
function recordConfirmedMule(db, accountId, qualifyingCycles, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const existing = db.prepare('SELECT account_id FROM mule_accounts WHERE account_id = ?').get(accountId);
  if (existing) {
    db.prepare('UPDATE mule_accounts SET qualifying_cycles = ?, last_seen_at = ? WHERE account_id = ?').run(
      qualifyingCycles,
      nowIso,
      accountId
    );
  } else {
    db.prepare(
      'INSERT INTO mule_accounts (account_id, qualifying_cycles, first_confirmed_at, last_seen_at) VALUES (?, ?, ?, ?)'
    ).run(accountId, qualifyingCycles, nowIso, nowIso);
  }
}

module.exports = { computeMuleScore, recordConfirmedMule };
