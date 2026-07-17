// Section 16, Category 2: flags a transaction that closely duplicates one this business account
// just sent -- same receiver, same amount, within a short window. Distinct from every other
// outbound detector, which all judge whether a transaction is *individually* risky, not whether
// it's a probable accidental double-submit or scripted replay of an already-processed one.
const DUPLICATE_TRANSACTION_WEIGHT = 30; // contribution to the 0-100 fraud score when flagged

/**
 * @param {{ amount: number }} transaction
 * @param {{ duplicateTransactionCount: number }} outboundContext
 */
function duplicateTransaction(transaction, outboundContext) {
  const priorCount = (outboundContext && outboundContext.duplicateTransactionCount) || 0;
  if (priorCount > 0) {
    return {
      flagged: true,
      reason: `Duplicate of ${priorCount} other transaction(s) to the same receiver for the same amount (${transaction.amount.toFixed(2)}) sent moments ago`,
      weight: DUPLICATE_TRANSACTION_WEIGHT,
      severity: 'Medium',
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

duplicateTransaction.DUPLICATE_TRANSACTION_WEIGHT = DUPLICATE_TRANSACTION_WEIGHT;

module.exports = duplicateTransaction;
