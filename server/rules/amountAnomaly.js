// Flags a transaction amount that is a large multiple of the sender's rolling average spend.
const AMOUNT_ANOMALY_MULTIPLIER = 3; // flag if amount exceeds this multiple of the user's average
const AMOUNT_ANOMALY_WEIGHT = 45; // contribution to the 0-100 fraud score when flagged (see scoring.js for the combining formula)
const MIN_HISTORY_FOR_ANOMALY = 3; // don't flag until the user has this many prior transactions (no meaningful baseline yet)

/**
 * @param {{ amount: number }} transaction
 * @param {{ user: { avg_transaction_amount: number }|null, transactionCount: number }} userHistory
 */
function amountAnomaly(transaction, userHistory) {
  const avg = userHistory.user ? userHistory.user.avg_transaction_amount : 0;
  const count = userHistory.transactionCount || 0;

  if (!avg || avg <= 0 || count < MIN_HISTORY_FOR_ANOMALY) {
    return { flagged: false, reason: null, weight: 0 };
  }

  if (transaction.amount > AMOUNT_ANOMALY_MULTIPLIER * avg) {
    const multiple = (transaction.amount / avg).toFixed(1);
    return {
      flagged: true,
      reason: `Amount is ${multiple}x the user's average spend (${avg.toFixed(2)})`,
      weight: AMOUNT_ANOMALY_WEIGHT,
    };
  }

  return { flagged: false, reason: null, weight: 0 };
}

amountAnomaly.AMOUNT_ANOMALY_MULTIPLIER = AMOUNT_ANOMALY_MULTIPLIER;
amountAnomaly.AMOUNT_ANOMALY_WEIGHT = AMOUNT_ANOMALY_WEIGHT;
amountAnomaly.MIN_HISTORY_FOR_ANOMALY = MIN_HISTORY_FOR_ANOMALY;

module.exports = amountAnomaly;
