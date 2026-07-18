// Flags an outbound payment to a receiver this business account has never paid before --
// mirrors deviceMismatch.js's "new device" signal, but for payout destinations. Skips
// refund-purpose transactions: a refund's first-ever payment to that specific customer is
// completely normal, not a sign of anything (refundWithoutPurchase.js already covers the actual
// refund-fraud risk).
const PAYOUT_NEW_RECEIVER_WEIGHT = 25; // contribution to the 0-100 fraud score when flagged (see scoring.js for the combining formula)
const MIN_OUTBOUND_HISTORY_FOR_CHECK = 3; // no baseline of "known receivers" yet on a business account's first few payouts -- flagging those would be a guaranteed false positive

/**
 * @param {{ receiver_id: string, purpose: string|null }} transaction
 * @param {{ priorOutboundCount: number, knownOutboundReceiverIds: string[] }} outboundContext
 */
function payoutToNewReceiver(transaction, outboundContext) {
  const purpose = (transaction.purpose || '').toLowerCase();
  if (purpose.includes('refund')) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const priorOutboundCount = (outboundContext && outboundContext.priorOutboundCount) || 0;
  if (priorOutboundCount < MIN_OUTBOUND_HISTORY_FOR_CHECK) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const knownReceiverIds = (outboundContext && outboundContext.knownOutboundReceiverIds) || [];
  if (!knownReceiverIds.includes(transaction.receiver_id)) {
    return {
      flagged: true,
      reason: 'Payout to a receiver this business account has never paid before',
      weight: PAYOUT_NEW_RECEIVER_WEIGHT,
      severity: 'Low', // Section 15.16, Feature 17: severity backfilled for uniform explainability
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

payoutToNewReceiver.PAYOUT_NEW_RECEIVER_WEIGHT = PAYOUT_NEW_RECEIVER_WEIGHT;
payoutToNewReceiver.MIN_OUTBOUND_HISTORY_FOR_CHECK = MIN_OUTBOUND_HISTORY_FOR_CHECK;

module.exports = payoutToNewReceiver;
