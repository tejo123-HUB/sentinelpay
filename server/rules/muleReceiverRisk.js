// Section 15.16, Feature 13: warns when this transaction's receiver has a lifetime pattern of
// receiving money and quickly moving most of it back out (server/muleScore.js) -- independent of
// whether that receiver is currently caught up in an active structuring alert. This is the
// per-transaction consumer of that score; the dashboard's "top mule accounts" panel (Feature 15)
// is the other.
const MULE_RECEIVER_RISK_WEIGHT = 50; // contribution to the 0-100 fraud score when flagged

/**
 * @param {{ receiver_id: string }} transaction
 * @param {{ receiverMuleScore: { isMule: boolean, qualifyingCycles: number }|undefined }} outboundContext
 */
function muleReceiverRisk(transaction, outboundContext) {
  const muleScore = outboundContext && outboundContext.receiverMuleScore;
  if (!muleScore || !muleScore.isMule) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  return {
    flagged: true,
    reason: `Receiver is a Suspected Mule Account (${muleScore.qualifyingCycles} receive-then-quick-withdraw cycles observed)`,
    weight: MULE_RECEIVER_RISK_WEIGHT,
    severity: 'Critical',
  };
}

muleReceiverRisk.MULE_RECEIVER_RISK_WEIGHT = MULE_RECEIVER_RISK_WEIGHT;

module.exports = muleReceiverRisk;
