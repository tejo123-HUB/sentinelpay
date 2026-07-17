// Flags activity outside a user's typical active hours.
const ODD_HOUR_WEIGHT = 20; // contribution to the 0-100 fraud score when flagged (see scoring.js for the combining formula)

/**
 * @param {{ timestamp: string }} transaction
 * @param {{ user: { typical_active_hours: Array<[number, number]>|null }|null }} userHistory
 *   typical_active_hours is a pre-parsed array of [startHour, endHour) ranges (24h, UTC),
 *   e.g. [[8, 22]] means "active between 08:00 and 21:59". Null/empty means no baseline yet.
 */
function oddHour(transaction, userHistory) {
  const ranges = userHistory.user ? userHistory.user.typical_active_hours : null;

  if (!ranges || ranges.length === 0) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const hour = new Date(transaction.timestamp).getUTCHours();
  const isTypical = ranges.some(([start, end]) => hour >= start && hour < end);

  if (!isTypical) {
    return {
      flagged: true,
      reason: `Transaction at ${String(hour).padStart(2, '0')}:00 UTC is outside this user's typical active hours`,
      weight: ODD_HOUR_WEIGHT,
      severity: 'Low', // Section 15.16, Feature 17: severity backfilled onto the original 5 rule detectors for uniform explainability
    };
  }

  return { flagged: false, reason: null, weight: 0 };
}

oddHour.ODD_HOUR_WEIGHT = ODD_HOUR_WEIGHT;

module.exports = oddHour;
