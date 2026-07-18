// Section 15.16, Feature 1: verifies a refund goes back to the same account that made the
// original purchase it references. Scoped to refund-purpose transactions that name the specific
// purchase via reference_transaction_id -- with no reference, there's nothing to compare against
// (refundWithoutPurchase.js's aggregate fallback covers that case instead). Existence/ownership
// of the referenced purchase is refundWithoutPurchase.js's job (Feature 3); this detector only
// owns the destination-account comparison, so the two never flag the same condition twice.
const REFUND_ACCOUNT_MISMATCH_WEIGHT = 60; // contribution to the 0-100 fraud score when flagged -- a stronger signal than a routine "no purchase" gap, since it implies the money is going somewhere the original payer never authorized

/**
 * @param {{ purpose: string|null, receiver_id: string, reference_transaction_id: string|null }} transaction
 * @param {{ referencedPurchase: { sender_id: string }|null }} outboundContext
 */
function refundAccountMismatch(transaction, outboundContext) {
  const purpose = (transaction.purpose || '').toLowerCase();
  if (!purpose.includes('refund') || !transaction.reference_transaction_id) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const purchase = outboundContext && outboundContext.referencedPurchase;
  if (!purchase) {
    // Missing/invalid reference is refundWithoutPurchase.js's finding to make -- nothing to
    // compare an account against here.
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const originalAccount = purchase.sender_id;
  const refundAccount = transaction.receiver_id;
  if (originalAccount !== refundAccount) {
    return {
      flagged: true,
      reason: `Refund destination does not match original payment account. (original: ${originalAccount}, refund: ${refundAccount})`,
      weight: REFUND_ACCOUNT_MISMATCH_WEIGHT,
      severity: 'High',
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

refundAccountMismatch.REFUND_ACCOUNT_MISMATCH_WEIGHT = REFUND_ACCOUNT_MISMATCH_WEIGHT;

module.exports = refundAccountMismatch;
