// Hard floor beyond scoring, mirroring scoring.js's STRUCTURING_ALERT_FLOOR pattern: an outbound
// transaction above this amount always gets at least step-up review, regardless of what the
// rules/ML score alone would produce -- money leaving the business past this size is enough on
// its own to warrant a human look, even with an otherwise clean score. Only ever called for
// outbound transactions (server/routes/transactions.js).
const MAX_OUTBOUND_WITHOUT_REVIEW = 25000;
const decide = require('./decision');

/**
 * @param {number} score - 0-100 fraud score from scoring.js's computeFraudScore
 * @param {string[]} reasons
 * @param {{ amount: number }} transaction
 * @returns {{ score: number, reasons: string[] }}
 */
function applyOutboundRestrictors(score, reasons, transaction) {
  if (transaction.amount > MAX_OUTBOUND_WITHOUT_REVIEW) {
    const flooredScore = Math.max(score, decide.STEP_UP_THRESHOLD);
    return {
      score: flooredScore,
      reasons: [
        ...reasons,
        `Outbound amount (${transaction.amount.toFixed(2)}) exceeds the ${MAX_OUTBOUND_WITHOUT_REVIEW} review threshold`,
      ],
    };
  }
  return { score, reasons };
}

applyOutboundRestrictors.MAX_OUTBOUND_WITHOUT_REVIEW = MAX_OUTBOUND_WITHOUT_REVIEW;

module.exports = applyOutboundRestrictors;
