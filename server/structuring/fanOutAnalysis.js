// Builds a sender -> receivers graph for a window of transactions and flags fan-out to
// multiple receivers who have no prior transaction history with that sender.
const MIN_FANOUT = 3; // minimum count of *new* (no prior history) receivers to flag a fan-out

/**
 * @param {Array<{ receiver_id, amount, timestamp }>} windowTransactions - one sender's transfers
 *   within the split-detection window (see splitDetection.js).
 * @param {Array<{ receiver_id }>} priorTransactions - that same sender's transactions from
 *   before the window, used to determine which receivers are "new".
 * @returns {{ receiverIds: string[], newReceiverIds: string[], receiverTotals: Map<string, number>,
 *   passesFanOut: boolean }}
 */
function analyzeFanOut(windowTransactions, priorTransactions) {
  const priorReceivers = new Set((priorTransactions || []).map((t) => t.receiver_id));

  const receiverTotals = new Map();
  for (const t of windowTransactions) {
    receiverTotals.set(t.receiver_id, (receiverTotals.get(t.receiver_id) || 0) + t.amount);
  }

  const receiverIds = [...receiverTotals.keys()];
  const newReceiverIds = receiverIds.filter((id) => !priorReceivers.has(id));

  return {
    receiverIds,
    newReceiverIds,
    receiverTotals,
    passesFanOut: newReceiverIds.length >= MIN_FANOUT,
  };
}

analyzeFanOut.MIN_FANOUT = MIN_FANOUT;

module.exports = analyzeFanOut;
