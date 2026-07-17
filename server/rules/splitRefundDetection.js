// Section 15.16, Feature 7: detects a single purchase being refunded via several smaller
// transactions instead of one -- the structuring pattern applied to refunds instead of payouts
// (e.g. a 10,000 refund arriving as five 2,000 pieces). Requires reference_transaction_id, since
// "split" only means something relative to one specific purchase, not a customer's lifetime
// totals (that broader case is multipleRefundDetection.js's "exceeds original purchase" check).
const SPLIT_REFUND_MIN_COUNT = 3; // this many separate refund transactions against one purchase, before it reads as splitting rather than a legitimate partial-refund correction
const SPLIT_REFUND_WEIGHT = 45; // contribution to the 0-100 fraud score when flagged

/**
 * @param {{ amount: number, purpose: string|null, reference_transaction_id: string|null }} transaction
 * @param {{ referencedPurchase: { amount: number }|null, referencedPurchaseRefundedTotal: number, referencedPurchaseRefundCount: number }} outboundContext
 */
function splitRefundDetection(transaction, outboundContext) {
  const purpose = (transaction.purpose || '').toLowerCase();
  if (!purpose.includes('refund') || !transaction.reference_transaction_id) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const purchase = outboundContext && outboundContext.referencedPurchase;
  if (!purchase) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const priorCount = (outboundContext && outboundContext.referencedPurchaseRefundCount) || 0;
  const priorTotal = (outboundContext && outboundContext.referencedPurchaseRefundedTotal) || 0;
  const projectedCount = priorCount + 1;
  const projectedTotal = priorTotal + transaction.amount;

  if (projectedCount >= SPLIT_REFUND_MIN_COUNT && projectedTotal >= purchase.amount) {
    return {
      flagged: true,
      reason: `Refund split into ${projectedCount} separate transactions totaling ${projectedTotal.toFixed(2)}, matching or exceeding the original purchase of ${purchase.amount.toFixed(2)}`,
      weight: SPLIT_REFUND_WEIGHT,
      severity: 'High',
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

splitRefundDetection.SPLIT_REFUND_MIN_COUNT = SPLIT_REFUND_MIN_COUNT;
splitRefundDetection.SPLIT_REFUND_WEIGHT = SPLIT_REFUND_WEIGHT;

module.exports = splitRefundDetection;
