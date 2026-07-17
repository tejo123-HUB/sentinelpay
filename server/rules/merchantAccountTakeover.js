// Section 15.16, Feature 4: an unrecognized-device login for this merchant account, immediately
// followed by a refund/payout/settlement, is a classic account-takeover pattern -- the attacker
// logs in from their own device, then immediately tries to move money out before anyone notices.
// One of the "critical" detections (server/scoring.js's CRITICAL_DETECTORS) that force a block
// regardless of numeric score, alongside circular laundering and known mule/fraud-ring signals.
const MERCHANT_TAKEOVER_WEIGHT = 90; // contribution to the 0-100 fraud score -- deliberately high enough to force a block on its own even without the critical-detector floor

/**
 * @param {{ purpose: string|null }} transaction
 * @param {{ takeoverRisk: { loginTimestamp: string, currentDevice: string|null, previousDevice: string|null, currentCountry: string|null, previousCountry: string|null }|null }} outboundContext
 */
function merchantAccountTakeover(transaction, outboundContext) {
  const takeoverRisk = outboundContext && outboundContext.takeoverRisk;
  if (!takeoverRisk) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  return {
    flagged: true,
    reason: `Merchant account activity from a previously unrecognized device shortly before this transaction. (previous device: ${takeoverRisk.previousDevice || 'unknown'}, current device: ${takeoverRisk.currentDevice || 'unknown'}; previous country: ${takeoverRisk.previousCountry || 'unknown'}, current country: ${takeoverRisk.currentCountry || 'unknown'})`,
    weight: MERCHANT_TAKEOVER_WEIGHT,
    severity: 'Critical',
  };
}

merchantAccountTakeover.MERCHANT_TAKEOVER_WEIGHT = MERCHANT_TAKEOVER_WEIGHT;

module.exports = merchantAccountTakeover;
