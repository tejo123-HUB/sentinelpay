// Section 15.16, Feature 5: a tiered version of payoutToNewReceiver.js's signal -- a payout to a
// never-before-paid receiver is a moderate flag on its own (payoutToNewReceiver.js), but a
// *large* payout to a brand-new vendor is a stronger, amount-scaled risk that deserves its own
// step-up/block tiers rather than one flat weight. Deliberately not merged into
// payoutToNewReceiver.js: that detector's job is "is this receiver new at all," this one's job
// is "how much money is riding on that," and conflating them would make either harder to reason
// about and test independently.
const { VENDOR_RISK } = require('../config');
const payoutToNewReceiver = require('./payoutToNewReceiver');

const NEW_VENDOR_STEP_UP_WEIGHT = 45; // contribution to the 0-100 fraud score -- alone, lands a transaction in step-up
const NEW_VENDOR_BLOCK_WEIGHT = 90; // contribution to the 0-100 fraud score -- alone, forces a block

/**
 * @param {{ amount: number, receiver_id: string, purpose: string|null }} transaction
 * @param {{ priorOutboundCount: number, knownOutboundReceiverIds: string[] }} outboundContext
 */
function newVendorRisk(transaction, outboundContext) {
  const purpose = (transaction.purpose || '').toLowerCase();
  if (purpose.includes('refund')) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const priorOutboundCount = (outboundContext && outboundContext.priorOutboundCount) || 0;
  if (priorOutboundCount < payoutToNewReceiver.MIN_OUTBOUND_HISTORY_FOR_CHECK) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const knownReceiverIds = (outboundContext && outboundContext.knownOutboundReceiverIds) || [];
  if (knownReceiverIds.includes(transaction.receiver_id)) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  if (transaction.amount >= VENDOR_RISK.NEW_VENDOR_BLOCK_AMOUNT) {
    return { flagged: true, reason: 'High value payment to new vendor.', weight: NEW_VENDOR_BLOCK_WEIGHT, severity: 'Critical' };
  }
  if (transaction.amount >= VENDOR_RISK.NEW_VENDOR_STEP_UP_AMOUNT) {
    return { flagged: true, reason: 'High value payment to new vendor.', weight: NEW_VENDOR_STEP_UP_WEIGHT, severity: 'High' };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

newVendorRisk.NEW_VENDOR_STEP_UP_WEIGHT = NEW_VENDOR_STEP_UP_WEIGHT;
newVendorRisk.NEW_VENDOR_BLOCK_WEIGHT = NEW_VENDOR_BLOCK_WEIGHT;

module.exports = newVendorRisk;
