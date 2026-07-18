// Flags a refund with no (or insufficient) matching prior purchase from this customer at this
// business account -- the "fake refund" laundering pattern: money leaving the business with no
// legitimate revenue behind it. Scoped to transactions whose purpose says "refund"; vendor
// payouts/settlements legitimately have no "purchase" to match against and shouldn't be judged
// by this rule at all.
const REFUND_WITHOUT_PURCHASE_WEIGHT = 55; // contribution to the 0-100 fraud score when flagged (see scoring.js for the combining formula)

/**
 * @param {{ amount: number, purpose: string|null, sender_id: string, receiver_id: string, merchant_id: string|null, reference_transaction_id: string|null }} transaction
 * @param {{ priorPurchaseTotal: number, priorRefundTotal: number, referencedPurchase: object|null, referencedPurchaseRefundedTotal: number }} outboundContext
 */
function refundWithoutPurchase(transaction, outboundContext) {
  const purpose = (transaction.purpose || '').toLowerCase();
  if (!purpose.includes('refund')) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  // Section 15.16, Feature 3: when the refund names the specific purchase it refunds, validate
  // against that purchase directly -- existence, ownership by this business account, not already
  // fully refunded, and amount within what's left. Sharper than the aggregate fallback below,
  // which is all that's available when no reference is given. Same-customer ownership is
  // deliberately left to refundAccountMismatch.js (Feature 1) rather than re-checked here, so
  // the two detectors don't duplicate the same condition under two different reasons.
  if (transaction.reference_transaction_id) {
    const purchase = outboundContext && outboundContext.referencedPurchase;
    if (!purchase) {
      return {
        flagged: true,
        reason: `Refund references purchase ${transaction.reference_transaction_id}, which does not exist`,
        weight: REFUND_WITHOUT_PURCHASE_WEIGHT,
        severity: 'High',
      };
    }
    if (purchase.receiver_id !== transaction.sender_id) {
      return {
        flagged: true,
        reason: 'Referenced purchase was not made to this business account',
        weight: REFUND_WITHOUT_PURCHASE_WEIGHT,
        severity: 'High',
      };
    }
    if (purchase.merchant_id && transaction.merchant_id && purchase.merchant_id !== transaction.merchant_id) {
      return {
        flagged: true,
        reason: `Refund processed through gateway ${transaction.merchant_id}, but the original purchase was made through ${purchase.merchant_id}`,
        weight: REFUND_WITHOUT_PURCHASE_WEIGHT,
        severity: 'Medium',
      };
    }
    const alreadyRefunded = (outboundContext && outboundContext.referencedPurchaseRefundedTotal) || 0;
    const remaining = purchase.amount - alreadyRefunded;
    if (remaining <= 0) {
      return {
        flagged: true,
        reason: 'Referenced purchase has already been fully refunded',
        weight: REFUND_WITHOUT_PURCHASE_WEIGHT,
        severity: 'High',
      };
    }
    if (transaction.amount > remaining) {
      return {
        flagged: true,
        reason: `Refund of ${transaction.amount.toFixed(2)} exceeds the remaining refundable amount (${remaining.toFixed(2)} of ${purchase.amount.toFixed(2)}) on the referenced purchase`,
        weight: REFUND_WITHOUT_PURCHASE_WEIGHT,
        severity: 'High',
      };
    }
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  // Fallback: no reference_transaction_id given -- the original, aggregate customer-level check.
  const priorPurchaseTotal = (outboundContext && outboundContext.priorPurchaseTotal) || 0;
  // Refunds already issued against this same purchase history must reduce what's left to draw
  // on -- comparing against the gross purchase total alone (the original bug here) let the same
  // purchase justify refund after refund, since the total never went down.
  const priorRefundTotal = (outboundContext && outboundContext.priorRefundTotal) || 0;
  const availableCredit = priorPurchaseTotal - priorRefundTotal;
  if (availableCredit >= transaction.amount) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  let reason;
  if (priorRefundTotal > 0) {
    reason = `Refund of ${transaction.amount.toFixed(2)} exceeds this customer's remaining purchase credit (${Math.max(availableCredit, 0).toFixed(2)} of ${priorPurchaseTotal.toFixed(2)} total; ${priorRefundTotal.toFixed(2)} already refunded)`;
  } else if (priorPurchaseTotal > 0) {
    reason = `Refund of ${transaction.amount.toFixed(2)} exceeds this customer's total prior purchases (${priorPurchaseTotal.toFixed(2)}) from this account`;
  } else {
    reason = `Refund of ${transaction.amount.toFixed(2)} has no matching prior purchase from this customer`;
  }

  return { flagged: true, reason, weight: REFUND_WITHOUT_PURCHASE_WEIGHT, severity: 'High' };
}

refundWithoutPurchase.REFUND_WITHOUT_PURCHASE_WEIGHT = REFUND_WITHOUT_PURCHASE_WEIGHT;

module.exports = refundWithoutPurchase;
