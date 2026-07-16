// Pure orchestration of the four structuring detectors — no I/O, so it's directly unit-testable.
// The impure background job (backgroundJob.js) wraps this with DB reads/writes and scheduling.
const detectSplits = require('./splitDetection');
const analyzeFanOut = require('./fanOutAnalysis');
const correlateWithdrawal = require('./withdrawalCorrelation');
const buildAlert = require('./chainTracking');

const REALERT_COOLDOWN_MS = 10 * 60 * 1000; // don't re-alert on the same sender pattern within this window

// Default `getPriorReceiverIds`: derives "who has this sender ever paid before the window"
// purely from `allTransactions` itself. Fine for pure-function tests that construct a self-
// contained transaction set, but real callers (backgroundJob.js) MUST supply their own
// DB-backed implementation with an unbounded lookback — see that file for why: `allTransactions`
// here is typically pre-filtered by the caller to a recent lookback window (for split-detection
// performance), and reusing that same bounded set to decide "is this a new contact" would
// wrongly call a receiver "new" just because they haven't been paid in the last ~45 minutes,
// even if they've been paid regularly for months.
function defaultGetPriorReceiverIds(allTransactions) {
  return (senderId, beforeMs) => {
    const ids = new Set();
    for (const t of allTransactions) {
      if (t.sender_id === senderId && new Date(t.timestamp).getTime() < beforeMs) {
        ids.add(t.receiver_id);
      }
    }
    return ids;
  };
}

/**
 * @param {Array<transaction>} allTransactions - all transactions under consideration
 * @param {number} nowMs - epoch ms marking "now"
 * @param {Array<{ sender_id: string, created_at: string }>} existingAlerts - already-recorded
 *   alerts, used purely for cooldown/idempotency so a live pattern isn't re-alerted every cycle.
 * @param {(senderId: string, beforeMs: number) => Iterable<string>} [getPriorReceiverIds] -
 *   returns every receiver_id this sender has transacted with before `beforeMs`, from full
 *   account history (not bounded to `allTransactions`'s own lookback). Defaults to deriving
 *   from `allTransactions` itself, which is only correct when that array already IS the full
 *   history (true in tests; not true in production — see backgroundJob.js).
 * @returns {Array<alertRow>} new structuring_alerts rows to insert
 */
function runStructuringScan(allTransactions, nowMs, existingAlerts = [], getPriorReceiverIds) {
  const resolveGetPriorReceiverIds = getPriorReceiverIds || defaultGetPriorReceiverIds(allTransactions);
  const splitCandidates = detectSplits(allTransactions, nowMs);
  const newAlerts = [];

  for (const candidate of splitCandidates) {
    const recentAlert = existingAlerts.find(
      (a) =>
        a.sender_id === candidate.senderId &&
        nowMs - new Date(a.created_at).getTime() < REALERT_COOLDOWN_MS
    );
    if (recentAlert) continue;

    const windowStartMs = new Date(candidate.windowStart).getTime();
    const priorReceiverIds = resolveGetPriorReceiverIds(candidate.senderId, windowStartMs);

    const fanOut = analyzeFanOut(candidate.transactions, priorReceiverIds);
    if (!fanOut.passesFanOut) continue;

    const windowEndMs = new Date(candidate.windowEnd).getTime();
    const withdrawalResults = fanOut.newReceiverIds.map((receiverId) => {
      const amountReceived = fanOut.receiverTotals.get(receiverId) || 0;
      const receiverOutgoing = allTransactions.filter((t) => t.sender_id === receiverId);
      return correlateWithdrawal(receiverId, amountReceived, windowEndMs, receiverOutgoing);
    });

    // Scope the alert's totals to only the flagged (new) receivers — candidate.totalAmount/count
    // cover the sender's *whole* burst, which can include transfers to already-known receivers
    // that correctly aren't part of this fan-out flag at all. Reporting the whole burst's totals
    // next to a receiver_ids list that only names the new receivers overstates what the flagged
    // relationship actually covers, in the human-readable reason CLAUDE.md requires to be accurate.
    const flaggedTransactions = candidate.transactions.filter((t) => fanOut.newReceiverIds.includes(t.receiver_id));
    const flaggedTotalAmount = flaggedTransactions.reduce((sum, t) => sum + t.amount, 0);
    const flaggedCount = flaggedTransactions.length;

    newAlerts.push(
      buildAlert({
        senderId: candidate.senderId,
        totalAmount: flaggedTotalAmount,
        count: flaggedCount,
        windowStart: candidate.windowStart,
        windowEnd: candidate.windowEnd,
        receiverIds: fanOut.newReceiverIds,
        withdrawalResults,
        nowMs,
      })
    );
  }

  return newAlerts;
}

runStructuringScan.REALERT_COOLDOWN_MS = REALERT_COOLDOWN_MS;

module.exports = runStructuringScan;
