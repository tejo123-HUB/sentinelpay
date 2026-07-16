// Fast per-transaction check used inside the synchronous scoring path: "is this sender or
// receiver already part of a known structuring/laundering pattern?" Deliberately cheap —
// the heavy graph analysis itself runs in the background job (pipeline.js + backgroundJob.js).
const ALERT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000; // how long an alert stays "active" for scoring purposes

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} senderId
 * @param {string} receiverId
 * @param {number} nowMs
 * @returns {{ active: boolean, alert: object|null }}
 */
function findActiveAlert(db, senderId, receiverId, nowMs) {
  const activeSinceIso = new Date(nowMs - ALERT_ACTIVE_WINDOW_MS).toISOString();

  // Indexed lookup: does this account appear as the sender of an active alert?
  const bySender = db
    .prepare(
      'SELECT * FROM structuring_alerts WHERE sender_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(senderId, activeSinceIso);
  if (bySender) {
    return { active: true, alert: bySender };
  }

  // Bounded scan of recent alerts to check receiver membership (JSON array column, so no
  // direct index — bounded by the active window and a row cap, which is well within budget
  // at hackathon/demo scale).
  const recentAlerts = db
    .prepare('SELECT * FROM structuring_alerts WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200')
    .all(activeSinceIso);

  for (const alert of recentAlerts) {
    if (alert.sender_id === receiverId) {
      return { active: true, alert };
    }
    let receiverIds = [];
    try {
      receiverIds = JSON.parse(alert.receiver_ids);
    } catch {
      receiverIds = [];
    }
    if (receiverIds.includes(senderId) || receiverIds.includes(receiverId)) {
      return { active: true, alert };
    }
  }

  return { active: false, alert: null };
}

findActiveAlert.ALERT_ACTIVE_WINDOW_MS = ALERT_ACTIVE_WINDOW_MS;

module.exports = findActiveAlert;
