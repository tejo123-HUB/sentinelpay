// Flags a business account paying out far more than it has taken in over the same window -- the
// core laundering signature: money leaving with no legitimate revenue basis for it.
const OUTBOUND_RATIO_THRESHOLD = 1.5; // flag once rolling outbound exceeds this multiple of rolling inbound
const OUTBOUND_RATIO_WEIGHT = 35; // contribution to the 0-100 fraud score when flagged (see scoring.js for the combining formula)

/**
 * @param {{ amount: number }} transaction
 * @param {{ rollingInboundTotal: number, rollingOutboundTotal: number }} outboundContext
 */
function outboundRatioAnomaly(transaction, outboundContext) {
  const inboundTotal = (outboundContext && outboundContext.rollingInboundTotal) || 0;
  const priorOutboundTotal = (outboundContext && outboundContext.rollingOutboundTotal) || 0;
  const outboundTotal = priorOutboundTotal + transaction.amount;

  if (inboundTotal <= 0) {
    // No recorded revenue at all in the window. Only flag once there's *prior* outbound
    // history to compare against -- a business account's very first-ever transaction has
    // nothing to be anomalous relative to yet.
    if (priorOutboundTotal > 0) {
      return {
        flagged: true,
        reason: `Outbound total (${outboundTotal.toFixed(2)}) with no recorded inbound revenue in the same window`,
        weight: OUTBOUND_RATIO_WEIGHT,
      };
    }
    return { flagged: false, reason: null, weight: 0 };
  }

  const ratio = outboundTotal / inboundTotal;
  if (ratio > OUTBOUND_RATIO_THRESHOLD) {
    return {
      flagged: true,
      reason: `Outbound total (${outboundTotal.toFixed(2)}) is ${ratio.toFixed(1)}x inbound revenue (${inboundTotal.toFixed(2)}) in the same window`,
      weight: OUTBOUND_RATIO_WEIGHT,
    };
  }

  return { flagged: false, reason: null, weight: 0 };
}

outboundRatioAnomaly.OUTBOUND_RATIO_THRESHOLD = OUTBOUND_RATIO_THRESHOLD;
outboundRatioAnomaly.OUTBOUND_RATIO_WEIGHT = OUTBOUND_RATIO_WEIGHT;

module.exports = outboundRatioAnomaly;
