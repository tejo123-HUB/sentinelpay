// Section 15.16, Feature 8: a customer with a pattern of repeated disputes (chargebacks) is
// elevated risk on any refund issued to them -- "friendly fraud" is a customer disputing/
// refunding transactions they actually received, and repetition is the tell a single dispute
// can't show. Scoped to refund-purpose transactions, like the rest of the refund-integrity
// cluster; a dispute history doesn't change the risk of an ordinary vendor payout.
const { FRIENDLY_FRAUD } = require('../config');

const FRIENDLY_FRAUD_ELEVATED_WEIGHT = 20; // contribution to the 0-100 fraud score for an elevated-risk customer
const FRIENDLY_FRAUD_REPEAT_WEIGHT = 40; // stronger signal once the repeat threshold is crossed

/**
 * @param {{ purpose: string|null }} transaction
 * @param {{ disputeCount: number }} outboundContext
 */
function friendlyFraud(transaction, outboundContext) {
  const purpose = (transaction.purpose || '').toLowerCase();
  if (!purpose.includes('refund')) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const disputeCount = (outboundContext && outboundContext.disputeCount) || 0;

  if (disputeCount >= FRIENDLY_FRAUD.DISPUTE_REPEAT_COUNT) {
    return {
      flagged: true,
      reason: `Customer has ${disputeCount} disputes on record -- repeat dispute pattern`,
      weight: FRIENDLY_FRAUD_REPEAT_WEIGHT,
      severity: 'High',
    };
  }
  if (disputeCount >= FRIENDLY_FRAUD.DISPUTE_ELEVATED_COUNT) {
    return {
      flagged: true,
      reason: `Customer has ${disputeCount} disputes on record -- elevated dispute risk`,
      weight: FRIENDLY_FRAUD_ELEVATED_WEIGHT,
      severity: 'Medium',
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

friendlyFraud.FRIENDLY_FRAUD_ELEVATED_WEIGHT = FRIENDLY_FRAUD_ELEVATED_WEIGHT;
friendlyFraud.FRIENDLY_FRAUD_REPEAT_WEIGHT = FRIENDLY_FRAUD_REPEAT_WEIGHT;

module.exports = friendlyFraud;
