// Section 15.16, Feature 12: an account with no activity in DORMANT_DAYS, then a sizeable
// payout/refund/settlement, is a classic account-takeover/reactivation-fraud pattern -- a
// compromised-but-unused account is a common target because its owner isn't watching it.
const { DORMANT_ACCOUNT } = require('../config');

const DORMANT_REACTIVATION_WEIGHT = 55; // contribution to the 0-100 fraud score when flagged
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @param {{ amount: number, timestamp: string }} transaction
 * @param {{ lastActivityTimestamp: string|null }} outboundContext
 */
function dormantAccountReactivation(transaction, outboundContext) {
  const lastActivityTimestamp = outboundContext && outboundContext.lastActivityTimestamp;
  if (!lastActivityTimestamp) {
    // No prior history at all isn't a "reactivation" -- it's this account's first transaction.
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const gapDays = (new Date(transaction.timestamp).getTime() - new Date(lastActivityTimestamp).getTime()) / MS_PER_DAY;
  if (gapDays >= DORMANT_ACCOUNT.DORMANT_DAYS && transaction.amount >= DORMANT_ACCOUNT.DORMANT_REACTIVATION_AMOUNT) {
    return {
      flagged: true,
      reason: `Dormant account reactivated with abnormal activity. (inactive ${Math.floor(gapDays)} days, then a ${transaction.amount.toFixed(2)} transaction)`,
      weight: DORMANT_REACTIVATION_WEIGHT,
      severity: 'High',
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

dormantAccountReactivation.DORMANT_REACTIVATION_WEIGHT = DORMANT_REACTIVATION_WEIGHT;

module.exports = dormantAccountReactivation;
