// Fast, synchronous companion to the deferred structuring background job (server/structuring/
// backgroundJob.js runs every 5-10s): flags a business account paying out to several distinct,
// previously-unpaid receivers within a short burst window -- the pattern a compromised account
// draining funds to new destinations produces, catchable immediately rather than waiting for the
// next background scan cycle.
const BURST_NEW_RECEIVER_THRESHOLD = 3; // this many distinct new receivers within the burst window triggers a flag
const OUTBOUND_FAN_OUT_BURST_WEIGHT = 40; // contribution to the 0-100 fraud score when flagged (see scoring.js for the combining formula)

/**
 * @param {{ receiver_id: string }} transaction
 * @param {{ knownOutboundReceiverIds: string[], recentBurstReceiverIds: string[] }} outboundContext
 */
function outboundFanOutBurst(transaction, outboundContext) {
  const knownReceiverIds = new Set((outboundContext && outboundContext.knownOutboundReceiverIds) || []);
  const burstReceiverIds = new Set((outboundContext && outboundContext.recentBurstReceiverIds) || []);
  burstReceiverIds.add(transaction.receiver_id);

  const newBurstReceivers = [...burstReceiverIds].filter((id) => !knownReceiverIds.has(id));

  if (newBurstReceivers.length >= BURST_NEW_RECEIVER_THRESHOLD) {
    return {
      flagged: true,
      reason: `${newBurstReceivers.length} distinct new payout receivers in a short window`,
      weight: OUTBOUND_FAN_OUT_BURST_WEIGHT,
    };
  }

  return { flagged: false, reason: null, weight: 0 };
}

outboundFanOutBurst.BURST_NEW_RECEIVER_THRESHOLD = BURST_NEW_RECEIVER_THRESHOLD;
outboundFanOutBurst.OUTBOUND_FAN_OUT_BURST_WEIGHT = OUTBOUND_FAN_OUT_BURST_WEIGHT;

module.exports = outboundFanOutBurst;
