// Section 16, Category 4/10/11: flags when this transaction's device_id, ip_address, phone,
// email, or identity_hash has recently been used by other, unrelated accounts -- the
// per-transaction reduction of "shared device/IP/identity graph" analysis to its actual
// detection signal, without standing up a graph database or visualization layer. identity_hash
// is a caller-computed hash of a government ID (PAN/Aadhaar/etc); this system never sees or
// stores the raw document number, only the opaque token, so this covers "Shared PAN/Aadhaar
// Detection"/"Identity Link Analysis" without collecting the PII itself.
const SHARED_IDENTIFIER_WEIGHT = 35; // contribution to the 0-100 fraud score when flagged
// A shared identity-document hash is a stronger signal than a shared device/IP/phone/email --
// the underlying real-world documents rarely legitimately belong to multiple unrelated accounts
// the way a shared home WiFi IP or a family-shared device plausibly might.
const SHARED_IDENTITY_HASH_WEIGHT = 55;
// Partial-Feature Completion Pass (Graph Intelligence, Shared Bank Account Graph): same reasoning
// as SHARED_IDENTITY_HASH_WEIGHT -- a bank account number legitimately belonging to two unrelated
// SentinelPay-side accounts is rare, so it's scored at the same strong-signal tier.
const SHARED_BANK_ACCOUNT_WEIGHT = 55;

const CHECKS = [
  { field: 'sharedDeviceAccountIds', label: 'Device' },
  { field: 'sharedIpAccountIds', label: 'IP address' },
  { field: 'sharedPhoneAccountIds', label: 'Phone number' },
  { field: 'sharedEmailAccountIds', label: 'Email address' },
];

/**
 * @param {{}} transaction
 * @param {{ sharedDeviceAccountIds: string[], sharedIpAccountIds: string[], sharedPhoneAccountIds: string[], sharedEmailAccountIds: string[], sharedIdentityHashAccountIds: string[] }} outboundContext
 */
function sharedIdentifierRisk(transaction, outboundContext) {
  const sharedIdentityHash = (outboundContext && outboundContext.sharedIdentityHashAccountIds) || [];
  if (sharedIdentityHash.length > 0) {
    return {
      flagged: true,
      reason: `Identity document hash shared with ${sharedIdentityHash.length} other account(s) in the last 30 days`,
      weight: SHARED_IDENTITY_HASH_WEIGHT,
      severity: 'High',
    };
  }

  const sharedBankAccount = (outboundContext && outboundContext.sharedBankAccountAccountIds) || [];
  if (sharedBankAccount.length > 0) {
    return {
      flagged: true,
      reason: `Bank account shared with ${sharedBankAccount.length} other account(s) in the last 30 days`,
      weight: SHARED_BANK_ACCOUNT_WEIGHT,
      severity: 'High',
    };
  }

  for (const { field, label } of CHECKS) {
    const sharedWith = (outboundContext && outboundContext[field]) || [];
    if (sharedWith.length > 0) {
      return {
        flagged: true,
        reason: `${label} shared with ${sharedWith.length} other account(s) in the last 30 days`,
        weight: SHARED_IDENTIFIER_WEIGHT,
        severity: 'Medium',
      };
    }
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

sharedIdentifierRisk.SHARED_IDENTIFIER_WEIGHT = SHARED_IDENTIFIER_WEIGHT;
sharedIdentifierRisk.SHARED_IDENTITY_HASH_WEIGHT = SHARED_IDENTITY_HASH_WEIGHT;
sharedIdentifierRisk.SHARED_BANK_ACCOUNT_WEIGHT = SHARED_BANK_ACCOUNT_WEIGHT;

module.exports = sharedIdentifierRisk;
