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

  // Bug fix (post-merge audit): only when there's no explicit reference_transaction_id.
  // outboundContext.js only ever populates referencedPurchase/referencedPurchaseRefundedTotal
  // together with transaction.reference_transaction_id (see outboundContext.js's referencedPurchase
  // block) -- so in the real pipeline, `purchase` being truthy here always means
  // refundWithoutPurchase.js's own referenced-purchase branch already checked this exact same
  // invariant (transaction.amount vs. purchase.amount - referencedPurchaseRefundedTotal) with a
  // more specific, reference-aware reason. Without this guard the two detectors fired together on
  // one underlying fact and double-counted it as two independent signals (55 + 50 weight) --
  // enough on its own to push a transaction to a block decision that neither detector's actual
  // severity would justify alone. This branch stays reachable for a context built without a
  // reference_transaction_id (which can't happen via outboundContext.js today, but keeps this
  // function's own "hard mathematical invariant" check honest as a standalone unit, per this
  // file's header comment, rather than silently deleting it).
  const purchase = outboundContext && outboundContext.referencedPurchase;
  if (purchase && !transaction.reference_transaction_id) {
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
