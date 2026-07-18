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
// Circular-flow alerts (Feature 6) record the business's own account as sender_id -- that's the
// detection *origin*, not a suspected bad actor (see backgroundJob.js's circular-flow comment:
// "Origins are the business's own registered accounts"). Treating that ID as "an active alert
// participant" the same way a genuine structuring perpetrator's sender_id is treated would
// force-block every ordinary transaction touching the business's own account for the next 24h,
// the instant its own money legitimately cycles through a vendor/refund relationship -- found live
// via demo seed data, where every seeded store ended up with an active circular-flow alert naming
// itself as sender_id, and every subsequent customer purchase to any of them force-blocked at the
// STRUCTURING_ALERT_FLOOR. The intermediate accounts in receiver_ids are the actual suspects for a
// circular-flow alert; that check below still applies to these alerts unchanged.
function isCircularFlowAlert(alert) {
  return alert.reason.startsWith('Circular transaction pattern detected.');
}

function findActiveAlert(db, senderId, receiverId, nowMs) {
  const activeSinceIso = new Date(nowMs - ALERT_ACTIVE_WINDOW_MS).toISOString();

  // Indexed lookup: does this account appear as the sender of an active (non-circular-flow)
  // alert? Fetches a small bounded set, not just the single most recent row, so a circular-flow
  // alert sharing this sender_id doesn't hide a genuine, older structuring alert for the same ID.
  const bySenderCandidates = db
    .prepare(
      'SELECT * FROM structuring_alerts WHERE sender_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 5'
    )
    .all(senderId, activeSinceIso);
  const bySender = bySenderCandidates.find((alert) => !isCircularFlowAlert(alert));
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
    if (!isCircularFlowAlert(alert) && alert.sender_id === receiverId) {
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
