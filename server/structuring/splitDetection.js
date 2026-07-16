// Detects a source account making many small outgoing transfers in a short window that
// sum to an unusually large total — the "split" half of a structuring/smurfing pattern.
const SPLIT_WINDOW_MS = 10 * 60 * 1000; // rolling window for detecting a burst of small transfers
const MIN_SPLIT_COUNT = 5; // minimum number of transfers from one sender in the window to flag
const MIN_SPLIT_TOTAL = 20000; // minimum combined amount moved in the window to be worth flagging
const SINGLE_TX_ALERT_THRESHOLD = 50000; // the single-transaction alert size structuring is designed to evade

/**
 * @param {Array<{ sender_id, receiver_id, amount, timestamp, transaction_type }>} transactions
 *   All transactions under consideration (typically "recent" ones fetched by the caller).
 * @param {number} nowMs - epoch ms marking "now" (the end of the rolling window).
 * @returns {Array<{ senderId: string, transactions: Array, totalAmount: number, count: number,
 *   windowStart: string, windowEnd: string }>} sender groups whose transfer pattern looks like splitting
 */
function detectSplits(transactions, nowMs) {
  const windowStartMs = nowMs - SPLIT_WINDOW_MS;

  const inWindow = transactions.filter((t) => {
    if (t.transaction_type !== 'transfer') return false;
    if (t.amount >= SINGLE_TX_ALERT_THRESHOLD) return false;
    const tMs = new Date(t.timestamp).getTime();
    return tMs >= windowStartMs && tMs <= nowMs;
  });

  const bySender = new Map();
  for (const t of inWindow) {
    if (!bySender.has(t.sender_id)) bySender.set(t.sender_id, []);
    bySender.get(t.sender_id).push(t);
  }

  const candidates = [];
  for (const [senderId, txs] of bySender.entries()) {
    const totalAmount = txs.reduce((sum, t) => sum + t.amount, 0);
    if (txs.length >= MIN_SPLIT_COUNT && totalAmount >= MIN_SPLIT_TOTAL) {
      // windowEnd marks when the actual burst of transfers ended (the latest transfer in the
      // group), not when the background job happened to run its scan. The withdrawal
      // correlation check (withdrawalCorrelation.js) treats windowEnd as "receipt complete,
      // start watching for a rapid cash-out from here" — if this were instead the scan time,
      // a mule account that withdraws within seconds of receiving (the realistic case, and
      // often before the next scan cycle) would have its withdrawal timestamped *before*
      // windowEnd and get wrongly excluded from the correlation window entirely.
      const lastTransferMs = Math.max(...txs.map((t) => new Date(t.timestamp).getTime()));
      candidates.push({
        senderId,
        transactions: txs,
        totalAmount,
        count: txs.length,
        windowStart: new Date(windowStartMs).toISOString(),
        windowEnd: new Date(lastTransferMs).toISOString(),
      });
    }
  }

  return candidates;
}

detectSplits.SPLIT_WINDOW_MS = SPLIT_WINDOW_MS;
detectSplits.MIN_SPLIT_COUNT = MIN_SPLIT_COUNT;
detectSplits.MIN_SPLIT_TOTAL = MIN_SPLIT_TOTAL;
detectSplits.SINGLE_TX_ALERT_THRESHOLD = SINGLE_TX_ALERT_THRESHOLD;

module.exports = detectSplits;
