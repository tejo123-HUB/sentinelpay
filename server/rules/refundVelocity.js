// Section 15.16, Feature 9: flags a business account issuing an unusually high number of refunds
// in a short window (e.g. 20 refunds within 30 seconds) -- a burst pattern distinct from
// multipleRefundDetection.js, which looks at refunds to one specific customer/purchase, not the
// business account's overall refund rate.
const config = require('../config');

const REFUND_VELOCITY_WEIGHT = 50; // contribution to the 0-100 fraud score when flagged

/**
 * @param {{ purpose: string|null }} transaction
 * @param {{ refundVelocityCount: number }} outboundContext
 */
function refundVelocity(transaction, outboundContext) {
  const purpose = (transaction.purpose || '').toLowerCase();
  if (!purpose.includes('refund')) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const priorCount = (outboundContext && outboundContext.refundVelocityCount) || 0;
  if (priorCount + 1 >= config.REFUND_INTEGRITY.REFUND_VELOCITY_COUNT) {
    return {
      flagged: true,
      reason: 'Unusual refund velocity.',
      weight: REFUND_VELOCITY_WEIGHT,
      severity: 'High',
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

refundVelocity.REFUND_VELOCITY_WEIGHT = REFUND_VELOCITY_WEIGHT;

module.exports = refundVelocity;
