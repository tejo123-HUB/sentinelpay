const { haversineDistanceKm } = require('../utils/geo');

// Flags a location jump between a sender's last transaction and this one that implies
// a physically implausible travel speed.
const IMPOSSIBLE_TRAVEL_SPEED_KMH = 900; // ~commercial jet cruising speed; faster than this is implausible
const IMPOSSIBLE_TRAVEL_WEIGHT = 40; // contribution to the 0-100 fraud score when flagged (see scoring.js for the combining formula)
const MIN_ELAPSED_SECONDS = 1; // guard against division by ~0 for back-to-back timestamps

/**
 * @param {{ timestamp: string, location: { lat: number, lng: number } }} transaction
 * @param {{ recentTransactions: Array<{ timestamp: string, location: { lat: number, lng: number }|null }> }} userHistory
 */
function impossibleTravel(transaction, userHistory) {
  if (!transaction.location || transaction.location.lat == null || transaction.location.lng == null) {
    return { flagged: false, reason: null, weight: 0 };
  }

  const priorWithLocation = (userHistory.recentTransactions || [])
    .filter((t) => t.location && t.location.lat != null && t.location.lng != null)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const lastTransaction = priorWithLocation[0];
  if (!lastTransaction) {
    return { flagged: false, reason: null, weight: 0 };
  }

  const txTime = new Date(transaction.timestamp).getTime();
  const lastTime = new Date(lastTransaction.timestamp).getTime();
  const elapsedSeconds = Math.max((txTime - lastTime) / 1000, MIN_ELAPSED_SECONDS);

  const distanceKm = haversineDistanceKm(
    lastTransaction.location.lat,
    lastTransaction.location.lng,
    transaction.location.lat,
    transaction.location.lng
  );

  const impliedSpeedKmh = distanceKm / (elapsedSeconds / 3600);

  if (impliedSpeedKmh > IMPOSSIBLE_TRAVEL_SPEED_KMH) {
    return {
      flagged: true,
      reason: `${Math.round(distanceKm)} km location jump in ${Math.round(elapsedSeconds)} seconds`,
      weight: IMPOSSIBLE_TRAVEL_WEIGHT,
    };
  }

  return { flagged: false, reason: null, weight: 0 };
}

impossibleTravel.IMPOSSIBLE_TRAVEL_SPEED_KMH = IMPOSSIBLE_TRAVEL_SPEED_KMH;
impossibleTravel.IMPOSSIBLE_TRAVEL_WEIGHT = IMPOSSIBLE_TRAVEL_WEIGHT;

module.exports = impossibleTravel;
