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
  // Feature 2: the fixed-count threshold this window originally paired with (MAX_REFUNDS_PER_
  // CUSTOMER) was replaced by an adaptive per-(business,customer) refund-pacing baseline --
  // see ADAPTIVE_BASELINE.REFUND_* below and server/rules/multipleRefundDetection.js. The window
  // itself is kept: it still scopes refundCountToCustomer/refundTotalToCustomer, general-purpose
  // outbound-context fields other callers (dashboard, analytics) may reasonably want.
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
  // Section 16, Category 12: illustrative examples only, same as HIGH_RISK_COUNTRIES above -- an
  // operator would tune these to their own compliance guidance, not this hackathon demo's list.
  HIGH_RISK_STATES: ['XX-EXAMPLE-STATE'],
  HIGH_RISK_CITIES: ['Example Risk City'],
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

const DEVICE_FINGERPRINT_RISK = {
  // Section 16, Category 10: device_id is self-reported by the calling gateway (same convention
  // as ip_address/country), not attested by a native OS -- so this can score reputation and
  // automation signals visible in that report, but it cannot detect rooting/emulation, which
  // needs real device attestation only a native mobile SDK can provide (out of scope, see
  // architecture.md Section 16 Category 10).
  //
  // How far back to look for *other* transactions -- from any sender, any device -- that used
  // this same device_id and were themselves flagged (step_up/block). A device genuinely
  // associated with prior fraud is a stronger signal than "device is merely shared" (that's
  // sharedIdentifierRisk.js's job) -- this is "shared AND that other usage was itself bad."
  DEVICE_PRIOR_FLAG_LOOKBACK_MS: 90 * 24 * 60 * 60 * 1000, // 90 days
  DEVICE_PRIOR_FLAG_THRESHOLD: 1, // at least one prior flagged/blocked transaction on this device
  DEVICE_PRIOR_FLAG_WEIGHT: 45,
  // Self-reported user_agent strings identifying scripted/automated clients rather than a real
  // browser or mobile app -- a weaker, heuristic signal (an automation tool can lie about its UA
  // just as easily as a real one), so it's scored lower than the prior-fraud-history signal above.
  SUSPICIOUS_UA_PATTERN: /bot|curl|wget|python-requests|headless|phantomjs|selenium|scrapy/i,
  SUSPICIOUS_UA_WEIGHT: 20,
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

// Dynamic Risk Engine (Merchant Risk Intelligence pass): thresholds for the adaptive-baseline
// detectors (server/adaptiveBaseline.js). These are deliberately *statistical* configuration --
// "how many standard deviations counts as unusual" -- not a business-specific magic number like
// "amount > 10000". The same Z_THRESHOLD applies uniformly to every entity; what actually varies
// per entity is each one's own learned mean/stddev, not this constant.
const ADAPTIVE_BASELINE = {
  // Below this many prior observations, an entity's own baseline isn't trustworthy yet (too few
  // points to estimate a meaningful mean/stddev from) -- same "insufficient history" gate this
  // project already uses elsewhere (amountAnomaly.js's pre-existing MIN_HISTORY_FOR_ANOMALY,
  // payoutToNewReceiver.js's MIN_OUTBOUND_HISTORY_FOR_CHECK).
  MIN_HISTORY_FOR_BASELINE: 5,
  // Interval baseline (velocity.js): time between a sender's consecutive transactions, in ms.
  // A burst is flagged when its average spacing is this many standard deviations *faster*
  // (shorter interval) than the sender's own historical pace.
  VELOCITY_Z_THRESHOLD: 2.5,
  // A recent-window burst of fewer than this many transactions is never flagged on velocity
  // grounds alone, regardless of z-score -- a single transaction can't establish "a burst".
  VELOCITY_MIN_BURST_COUNT: 3,
  // Floor for interval stddev (ms) -- prevents a division blowup for an entity whose few known
  // intervals happen to be identical so far.
  VELOCITY_STDDEV_FLOOR_MS: 1000,
  // Assumed typical pace (ms between transactions) for a brand-new sender with no interval
  // baseline yet -- not "no fraud possible", just "no personal history to compare against yet",
  // same reasoning as amountAnomaly.js skipping brand-new accounts rather than guessing.
  VELOCITY_DEFAULT_INTERVAL_MS: 5 * 60 * 1000,
  // Assumed variability around that default pace -- deliberately tighter than a real learned
  // stddev would usually be, since a brand-new account has offered no evidence yet that a wide
  // spread of intervals is normal *for them*; a real deviation should still read as clearly
  // unusual against this conservative assumption, not get diluted into insignificance.
  VELOCITY_DEFAULT_STDDEV_MS: 60 * 1000,

  // Amount baseline (amountAnomaly.js): flags a transaction whose amount is this many standard
  // deviations above the sender's own historical average spend -- replaces the old fixed
  // "3x the average" multiplier, which treated a low-variance and a high-variance spender
  // identically.
  AMOUNT_Z_THRESHOLD: 3,
  // Floor for amount stddev, in the transaction's own currency units -- prevents a division
  // blowup for a sender whose few known amounts happen to be identical so far. An absolute floor
  // alone would be wrong at different scales (₹10 is a meaningful floor for a ₹50-average
  // account, meaningless noise for a ₹50,000-average one), so the real floor used is
  // max(AMOUNT_STDDEV_FLOOR, avg * AMOUNT_MIN_RELATIVE_STDDEV) -- whichever is larger.
  AMOUNT_STDDEV_FLOOR: 10,
  AMOUNT_MIN_RELATIVE_STDDEV: 0.1, // at least 10% of the sender's own average, regardless of scale

  // Refund-interval baseline (multipleRefundDetection.js): time between a (business, customer)
  // pair's consecutive refunds, in ms. Replaces the old fixed "more than 3 refunds" count.
  REFUND_Z_THRESHOLD: 2,
  REFUND_STDDEV_FLOOR_MS: 60 * 1000,
  // Assumed typical pace for a (business, customer) pair with no refund-interval baseline yet
  // (i.e. this is at most their second-ever refund from this business) -- generous, since one or
  // two refunds establish no real pattern either way.
  REFUND_DEFAULT_INTERVAL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// Continuous Learning Extension: self-updating composite reputation per entity (server/reputation.js).
// The core rate (flag_count / txn_count) is Laplace-smoothed with a weak neutral prior rather than
// used raw -- a brand-new entity's first-ever transaction being flagged would otherwise swing its
// score straight to 100 (1/1), and a real "risky" entity would look identical to one with a single
// unlucky flag. PRIOR_FLAGGED/PRIOR_TOTAL fixes both: a brand-new entity (txn_count=0) reads as
// exactly PRIOR_FLAGGED/PRIOR_TOTAL = 50 (neutral, matching entity_reputation's own DEFAULT 50),
// and the prior's weight shrinks automatically as real history accumulates.
const REPUTATION = {
  PRIOR_FLAGGED: 4,
  PRIOR_TOTAL: 8,
  // Overlay floors, same "hard floor regardless of the computed rate" pattern scoring.js already
  // uses for BLACKLIST_FLOOR/STRUCTURING_ALERT_FLOOR -- a confirmed-bad account's reputation score
  // shouldn't be votable back down by a long tail of unrelated clean transactions.
  BLACKLIST_SCORE_FLOOR: 90,
  MULE_SCORE_FLOOR: 75,
  // A receiver's reputation score at or above this is worth surfacing as its own detector finding
  // (server/rules/entityReputationRisk.js), independent of whatever specific pattern (mule,
  // blacklist, plain flag history) is driving it.
  RISK_FLAG_THRESHOLD: 70,
};

// Continuous Learning Extension, Phase C: graph-relationship discovery (server/graphIntelligence.js).
// Reopens Section 16 Category 4 (Community Detection/Graph Clustering), previously out of scope
// for the same "needs infrastructure this project doesn't have" reason as the ML items above --
// see architecture.md Section 16/17 for the reconciled status.
const GRAPH_INTELLIGENCE = {
  // A "cluster" of 2 is just an edge -- not a ring. 3+ distinct accounts connected (directly or
  // via a shared device/IP/identity link) is the smallest shape actually worth surfacing as a
  // discovered network.
  MIN_CLUSTER_SIZE: 3,
  // Only edges seen within this window count toward a cluster -- same reasoning
  // CIRCULAR_FLOW.CIRCULAR_FLOW_LOOKBACK_MS already applies: a long-dormant, no-longer-relevant
  // connection shouldn't permanently glue two account clusters together in every future scan.
  CLUSTER_LOOKBACK_MS: 24 * 60 * 60 * 1000,
  // A cluster is only worth persisting/alerting on once its members' average reputation risk
  // (server/reputation.js) crosses this bar -- most ordinary multi-hop transaction chains
  // (a supplier paying several vendors who pay each other) are not fraud rings, so clustering
  // alone isn't the signal; clustering *combined with* elevated reputation is.
  CLUSTER_RISK_THRESHOLD: 60,
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
  DEVICE_FINGERPRINT_RISK,
  FRAUD_LISTS,
  ADAPTIVE_BASELINE,
  REPUTATION,
  GRAPH_INTELLIGENCE,
};
