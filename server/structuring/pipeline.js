// Pure orchestration of the four structuring detectors — no I/O, so it's directly unit-testable.
// The impure background job (backgroundJob.js) wraps this with DB reads/writes and scheduling.
const detectSplits = require('./splitDetection');
const analyzeFanOut = require('./fanOutAnalysis');
const correlateWithdrawal = require('./withdrawalCorrelation');
const buildAlert = require('./chainTracking');

const REALERT_COOLDOWN_MS = 10 * 60 * 1000; // don't re-alert on the same sender pattern within this window

/**
 * @param {Array<transaction>} allTransactions - all transactions under consideration
 * @param {number} nowMs - epoch ms marking "now"
 * @param {Array<{ sender_id: string, created_at: string }>} existingAlerts - already-recorded
 *   alerts, used purely for cooldown/idempotency so a live pattern isn't re-alerted every cycle.
 * @returns {Array<alertRow>} new structuring_alerts rows to insert
 */
function runStructuringScan(allTransactions, nowMs, existingAlerts = []) {
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
    const priorTransactions = allTransactions.filter(
      (t) => t.sender_id === candidate.senderId && new Date(t.timestamp).getTime() < windowStartMs
    );

    const fanOut = analyzeFanOut(candidate.transactions, priorTransactions);
    if (!fanOut.passesFanOut) continue;

    const windowEndMs = new Date(candidate.windowEnd).getTime();
    const withdrawalResults = fanOut.newReceiverIds.map((receiverId) => {
      const amountReceived = fanOut.receiverTotals.get(receiverId) || 0;
      const receiverOutgoing = allTransactions.filter((t) => t.sender_id === receiverId);
      return correlateWithdrawal(receiverId, amountReceived, windowEndMs, receiverOutgoing);
    });

    newAlerts.push(
      buildAlert({
        senderId: candidate.senderId,
        totalAmount: candidate.totalAmount,
        count: candidate.count,
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
