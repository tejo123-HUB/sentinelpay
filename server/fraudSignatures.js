// Section 17 (FA216, "Fraud Signature Database"): formalizes the flag_type taxonomy that was
// previously only informal (scattered across each server/rules/*.js file's own `type:` string in
// server/routes/transactions.js's RULE_DETECTORS/OUTBOUND_RULE_DETECTORS arrays) into a real,
// queryable catalog with a human-readable description per signature -- every flag_type this
// system can ever produce, whether or not it has fired yet. custom_rules (Category 19, Auto Rule
// Builder) are deliberately excluded: their signature is operator-defined at runtime
// (`custom_rule:<rule_id>`), not a fixed one this catalog can enumerate in advance -- see
// GET /custom-rules for those.
const FRAUD_SIGNATURES = [
  { flag_type: 'velocity', category: 'Rule-Based Fraud Detection', description: 'Too many transactions from one account in a short window.' },
  { flag_type: 'impossible_travel', category: 'Rule-Based Fraud Detection', description: 'Consecutive transactions imply a physically impossible travel speed.' },
  { flag_type: 'amount_anomaly', category: 'Rule-Based Fraud Detection', description: "Transaction amount is a statistical outlier against this account's own history." },
  { flag_type: 'device_mismatch', category: 'Rule-Based Fraud Detection', description: 'Transaction uses a device not previously associated with this account.' },
  { flag_type: 'odd_hour', category: 'Rule-Based Fraud Detection', description: "Transaction falls outside this account's typical active hours." },
  { flag_type: 'refund_without_purchase', category: 'Rule-Based Fraud Detection', description: 'A refund with no matching prior purchase from this customer.' },
  { flag_type: 'refund_account_mismatch', category: 'Rule-Based Fraud Detection', description: 'A refund routed to an account different from the one that made the original purchase.' },
  { flag_type: 'multiple_refund_detection', category: 'Rule-Based Fraud Detection', description: 'Too many refunds issued to one customer within a short window.' },
  { flag_type: 'split_refund_detection', category: 'Rule-Based Fraud Detection', description: 'A single purchase refunded in multiple smaller pieces.' },
  { flag_type: 'refund_velocity', category: 'Rule-Based Fraud Detection', description: 'Too many refunds issued by this business account overall in a short window.' },
  { flag_type: 'payout_new_receiver', category: 'Rule-Based Fraud Detection', description: 'An outbound payout to a receiver this business account has never paid before.' },
  { flag_type: 'new_vendor_risk', category: 'Rule-Based Fraud Detection', description: 'A large outbound payout to a brand-new vendor -- an amount-scaled tier above payout_new_receiver.' },
  { flag_type: 'outbound_ratio_anomaly', category: 'Rule-Based Fraud Detection', description: "Outbound payouts are a disproportionate fraction of this business account's inbound revenue." },
  { flag_type: 'outbound_fan_out_burst', category: 'Rule-Based Fraud Detection', description: 'A sudden burst of payouts to many distinct receivers in a short window.' },
  { flag_type: 'dormant_account_reactivation', category: 'Rule-Based Fraud Detection', description: 'A large outbound transaction from an account with no recent prior activity.' },
  { flag_type: 'duplicate_transaction', category: 'Rule-Based Fraud Detection', description: 'A near-identical transaction (same receiver, same amount) sent moments ago.' },
  { flag_type: 'mule_receiver_risk', category: 'Anti-Money Laundering', description: "This transaction's receiver shows a receive-then-quickly-drain pattern across its own history." },
  { flag_type: 'cross_gateway_structuring', category: 'Anti-Money Laundering', description: 'The same customer/receiver relationship spread across multiple payment gateways to stay under a single-gateway threshold.' },
  { flag_type: 'structuring_alert', category: 'Anti-Money Laundering', description: 'An active, confirmed structuring/layering/circular-flow pattern (server/structuring/*) involving this account.' },
  { flag_type: 'merchant_account_takeover', category: 'Merchant Intelligence', description: 'An outbound transaction shortly after a login from an unrecognized device/location for this merchant.' },
  { flag_type: 'employee_fraud', category: 'Employee Intelligence', description: 'An employee issuing an unusual volume of refunds, or repeated refunds to the same receiver.' },
  { flag_type: 'friendly_fraud', category: 'Customer Intelligence', description: 'A customer with a history of repeated chargeback/dispute filings.' },
  { flag_type: 'geo_risk', category: 'Geo Intelligence', description: 'Transaction originates from a configured high-risk country, state, city, or IP range.' },
  { flag_type: 'shared_identifier_risk', category: 'Identity Intelligence', description: 'This device/IP/phone/email/identity-hash has recently been used by another, unrelated account.' },
  { flag_type: 'device_fingerprint_risk', category: 'Device Intelligence', description: "This device was previously attached to a flagged transaction, or reports a known automation/scripting user agent." },
  { flag_type: 'watchlist', category: 'Fraud Intelligence', description: 'One side of this transaction is on the operator-managed watchlist (server/routes/fraudLists.js).' },
  { flag_type: 'blacklist', category: 'Fraud Intelligence', description: 'One side of this transaction is on the blacklist -- forces a block regardless of any other signal.' },
  { flag_type: 'outbound_amount_restrictor', category: 'Rule-Based Fraud Detection', description: 'An outbound amount above the review threshold, floored to at least step-up regardless of score.' },
];

module.exports = { FRAUD_SIGNATURES };
