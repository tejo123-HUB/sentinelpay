// Combines split + fan-out + withdrawal-correlation results into a single structuring_alerts
// row and a human-readable reason — never surfaced as dozens of individual small-transaction flags.
const crypto = require('node:crypto');

/**
 * @param {{
 *   senderId: string,
 *   totalAmount: number,
 *   count: number,
 *   windowStart: string,
 *   windowEnd: string,
 *   receiverIds: string[],
 *   withdrawalResults: Array<{ receiverId: string, withdrawalRatio: number, isMule: boolean }>,
 *   nowMs: number
 * }} input
 * @returns {{ alert_id, sender_id, receiver_ids: string, total_amount, transaction_count,
 *   window_start, window_end, withdrawal_ratio, created_at, reason }}
 */
function buildAlert(input) {
  const { senderId, totalAmount, count, windowStart, windowEnd, receiverIds, withdrawalResults, nowMs } = input;

  const muleAccounts = (withdrawalResults || []).filter((r) => r.isMule);
  const totalReceivedByFlagged = (withdrawalResults || []).reduce((s, r) => s + r.amountReceived, 0);
  const totalOutByFlagged = (withdrawalResults || []).reduce((s, r) => s + r.amountOut, 0);
  const combinedWithdrawalRatio = totalReceivedByFlagged > 0 ? totalOutByFlagged / totalReceivedByFlagged : null;

  // Layering signal: a receiver forwarding funds onward (not just cashing out) implies a
  // second hop in the chain, i.e. sender -> receiver -> next-hop rather than a flat cash-out.
  const chainDepth = muleAccounts.length > 0 ? 2 : 1;

  const reasonParts = [
    `${count} transactions totaling ${totalAmount.toFixed(2)} from ${senderId} split across ${receiverIds.length} receivers within the window`,
  ];
  if (muleAccounts.length > 0) {
    // The lower bound across all cited mules, not muleAccounts[0] (an arbitrary Map-insertion-
    // order pick) — "over X%+" must be true of *every* account it's claimed for, not just the
    // first one encountered, or the human-readable reason can overstate the pattern (e.g.
    // claiming "2 receivers withdrew over 99%+" when one only reached 85%).
    const minMuleRatio = Math.min(...muleAccounts.map((r) => r.withdrawalRatio));
    reasonParts.push(
      `${muleAccounts.length} of ${receiverIds.length} receivers withdrew over ${Math.round(
        minMuleRatio * 100
      )}%+ of received funds within ${Math.round(require('./withdrawalCorrelation').WITHDRAWAL_WINDOW_MS / 60000)} minutes (mule pattern, chain depth ${chainDepth})`
    );
  }

  return {
    alert_id: `sa_${crypto.randomUUID()}`,
    sender_id: senderId,
    receiver_ids: JSON.stringify(receiverIds),
    total_amount: totalAmount,
    transaction_count: count,
    window_start: windowStart,
    window_end: windowEnd,
    withdrawal_ratio: combinedWithdrawalRatio,
    created_at: new Date(nowMs != null ? nowMs : Date.now()).toISOString(),
    reason: reasonParts.join('; '),
  };
}

module.exports = buildAlert;
