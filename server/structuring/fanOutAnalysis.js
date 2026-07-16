// Builds a sender -> receivers graph for a window of transactions and flags fan-out to
// multiple receivers who have no prior transaction history with that sender.
const MIN_FANOUT = 3; // minimum count of *new* (no prior history) receivers to flag a fan-out

/**
 * @param {Array<{ receiver_id, amount, timestamp }>} windowTransactions - one sender's transfers
 *   within the split-detection window (see splitDetection.js).
 * @param {Iterable<string>} priorReceiverIds - receiver_ids this same sender has *ever*
 *   transacted with before the window, from the caller's full account history — not just
 *   whatever happens to be in a recent-transactions lookback (see pipeline.js/backgroundJob.js
 *   for why that distinction matters: a receiver_id array here, not raw transaction objects,
 *   deliberately decouples "who is a known contact" from any particular lookback window).
 * @returns {{ receiverIds: string[], newReceiverIds: string[], receiverTotals: Map<string, number>,
 *   passesFanOut: boolean }}
 */
function analyzeFanOut(windowTransactions, priorReceiverIds) {
  const priorReceivers = priorReceiverIds instanceof Set ? priorReceiverIds : new Set(priorReceiverIds || []);

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
