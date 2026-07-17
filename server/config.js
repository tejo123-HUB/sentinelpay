// Centralized configuration for every threshold introduced by the Section 15.16 (21-feature)
// extension -- Feature 19's "no magic numbers anywhere" requirement. Deliberately scoped to the
// *new* detectors only: the nine detectors that shipped before this extension already follow
// Section 14's convention (named constants at the top of their own file) and are left as-is per
// "do not rewrite existing working modules" -- migrating them here too would touch several
// already-shipped, already-tested files for no functional gain.
//
// Every value below is read once at module load; there is no live-reload story here, matching
// this project's existing conventions (e.g. mlClient.js's cachedModel).

const REFUND_INTEGRITY = {
  // Feature 2: a customer with this many refund transactions against one business account in
  // MULTIPLE_REFUND_WINDOW_MS is flagged, independent of whether any single refund looks fine.
  MAX_REFUNDS_PER_CUSTOMER: 3,
  MULTIPLE_REFUND_WINDOW_MS: 24 * 60 * 60 * 1000, // 24h
  // Feature 9: refund velocity -- N refunds from one business account within WINDOW_MS.
  REFUND_VELOCITY_COUNT: 20,
  REFUND_VELOCITY_WINDOW_MS: 30 * 1000,
};

const VENDOR_RISK = {
  // Feature 5: payout to a never-before-paid receiver above this amount -> step-up.
  NEW_VENDOR_STEP_UP_AMOUNT: 50000,
  // ...above this amount -> force block, regardless of score.
  NEW_VENDOR_BLOCK_AMOUNT: 200000,
};

const MULE_DETECTION = {
  // Feature 13: a receiver who withdraws/forwards out this fraction of what they received,
  // within MULE_WINDOW_MS of receiving it, earns mule-score credit for that receipt.
  MULE_WITHDRAWAL_RATIO: 0.8,
  MULE_WINDOW_MS: 30 * 60 * 1000,
  // A receiver needs at least this many qualifying receive+quick-withdraw cycles before being
  // labeled "Suspected Mule Account" -- one clean withdrawal isn't a pattern.
  MULE_MIN_QUALIFYING_CYCLES: 2,
  // Bounds the per-receiver query cost regardless of lifetime transaction volume -- same
  // reasoning as userProfile.js's ACTIVE_HOURS_SAMPLE_LIMIT (Section 15.6, finding #3): an
  // unbounded scan over an active account's full history would grow the per-transaction latency
  // without limit as that account's volume grows.
  MULE_SCORE_MAX_RECEIPTS_SCANNED: 50,
};

const DORMANT_ACCOUNT = {
  // Feature 12: an account with no transactions in this many days, then a payout/refund/
  // settlement above DORMANT_REACTIVATION_AMOUNT, is flagged as a reactivation risk.
  DORMANT_DAYS: 180,
  DORMANT_REACTIVATION_AMOUNT: 10000,
};

const GEO_RISK = {
  // Feature 14: configurable high-risk geography. Country codes are illustrative examples, not
  // a real risk assessment -- an operator would tune this list to their own compliance guidance.
  HIGH_RISK_COUNTRIES: ['KP', 'IR', 'SY'],
  HIGH_RISK_STATES: [],
  // IP address prefixes (simple startsWith match -- no real GeoIP/CIDR library dependency,
  // consistent with this project's dependency-light conventions).
  HIGH_RISK_IP_PREFIXES: ['198.51.100.'],
  GEO_RISK_WEIGHT: 30,
};

const MERCHANT_TAKEOVER = {
  // Feature 4: a merchant-side outbound transaction (refund/payout/settlement) within this many
  // ms of a login from an unrecognized device/location is treated as a takeover risk.
  TAKEOVER_WINDOW_MS: 10 * 60 * 1000,
};

const EMPLOYEE_FRAUD = {
  // Feature 10: an employee issuing this many refunds within the window, or this many refunds
  // to the same receiver, is flagged.
  EMPLOYEE_REFUND_COUNT_THRESHOLD: 10,
  EMPLOYEE_REFUND_WINDOW_MS: 24 * 60 * 60 * 1000,
  EMPLOYEE_SAME_RECEIVER_THRESHOLD: 3,
};

const CROSS_GATEWAY = {
  // Feature 11: the same customer transacting across at least this many distinct merchant_id
  // gateways, cumulating at least this amount, within the window -> flagged.
  CROSS_GATEWAY_MIN_GATEWAYS: 2,
  CROSS_GATEWAY_WINDOW_MS: 60 * 60 * 1000,
  CROSS_GATEWAY_MIN_TOTAL: 30000,
};

const FRIENDLY_FRAUD = {
  // Feature 8: a customer with this many disputes within the window is flagged as elevated risk;
  // REPEAT threshold marks them for the "repeat dispute customers" dashboard panel.
  DISPUTE_WINDOW_MS: 90 * 24 * 60 * 60 * 1000, // 90 days
  DISPUTE_ELEVATED_COUNT: 2,
  DISPUTE_REPEAT_COUNT: 3,
};

const DUPLICATE_DETECTION = {
  // Section 16, Category 2: a second outbound transaction to the same receiver, for the same
  // amount, within this window reads as an accidental double-charge or automated replay rather
  // than two genuinely separate payments.
  DUPLICATE_WINDOW_MS: 60 * 1000,
};

const SHARED_IDENTIFIER_RISK = {
  // Section 16, Category 4/10: how far back to look for *other* accounts using this same
  // device_id/ip_address -- long enough to catch a slow-rotating fraud ring, short enough that
  // an old, now-irrelevant device reassignment doesn't permanently flag two innocent accounts.
  SHARED_IDENTIFIER_LOOKBACK_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
};

const FRAUD_LISTS = {
  // Section 16, Categories 19/21: an active blacklist entry floors the score here (above the
  // block threshold), regardless of direction or what rule/ML scoring alone would have produced
  // -- mirrors STRUCTURING_ALERT_FLOOR's "a known bad actor always forces block" guarantee.
  BLACKLIST_FLOOR: 95,
  // An active whitelist entry caps the score here, UNLESS an active structuring alert or
  // blacklist entry says otherwise (both take precedence -- whitelisting is for reducing false
  // positives, not for overriding a confirmed bad actor).
  WHITELIST_CEILING: 5,
  // A watchlist entry doesn't force any outcome, just nudges the score and adds a reason.
  WATCHLIST_WEIGHT: 15,
};

const CIRCULAR_FLOW = {
  // Feature 6: max hops traced when looking for a cycle back to the originating merchant
  // (Merchant -> A -> Merchant is 1 hop out + 1 back; this bounds how many intermediate hops).
  MAX_CYCLE_HOPS: 3,
  CIRCULAR_FLOW_LOOKBACK_MS: 24 * 60 * 60 * 1000,
};

module.exports = {
  REFUND_INTEGRITY,
  VENDOR_RISK,
  MULE_DETECTION,
  DORMANT_ACCOUNT,
  GEO_RISK,
  MERCHANT_TAKEOVER,
  EMPLOYEE_FRAUD,
  CROSS_GATEWAY,
  FRIENDLY_FRAUD,
  CIRCULAR_FLOW,
  DUPLICATE_DETECTION,
  SHARED_IDENTIFIER_RISK,
  FRAUD_LISTS,
};
