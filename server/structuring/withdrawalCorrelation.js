// Flags receiving accounts that withdraw/transfer out a large fraction of just-received
// funds shortly after receipt — the hallmark of a "mule" account in a structuring chain.
const WITHDRAWAL_WINDOW_MS = 30 * 60 * 1000; // how long after receipt to watch for a rapid withdrawal
const WITHDRAWAL_RATIO_THRESHOLD = 0.8; // fraction of received funds moved out to flag as a mule

/**
 * @param {string} receiverId
 * @param {number} amountReceived - total this receiver got from the sender in the split window
 * @param {number} windowEndMs - epoch ms marking the end of the receipt window (start point for this check)
 * @param {Array<{ sender_id, amount, timestamp, transaction_type }>} receiverOutgoing - transactions
 *   where this receiver acted as sender (withdrawal or onward transfer = layering).
 * @returns {{ receiverId: string, amountReceived: number, amountOut: number, withdrawalRatio: number, isMule: boolean }}
 */
function correlateWithdrawal(receiverId, amountReceived, windowEndMs, receiverOutgoing) {
  const windowCloseMs = windowEndMs + WITHDRAWAL_WINDOW_MS;

  const amountOut = (receiverOutgoing || [])
    .filter((t) => t.sender_id === receiverId)
    .filter((t) => {
      const tMs = new Date(t.timestamp).getTime();
      return tMs >= windowEndMs && tMs <= windowCloseMs;
    })
    .reduce((sum, t) => sum + t.amount, 0);

  const withdrawalRatio = amountReceived > 0 ? amountOut / amountReceived : 0;

  return {
    receiverId,
    amountReceived,
    amountOut,
    withdrawalRatio,
    isMule: withdrawalRatio >= WITHDRAWAL_RATIO_THRESHOLD,
  };
}

correlateWithdrawal.WITHDRAWAL_WINDOW_MS = WITHDRAWAL_WINDOW_MS;
correlateWithdrawal.WITHDRAWAL_RATIO_THRESHOLD = WITHDRAWAL_RATIO_THRESHOLD;

module.exports = correlateWithdrawal;
