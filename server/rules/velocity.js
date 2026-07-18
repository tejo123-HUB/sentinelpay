// Dynamic Risk Engine (Merchant Risk Intelligence pass): flags a sender transacting faster than
// *their own* historical pace, not faster than one fixed count that's identical for every
// account. Previously: "more than 5 transactions in 60 seconds", the same ceiling for a
// low-activity personal account and a high-throughput storefront. Now: compare the average
// spacing of this recent burst against the sender's own learned interval baseline
// (server/adaptiveBaseline.js, updated on every transaction in userProfile.js) via a z-score --
// how many standard deviations *faster* than usual is this burst, for this specific sender.
const { ADAPTIVE_BASELINE } = require('../config');
const { stddev, zScore } = require('../adaptiveBaseline');

const VELOCITY_WINDOW_MS = 60 * 1000; // rolling lookback window for counting recent transactions
const VELOCITY_WEIGHT = 35; // contribution to the 0-100 fraud score when flagged (see scoring.js for the combining formula)

/**
 * @param {{ timestamp: string }} transaction
 * @param {{ recentTransactions: Array<{ timestamp: string }>, intervalBaseline: {count:number,mean:number,m2:number} }} userHistory
 * @returns {{ flagged: boolean, reason: string|null, weight: number, severity: string|null }}
 */
function velocity(transaction, userHistory) {
  const txTime = new Date(transaction.timestamp).getTime();
  const windowStart = txTime - VELOCITY_WINDOW_MS;

  const recentCount = (userHistory.recentTransactions || []).filter((t) => {
    const tTime = new Date(t.timestamp).getTime();
    return tTime >= windowStart && tTime < txTime;
  }).length;

  // A burst needs at least a handful of transactions before "average spacing" is even a
  // meaningful quantity -- one or two transactions can't establish a rate.
  if (recentCount < ADAPTIVE_BASELINE.VELOCITY_MIN_BURST_COUNT - 1) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  // This burst's own average spacing: recentCount prior transactions plus this one, spread over
  // the window they actually span.
  const observedIntervalMs = VELOCITY_WINDOW_MS / recentCount;

  const baseline = userHistory.intervalBaseline;
  const hasBaseline = baseline && baseline.count >= ADAPTIVE_BASELINE.MIN_HISTORY_FOR_BASELINE;
  const baselineMean = hasBaseline ? baseline.mean : ADAPTIVE_BASELINE.VELOCITY_DEFAULT_INTERVAL_MS;
  const baselineStddev = hasBaseline ? stddev(baseline.count, baseline.m2) : ADAPTIVE_BASELINE.VELOCITY_DEFAULT_STDDEV_MS;

  // Sign flipped from the usual zScore reading: a *shorter* interval than usual is what's
  // suspicious here, so "baselineMean - observedIntervalMs" is positive when this burst is
  // faster than the sender's own typical pace.
  const z = zScore(baselineMean - observedIntervalMs, 0, baselineStddev, ADAPTIVE_BASELINE.VELOCITY_STDDEV_FLOOR_MS);

  if (z > ADAPTIVE_BASELINE.VELOCITY_Z_THRESHOLD) {
    return {
      flagged: true,
      reason: `${recentCount + 1} transactions in ${Math.round(VELOCITY_WINDOW_MS / 1000)} seconds — ${z.toFixed(1)}σ faster than this account's own typical pace`,
      weight: VELOCITY_WEIGHT,
      severity: 'Medium', // Section 15.16, Feature 17: severity backfilled onto the original 5 rule detectors for uniform explainability
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

velocity.VELOCITY_WINDOW_MS = VELOCITY_WINDOW_MS;
velocity.VELOCITY_WEIGHT = VELOCITY_WEIGHT;

module.exports = velocity;
