// Dynamic Risk Engine (Merchant Risk Intelligence pass): tracks refund *pacing* per (business,
// customer) pair, not a fixed refund count. Previously: "more than 3 refunds to this customer",
// the same ceiling whether this customer has never been refunded before or is refunded weekly as
// a matter of course for this business. Now: compare the interval since their last refund from
// this business against that pair's own learned refund-interval baseline
// (server/adaptiveBaseline.js) -- a shorter-than-usual gap between refunds is the real signal,
// not a raw count. Distinct from refundWithoutPurchase.js: that detector judges a *single*
// refund's own validity; this one judges a *pattern* across several refunds. The "exceeds the
// original purchase" check below is a hard mathematical invariant (money can't be refunded twice
// over), not a heuristic -- it stays a fixed check on principle, not a baseline.
const { ADAPTIVE_BASELINE } = require('../config');
const { stddev, zScore } = require('../adaptiveBaseline');

const MULTIPLE_REFUND_WEIGHT = 35; // contribution to the 0-100 fraud score when flagged
const REFUND_EXCEEDS_PURCHASE_WEIGHT = 50; // stronger signal -- money is actually leaving beyond what was ever paid in

/**
 * @param {{ amount: number, purpose: string|null, timestamp: string }} transaction
 * @param {{ lastRefundToCustomerAt: string|null, refundIntervalBaseline: {count:number,mean:number,m2:number}, referencedPurchase: { amount: number }|null, referencedPurchaseRefundedTotal: number }} outboundContext
 */
function multipleRefundDetection(transaction, outboundContext) {
  const purpose = (transaction.purpose || '').toLowerCase();
  if (!purpose.includes('refund')) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const lastRefundAt = outboundContext && outboundContext.lastRefundToCustomerAt;
  if (lastRefundAt) {
    const intervalMs = new Date(transaction.timestamp).getTime() - new Date(lastRefundAt).getTime();
    const baseline = outboundContext.refundIntervalBaseline;
    const hasBaseline = baseline && baseline.count >= ADAPTIVE_BASELINE.MIN_HISTORY_FOR_BASELINE;
    const baselineMean = hasBaseline ? baseline.mean : ADAPTIVE_BASELINE.REFUND_DEFAULT_INTERVAL_MS;
    const baselineStddev = hasBaseline ? stddev(baseline.count, baseline.m2) : ADAPTIVE_BASELINE.REFUND_DEFAULT_INTERVAL_MS / 4;

    // Sign flipped, same reasoning as velocity.js: a *shorter* interval than usual is what's
    // suspicious -- "baselineMean - intervalMs" is positive when refunds are coming faster than
    // this pair's own established pace.
    const z = zScore(baselineMean - intervalMs, 0, baselineStddev, ADAPTIVE_BASELINE.REFUND_STDDEV_FLOOR_MS);

    if (z > ADAPTIVE_BASELINE.REFUND_Z_THRESHOLD) {
      return {
        flagged: true,
        reason: `Multiple refund attempts detected — ${z.toFixed(1)}σ faster than this customer's usual refund pacing with this business.`,
        weight: MULTIPLE_REFUND_WEIGHT,
        severity: 'Medium',
      };
    }
  }

  const purchase = outboundContext && outboundContext.referencedPurchase;
  if (purchase) {
    const priorRefundedOnPurchase = (outboundContext && outboundContext.referencedPurchaseRefundedTotal) || 0;
    if (priorRefundedOnPurchase + transaction.amount > purchase.amount) {
      return {
        flagged: true,
        reason: 'Refund amount exceeds original purchase.',
        weight: REFUND_EXCEEDS_PURCHASE_WEIGHT,
        severity: 'High',
      };
    }
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

multipleRefundDetection.MULTIPLE_REFUND_WEIGHT = MULTIPLE_REFUND_WEIGHT;
multipleRefundDetection.REFUND_EXCEEDS_PURCHASE_WEIGHT = REFUND_EXCEEDS_PURCHASE_WEIGHT;

module.exports = multipleRefundDetection;
