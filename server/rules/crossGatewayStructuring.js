// Section 15.16, Feature 11: this business account paying the same receiver through several
// distinct payment gateways (merchant_id), cumulating a large amount within a window, is
// structuring spread across gateways instead of across receivers -- each individual gateway's
// own dashboard would see only its own slice and never notice the pattern (architecture.md
// Section 1's whole reason this product aggregates across gateways in the first place).
const { CROSS_GATEWAY } = require('../config');

const CROSS_GATEWAY_WEIGHT = 45; // contribution to the 0-100 fraud score when flagged

/**
 * @param {{ amount: number, merchant_id: string|null }} transaction
 * @param {{ crossGatewayIds: string[], crossGatewayTotal: number }} outboundContext
 */
function crossGatewayStructuring(transaction, outboundContext) {
  const priorGatewayIds = (outboundContext && outboundContext.crossGatewayIds) || [];
  const gatewayIds = new Set(priorGatewayIds);
  if (transaction.merchant_id) gatewayIds.add(transaction.merchant_id);

  if (gatewayIds.size < CROSS_GATEWAY.CROSS_GATEWAY_MIN_GATEWAYS) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const priorTotal = (outboundContext && outboundContext.crossGatewayTotal) || 0;
  const projectedTotal = priorTotal + transaction.amount;
  if (projectedTotal < CROSS_GATEWAY.CROSS_GATEWAY_MIN_TOTAL) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  return {
    flagged: true,
    reason: `Cross gateway transaction structuring detected. (${gatewayIds.size} gateways, ${projectedTotal.toFixed(2)} total to the same receiver)`,
    weight: CROSS_GATEWAY_WEIGHT,
    severity: 'High',
  };
}

crossGatewayStructuring.CROSS_GATEWAY_WEIGHT = CROSS_GATEWAY_WEIGHT;

module.exports = crossGatewayStructuring;
