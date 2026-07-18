// Section 16, Category 10: Device Reputation Engine / Trusted Device Score. device_id and
// user_agent are both self-reported by the calling gateway (the same trust level this project
// already gives ip_address/country), so this cannot do Emulator/Rooted Device Detection -- those
// need real device attestation only a native mobile SDK can provide, out of scope for a JSON HTTP
// API (see architecture.md Section 16, Category 10). What it *can* do: score a device against its
// own observable history (has it been attached to prior flagged transactions?) and against a
// weaker self-reported automation signal (a scripted-client user_agent).
const { DEVICE_FINGERPRINT_RISK } = require('../config');

/**
 * @param {{ device_id: string|null, user_agent: string|null }} transaction
 * @param {{ devicePriorFlagCount: number, suspiciousUserAgent: boolean }} outboundContext
 */
function deviceFingerprintRisk(transaction, outboundContext) {
  const priorFlagCount = (outboundContext && outboundContext.devicePriorFlagCount) || 0;
  if (transaction.device_id && priorFlagCount >= DEVICE_FINGERPRINT_RISK.DEVICE_PRIOR_FLAG_THRESHOLD) {
    return {
      flagged: true,
      reason: `Device previously associated with ${priorFlagCount} flagged transaction(s) in the last 90 days`,
      weight: DEVICE_FINGERPRINT_RISK.DEVICE_PRIOR_FLAG_WEIGHT,
      severity: 'High',
    };
  }

  if (outboundContext && outboundContext.suspiciousUserAgent) {
    return {
      flagged: true,
      reason: 'Client user agent matches a known automation/scripting signature',
      weight: DEVICE_FINGERPRINT_RISK.SUSPICIOUS_UA_WEIGHT,
      severity: 'Medium',
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

module.exports = deviceFingerprintRisk;
