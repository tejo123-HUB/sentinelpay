// Dynamic Risk Engine (Merchant Risk Intelligence pass): flags a transaction amount that's an
// outlier against *this sender's own* spending variability, not a fixed multiple of their average
// that treats a low-variance and a high-variance spender identically. Previously: "amount > 3x
// the average", the same multiplier whether this sender's amounts are normally tightly clustered
// (a genuine anomaly at 3x) or all over the map (3x might be an ordinary Tuesday for them). Now:
// a real z-score against the sender's own learned mean + standard deviation
// (server/adaptiveBaseline.js, updated on every transaction in userProfile.js).
const { ADAPTIVE_BASELINE } = require('../config');
const { stddev, zScore } = require('../adaptiveBaseline');

const AMOUNT_ANOMALY_WEIGHT = 45; // contribution to the 0-100 fraud score when flagged (see scoring.js for the combining formula)
// Don't flag until the *amount baseline itself* has this many real observations -- the baseline's
// own count is the authoritative "do we have enough variance data yet" signal now that the
// z-score, not transactionCount, is what decides the flag.
const MIN_HISTORY_FOR_ANOMALY = 3;

/**
 * @param {{ amount: number }} transaction
 * @param {{ user: { avg_transaction_amount: number }|null, amountBaseline: {count:number,mean:number,m2:number} }} userHistory
 */
function amountAnomaly(transaction, userHistory) {
  const avg = userHistory.user ? userHistory.user.avg_transaction_amount : 0;
  const baseline = userHistory.amountBaseline;

  if (!avg || avg <= 0 || !baseline || baseline.count < MIN_HISTORY_FOR_ANOMALY) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const sd = stddev(baseline.count, baseline.m2);
  const sdFloor = Math.max(ADAPTIVE_BASELINE.AMOUNT_STDDEV_FLOOR, avg * ADAPTIVE_BASELINE.AMOUNT_MIN_RELATIVE_STDDEV);
  const z = zScore(transaction.amount, avg, sd, sdFloor);

  if (z > ADAPTIVE_BASELINE.AMOUNT_Z_THRESHOLD) {
    const multiple = (transaction.amount / avg).toFixed(1);
    return {
      flagged: true,
      reason: `Amount is ${multiple}x the user's average spend (${avg.toFixed(2)}), ${z.toFixed(1)}σ above this account's own typical variation`,
      weight: AMOUNT_ANOMALY_WEIGHT,
      severity: 'Medium', // Section 15.16, Feature 17: severity backfilled onto the original 5 rule detectors for uniform explainability
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

amountAnomaly.AMOUNT_ANOMALY_WEIGHT = AMOUNT_ANOMALY_WEIGHT;
amountAnomaly.MIN_HISTORY_FOR_ANOMALY = MIN_HISTORY_FOR_ANOMALY;

module.exports = amountAnomaly;
