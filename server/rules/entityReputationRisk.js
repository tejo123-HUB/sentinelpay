// Continuous Learning Extension, Phase B: flags when this transaction's receiver has a
// consistently high composite reputation risk score (server/reputation.js) -- the general "this
// entity's own accumulated history looks bad" signal, independent of whichever specific pattern
// (mule, blacklist, plain flag history) is actually driving it. Distinct from
// muleReceiverRisk.js's narrow receive-then-quickly-drain pattern: an account can have a bad
// reputation purely from an elevated flag rate across ordinary-looking transactions, with no
// mule-style drain behavior at all.
const { REPUTATION } = require('../config');

const ENTITY_REPUTATION_RISK_WEIGHT = 30; // contribution to the 0-100 fraud score when flagged

/**
 * @param {object} transaction
 * @param {{ receiverReputation: { score: number, reasonBreakdown: string[] }|undefined }} outboundContext
 */
function entityReputationRisk(transaction, outboundContext) {
  const reputation = outboundContext && outboundContext.receiverReputation;
  if (!reputation || reputation.score < REPUTATION.RISK_FLAG_THRESHOLD) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  return {
    flagged: true,
    reason: `Receiver has an elevated reputation risk score (${reputation.score.toFixed(0)}/100) — ${reputation.reasonBreakdown.join('; ')}`,
    weight: ENTITY_REPUTATION_RISK_WEIGHT,
    severity: reputation.score >= REPUTATION.BLACKLIST_SCORE_FLOOR ? 'Critical' : 'High',
  };
}

entityReputationRisk.ENTITY_REPUTATION_RISK_WEIGHT = ENTITY_REPUTATION_RISK_WEIGHT;

module.exports = entityReputationRisk;
