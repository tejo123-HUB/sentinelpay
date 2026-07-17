// Section 16, Category 4/10: flags when this transaction's device_id or ip_address has recently
// been used by other, unrelated accounts -- the per-transaction reduction of "shared device/IP
// graph" analysis to its actual detection signal, without standing up a graph database or
// visualization layer. Multiple genuinely unrelated accounts transacting from the same device/IP
// in a short window is a common fraud-ring or account-farming signature.
const SHARED_IDENTIFIER_WEIGHT = 35; // contribution to the 0-100 fraud score when flagged

/**
 * @param {{}} transaction
 * @param {{ sharedDeviceAccountIds: string[], sharedIpAccountIds: string[] }} outboundContext
 */
function sharedIdentifierRisk(transaction, outboundContext) {
  const sharedDevice = (outboundContext && outboundContext.sharedDeviceAccountIds) || [];
  const sharedIp = (outboundContext && outboundContext.sharedIpAccountIds) || [];

  if (sharedDevice.length > 0) {
    return {
      flagged: true,
      reason: `Device shared with ${sharedDevice.length} other account(s) in the last 30 days`,
      weight: SHARED_IDENTIFIER_WEIGHT,
      severity: 'Medium',
    };
  }
  if (sharedIp.length > 0) {
    return {
      flagged: true,
      reason: `IP address shared with ${sharedIp.length} other account(s) in the last 30 days`,
      weight: SHARED_IDENTIFIER_WEIGHT,
      severity: 'Medium',
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

sharedIdentifierRisk.SHARED_IDENTIFIER_WEIGHT = SHARED_IDENTIFIER_WEIGHT;

module.exports = sharedIdentifierRisk;
