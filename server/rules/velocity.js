// Flags a sender transacting faster than a plausible legitimate rate.
const VELOCITY_WINDOW_MS = 60 * 1000; // rolling lookback window for counting recent transactions
const VELOCITY_MAX_TRANSACTIONS = 5; // more than this many prior transactions in the window triggers a flag
const VELOCITY_WEIGHT = 35; // contribution to the 0-100 fraud score when flagged (see scoring.js for the combining formula)

/**
 * @param {{ timestamp: string }} transaction
 * @param {{ recentTransactions: Array<{ timestamp: string }> }} userHistory
 * @returns {{ flagged: boolean, reason: string|null, weight: number }}
 */
function velocity(transaction, userHistory) {
  const txTime = new Date(transaction.timestamp).getTime();
  const windowStart = txTime - VELOCITY_WINDOW_MS;

  const recentCount = (userHistory.recentTransactions || []).filter((t) => {
    const tTime = new Date(t.timestamp).getTime();
    return tTime >= windowStart && tTime < txTime;
  }).length;

  if (recentCount >= VELOCITY_MAX_TRANSACTIONS) {
    return {
      flagged: true,
      reason: `${recentCount + 1} transactions in ${Math.round(VELOCITY_WINDOW_MS / 1000)} seconds`,
      weight: VELOCITY_WEIGHT,
      severity: 'Medium', // Section 15.16, Feature 17: severity backfilled onto the original 5 rule detectors for uniform explainability
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

velocity.VELOCITY_WINDOW_MS = VELOCITY_WINDOW_MS;
velocity.VELOCITY_MAX_TRANSACTIONS = VELOCITY_MAX_TRANSACTIONS;
velocity.VELOCITY_WEIGHT = VELOCITY_WEIGHT;

module.exports = velocity;
