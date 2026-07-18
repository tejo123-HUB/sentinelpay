// Partial-Feature Completion Pass: Identity Intelligence's synthetic-identity gap. A single
// device_id backing many *distinct* (phone, email, identity_hash) identity combinations in a
// short window is the observable signature of a synthetic-identity mill -- one real device
// onboarding a batch of fabricated identities -- distinct from sharedIdentifierRisk.js (which
// flags *reuse* of one identifier across accounts, the opposite shape of signal: one identifier,
// many accounts, rather than one device, many identities).
const { SYNTHETIC_IDENTITY } = require('../config');

/**
 * @param {{ phone: string|null, email: string|null, identity_hash: string|null }} transaction
 * @param {{ deviceDistinctIdentityCount: number }} outboundContext
 */
function syntheticIdentityRisk(transaction, outboundContext) {
  const hasIdentitySignal = !!(transaction.phone || transaction.email || transaction.identity_hash);
  if (!hasIdentitySignal) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const distinctCount = (outboundContext && outboundContext.deviceDistinctIdentityCount) || 0;
  if (distinctCount >= SYNTHETIC_IDENTITY.MIN_DISTINCT_IDENTITIES_PER_DEVICE) {
    return {
      flagged: true,
      reason: `Device associated with ${distinctCount} distinct identity combinations (phone/email/ID) in the last 24h -- possible synthetic identity pattern`,
      weight: SYNTHETIC_IDENTITY.SYNTHETIC_IDENTITY_WEIGHT,
      severity: 'High',
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

module.exports = syntheticIdentityRisk;
