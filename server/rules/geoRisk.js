// Section 15.16, Feature 14: configurable high-risk geography raises the fraud score. Pure
// function over the transaction's own country/ip_address fields -- no context lookup needed.
// Scoped to outbound transactions like every other detector in this extension, consistent with
// the project's outbound-only fraud/AML scoring decision (Section 15.12).
const { GEO_RISK } = require('../config');

/**
 * @param {{ country: string|null, state: string|null, city: string|null, ip_address: string|null }} transaction
 */
function geoRisk(transaction) {
  if (transaction.country && GEO_RISK.HIGH_RISK_COUNTRIES.includes(transaction.country)) {
    return {
      flagged: true,
      reason: `Transaction originates from a high-risk country (${transaction.country})`,
      weight: GEO_RISK.GEO_RISK_WEIGHT,
      severity: 'Medium',
    };
  }

  // Section 16, Category 12: High-Risk State/City Detection -- same config-driven match as the
  // country check above, checked before the weaker IP-prefix heuristic since a self-reported
  // state/city is a more specific geo signal.
  if (transaction.state && GEO_RISK.HIGH_RISK_STATES.includes(transaction.state)) {
    return {
      flagged: true,
      reason: `Transaction originates from a high-risk state/region (${transaction.state})`,
      weight: GEO_RISK.GEO_RISK_WEIGHT,
      severity: 'Medium',
    };
  }

  if (transaction.city && GEO_RISK.HIGH_RISK_CITIES.includes(transaction.city)) {
    return {
      flagged: true,
      reason: `Transaction originates from a high-risk city (${transaction.city})`,
      weight: GEO_RISK.GEO_RISK_WEIGHT,
      severity: 'Medium',
    };
  }

  if (transaction.ip_address && GEO_RISK.HIGH_RISK_IP_PREFIXES.some((prefix) => transaction.ip_address.startsWith(prefix))) {
    return {
      flagged: true,
      reason: `Transaction originates from a high-risk IP range (${transaction.ip_address})`,
      weight: GEO_RISK.GEO_RISK_WEIGHT,
      severity: 'Medium',
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

module.exports = geoRisk;
