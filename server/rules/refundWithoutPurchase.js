// Flags a refund with no (or insufficient) matching prior purchase from this customer at this
// business account -- the "fake refund" laundering pattern: money leaving the business with no
// legitimate revenue behind it. Scoped to transactions whose purpose says "refund"; vendor
// payouts/settlements legitimately have no "purchase" to match against and shouldn't be judged
// by this rule at all.
const REFUND_WITHOUT_PURCHASE_WEIGHT = 55; // contribution to the 0-100 fraud score when flagged (see scoring.js for the combining formula)

/**
 * @param {{ amount: number, purpose: string|null }} transaction
 * @param {{ priorPurchaseTotal: number, priorRefundTotal: number }} outboundContext
 */
function refundWithoutPurchase(transaction, outboundContext) {
  const purpose = (transaction.purpose || '').toLowerCase();
  if (!purpose.includes('refund')) {
    return { flagged: false, reason: null, weight: 0 };
  }

  const priorPurchaseTotal = (outboundContext && outboundContext.priorPurchaseTotal) || 0;
  // Refunds already issued against this same purchase history must reduce what's left to draw
  // on -- comparing against the gross purchase total alone (the original bug here) let the same
  // purchase justify refund after refund, since the total never went down.
  const priorRefundTotal = (outboundContext && outboundContext.priorRefundTotal) || 0;
  const availableCredit = priorPurchaseTotal - priorRefundTotal;
  if (availableCredit >= transaction.amount) {
    return { flagged: false, reason: null, weight: 0 };
  }

  let reason;
  if (priorRefundTotal > 0) {
    reason = `Refund of ${transaction.amount.toFixed(2)} exceeds this customer's remaining purchase credit (${Math.max(availableCredit, 0).toFixed(2)} of ${priorPurchaseTotal.toFixed(2)} total; ${priorRefundTotal.toFixed(2)} already refunded)`;
  } else if (priorPurchaseTotal > 0) {
    reason = `Refund of ${transaction.amount.toFixed(2)} exceeds this customer's total prior purchases (${priorPurchaseTotal.toFixed(2)}) from this account`;
  } else {
    reason = `Refund of ${transaction.amount.toFixed(2)} has no matching prior purchase from this customer`;
  }

  return { flagged: true, reason, weight: REFUND_WITHOUT_PURCHASE_WEIGHT };
}

refundWithoutPurchase.REFUND_WITHOUT_PURCHASE_WEIGHT = REFUND_WITHOUT_PURCHASE_WEIGHT;

module.exports = refundWithoutPurchase;
