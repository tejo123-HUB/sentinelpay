// Flags a transaction from a device never previously seen for this sender.
const DEVICE_MISMATCH_WEIGHT = 20; // contribution to the 0-100 fraud score when flagged (see scoring.js for the combining formula)

/**
 * @param {{ device_id: string }} transaction
 * @param {{ knownDeviceIds: string[] }} userHistory
 */
function deviceMismatch(transaction, userHistory) {
  const knownDeviceIds = userHistory.knownDeviceIds || [];

  // A brand-new sender has no device history yet, so there is nothing to mismatch against —
  // flagging their very first transaction on that basis would be a guaranteed false positive.
  if (knownDeviceIds.length === 0) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  if (transaction.device_id && !knownDeviceIds.includes(transaction.device_id)) {
    return {
      flagged: true,
      reason: 'Transaction from a previously unseen device',
      weight: DEVICE_MISMATCH_WEIGHT,
      severity: 'Low', // Section 15.16, Feature 17: severity backfilled onto the original 5 rule detectors for uniform explainability
    };
  }

  return { flagged: false, reason: null, weight: 0 };
}

deviceMismatch.DEVICE_MISMATCH_WEIGHT = DEVICE_MISMATCH_WEIGHT;

module.exports = deviceMismatch;
