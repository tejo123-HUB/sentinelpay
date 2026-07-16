// Reads/writes user profile + recent-history data for the scoring pipeline. Impure (talks to
// the DB directly) by design — the pure rule/ML/structuring functions consume its output.
const MIN_HISTORY_FOR_ACTIVE_HOURS = 5; // don't lock in a typical-hours baseline until this many transactions exist
const RECENT_TRANSACTIONS_LOOKBACK_MS = 24 * 60 * 60 * 1000; // window fetched for rule/ML feature computation
const RECENT_TRANSACTIONS_LIMIT = 200; // bound on rows fetched per request, keeps the synchronous path fast

function mapTransactionRow(row) {
  return {
    transaction_id: row.transaction_id,
    sender_id: row.sender_id,
    receiver_id: row.receiver_id,
    amount: row.amount,
    timestamp: row.timestamp,
    location:
      row.location_lat != null && row.location_lng != null
        ? { lat: row.location_lat, lng: row.location_lng }
        : null,
    device_id: row.device_id,
    merchant_id: row.merchant_id,
    transaction_type: row.transaction_type,
  };
}

// Ensures a users row exists for this account before it's referenced as sender_id/receiver_id
// (both are foreign keys into users). New accounts start with a zero-average baseline, which
// is exactly the "no meaningful history yet" signal amountAnomaly.js already skips on.
function ensureUserExists(db, userId, timestampIso) {
  const existing = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(userId);
  if (!existing) {
    db.prepare('INSERT INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run(
      userId,
      timestampIso
    );
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} senderId
 * @param {number} nowMs
 * @returns {{ user: object|null, transactionCount: number, recentTransactions: object[], knownDeviceIds: string[] }}
 */
function getUserHistory(db, senderId, nowMs) {
  const userRow = db.prepare('SELECT * FROM users WHERE user_id = ?').get(senderId) || null;

  const transactionCount = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE sender_id = ?')
    .get(senderId).n;

  const lookbackIso = new Date(nowMs - RECENT_TRANSACTIONS_LOOKBACK_MS).toISOString();
  const recentRows = db
    .prepare(
      'SELECT * FROM transactions WHERE sender_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?'
    )
    .all(senderId, lookbackIso, RECENT_TRANSACTIONS_LIMIT);
  const recentTransactions = recentRows.map(mapTransactionRow);

  const deviceRows = db
    .prepare('SELECT DISTINCT device_id FROM transactions WHERE sender_id = ? AND device_id IS NOT NULL')
    .all(senderId);
  const knownDeviceIds = deviceRows.map((r) => r.device_id);

  let user = null;
  if (userRow) {
    let typicalActiveHours = null;
    if (userRow.typical_active_hours) {
      try {
        typicalActiveHours = JSON.parse(userRow.typical_active_hours);
      } catch {
        typicalActiveHours = null;
      }
    }
    user = {
      user_id: userRow.user_id,
      avg_transaction_amount: userRow.avg_transaction_amount,
      typical_active_hours: typicalActiveHours,
      home_location_lat: userRow.home_location_lat,
      home_location_lng: userRow.home_location_lng,
    };
  }

  return { user, transactionCount, recentTransactions, knownDeviceIds };
}

// Contiguous [minHour, maxHour+1) range covering every hour the sender has ever transacted in.
// Simplification: doesn't handle an overnight-wrapping active window (e.g. 22:00-04:00) — an
// acceptable trade-off for the hackathon's scope, noted here rather than silently assumed.
function computeTypicalActiveHoursRange(db, senderId) {
  const rows = db.prepare('SELECT timestamp FROM transactions WHERE sender_id = ?').all(senderId);
  if (rows.length === 0) return null;
  const hours = rows.map((r) => new Date(r.timestamp).getUTCHours());
  return [[Math.min(...hours), Math.max(...hours) + 1]];
}

/**
 * Updates the sender's rolling average spend (architecture.md Section 10, Task 3 formula) and,
 * once enough history exists, their typical active-hours baseline. Must run after the users
 * row for senderId already exists (see ensureUserExists) and after the current transaction has
 * been counted in transactionCountBeforeInsert.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} senderId
 * @param {{ amount: number, location: {lat,lng}|null }} transaction
 * @param {number} transactionCountBeforeInsert - COUNT(*) for this sender *before* this transaction was inserted
 */
function updateUserAfterTransaction(db, senderId, transaction, transactionCountBeforeInsert) {
  const existing = db.prepare('SELECT * FROM users WHERE user_id = ?').get(senderId);
  const newTransactionCount = transactionCountBeforeInsert + 1;

  const newAvg =
    existing.avg_transaction_amount + (transaction.amount - existing.avg_transaction_amount) / newTransactionCount;

  let typicalActiveHoursJson = existing.typical_active_hours;
  if (newTransactionCount >= MIN_HISTORY_FOR_ACTIVE_HOURS) {
    typicalActiveHoursJson = JSON.stringify(computeTypicalActiveHoursRange(db, senderId));
  }

  let homeLat = existing.home_location_lat;
  let homeLng = existing.home_location_lng;
  if (homeLat == null && homeLng == null && transaction.location) {
    homeLat = transaction.location.lat;
    homeLng = transaction.location.lng;
  }

  db.prepare(
    'UPDATE users SET avg_transaction_amount = ?, typical_active_hours = ?, home_location_lat = ?, home_location_lng = ? WHERE user_id = ?'
  ).run(newAvg, typicalActiveHoursJson, homeLat, homeLng, senderId);
}

module.exports = {
  ensureUserExists,
  getUserHistory,
  updateUserAfterTransaction,
  mapTransactionRow,
  MIN_HISTORY_FOR_ACTIVE_HOURS,
};
