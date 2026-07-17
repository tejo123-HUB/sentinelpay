// Section 15.16, Feature 2: tracks refund history per customer at this business account.
// Flags either of two conditions -- refund requested multiple times, or the referenced
// purchase's cumulative refunded total would exceed its own amount -- using the exact reason
// strings the spec calls for. Distinct from refundWithoutPurchase.js: that detector judges a
// *single* refund's own validity; this one judges a *pattern* across several refunds.
const config = require('../config');

const MULTIPLE_REFUND_WEIGHT = 35; // contribution to the 0-100 fraud score when flagged
const REFUND_EXCEEDS_PURCHASE_WEIGHT = 50; // stronger signal -- money is actually leaving beyond what was ever paid in

/**
 * @param {{ amount: number, purpose: string|null }} transaction
 * @param {{ refundCountToCustomer: number, referencedPurchase: { amount: number }|null, referencedPurchaseRefundedTotal: number }} outboundContext
 */
function multipleRefundDetection(transaction, outboundContext) {
  const purpose = (transaction.purpose || '').toLowerCase();
  if (!purpose.includes('refund')) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const priorCount = (outboundContext && outboundContext.refundCountToCustomer) || 0;
  if (priorCount + 1 > config.REFUND_INTEGRITY.MAX_REFUNDS_PER_CUSTOMER) {
    return {
      flagged: true,
      reason: 'Multiple refund attempts detected.',
      weight: MULTIPLE_REFUND_WEIGHT,
      severity: 'Medium',
    };
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
