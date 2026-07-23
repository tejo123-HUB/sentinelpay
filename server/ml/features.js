// Extracts the same behavioral feature vector ml/train_model.py was trained on. Order must
// exactly match FEATURE_NAMES in ml/train_model.py -- enforced at load time in
// server/ml/mlClient.js by comparing FEATURE_NAMES below against the trained model's own
// exported feature_names, rather than relying on this comment alone.
const { haversineDistanceKm } = require('../utils/geo');
const velocity = require('../rules/velocity');

const VELOCITY_WINDOW_MS = velocity.VELOCITY_WINDOW_MS;

// Must exactly match ml/train_model.py's FEATURE_NAMES, in the same order.
const FEATURE_NAMES = [
  'velocity_count_60s',
  'amount_to_avg_ratio',
  'travel_speed_kmh',
  'is_new_device',
  'is_odd_hour',
  'amount',
];

/**
 * @param {{ amount: number, timestamp: string, device_id: string, location: {lat,lng}|null }} transaction
 * @param {{
 *   user: { avg_transaction_amount: number, typical_active_hours: Array<[number,number]>|null }|null,
 *   recentTransactions: Array<{ timestamp: string, location: {lat,lng}|null }>,
 *   knownDeviceIds: string[],
 * }} userHistory
 * @returns {number[]} [velocity_count_60s, amount_to_avg_ratio, travel_speed_kmh, is_new_device, is_odd_hour, amount]
 */
function extractFeatures(transaction, userHistory) {
  const txTime = new Date(transaction.timestamp).getTime();

  const velocityCount60s = (userHistory.recentTransactions || []).filter((t) => {
    const tTime = new Date(t.timestamp).getTime();
    return tTime >= txTime - VELOCITY_WINDOW_MS && tTime < txTime;
  }).length;

  const avg = userHistory.user ? userHistory.user.avg_transaction_amount : 0;
  const amountToAvgRatio = avg && avg > 0 ? transaction.amount / avg : 1;

  let travelSpeedKmh = 0;
  if (transaction.location && transaction.location.lat != null && transaction.location.lng != null) {
    const priorWithLocation = (userHistory.recentTransactions || [])
      .filter((t) => t.location && t.location.lat != null && t.location.lng != null)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const last = priorWithLocation[0];
    if (last) {
      const elapsedSeconds = Math.max((txTime - new Date(last.timestamp).getTime()) / 1000, 1);
      const distanceKm = haversineDistanceKm(
        last.location.lat,
        last.location.lng,
        transaction.location.lat,
        transaction.location.lng
      );
      travelSpeedKmh = distanceKm / (elapsedSeconds / 3600);
    }
  }

  const knownDeviceIds = userHistory.knownDeviceIds || [];
  // Mirrors deviceMismatch.js: a brand-new sender has nothing to mismatch against yet.
  const isNewDevice = knownDeviceIds.length > 0 && !knownDeviceIds.includes(transaction.device_id) ? 1 : 0;

  const ranges = userHistory.user ? userHistory.user.typical_active_hours : null;
  let isOddHour = 0;
  if (ranges && ranges.length > 0) {
    const hour = new Date(transaction.timestamp).getUTCHours();
    isOddHour = ranges.some(([start, end]) => hour >= start && hour < end) ? 0 : 1;
  }

  return [velocityCount60s, amountToAvgRatio, travelSpeedKmh, isNewDevice, isOddHour, transaction.amount];
}

module.exports = extractFeatures;
module.exports.FEATURE_NAMES = FEATURE_NAMES;
