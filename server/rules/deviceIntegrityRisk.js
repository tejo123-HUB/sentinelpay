// Partial-Feature Completion Pass: Device Intelligence's emulator/rooted-device gap (previously
// explicitly out of scope -- see deviceFingerprintRisk.js's header comment -- since real device
// attestation needs a native mobile SDK this JSON HTTP API doesn't have). device_id and
// user_agent are both self-reported by the calling gateway, so this can be spoofed by a
// sophisticated attacker the same way any self-reported field can -- but a genuine emulator or
// rooted-device build commonly leaks itself through well-known strings it never bothered to
// scrub (Android's generic/goldfish/ranchu emulator build fingerprints, "test-keys" on a
// non-production-signed build, jailbreak/root tooling like Cydia/Magisk/Frida). Best-effort and
// heuristic, same caution level as deviceFingerprintRisk.js's SUSPICIOUS_UA_PATTERN, not a
// pretense of real attestation.
const { DEVICE_INTEGRITY } = require('../config');

/**
 * @param {{ device_id: string|null, user_agent: string|null }} transaction
 */
function deviceIntegrityRisk(transaction) {
  const deviceId = transaction.device_id || '';
  const userAgent = transaction.user_agent || '';
  const combined = `${deviceId} ${userAgent}`;

  if (DEVICE_INTEGRITY.ROOTED_PATTERN.test(combined)) {
    return {
      flagged: true,
      reason: 'Device identifier/user agent matches a known rooted or jailbroken device signature',
      weight: DEVICE_INTEGRITY.DEVICE_INTEGRITY_WEIGHT,
      severity: 'Medium',
    };
  }

  if (DEVICE_INTEGRITY.EMULATOR_PATTERN.test(combined)) {
    return {
      flagged: true,
      reason: 'Device identifier/user agent matches a known emulator/simulator signature',
      weight: DEVICE_INTEGRITY.DEVICE_INTEGRITY_WEIGHT,
      severity: 'Medium',
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

module.exports = deviceIntegrityRisk;
