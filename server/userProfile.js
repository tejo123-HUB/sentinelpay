// Reads/writes user profile + recent-history data for the scoring pipeline. Impure (talks to
// the DB directly) by design — the pure rule/ML/structuring functions consume its output.
const MIN_HISTORY_FOR_ACTIVE_HOURS = 5; // don't lock in a typical-hours baseline until this many transactions exist
const RECENT_TRANSACTIONS_LOOKBACK_MS = 24 * 60 * 60 * 1000; // window fetched for rule/ML feature computation
const RECENT_TRANSACTIONS_LIMIT = 200; // bound on rows fetched per request, keeps the synchronous path fast
// Found during a full-project security/correctness review: computeTypicalActiveHoursRange used
// to scan a sender's *entire* lifetime transaction history with no LIMIT, on every single
// transaction once they passed MIN_HISTORY_FOR_ACTIVE_HOURS — an O(n) query per request growing
// without bound as a power user's transaction count grew, directly at odds with this system's
// real-time latency claims. Worse, the range was min/max over all-time history, so it could only
// ever widen, never narrow: one early off-hour transaction (even a genuine one-off) permanently
// "unlocked" that hour from ever tripping oddHour.js again for that account — a patient attacker
// could deliberately transact once at their intended fraud hour early in an account's life
// specifically to neutralize that signal. Bounding to a rolling window fixes both: the query cost
// is capped regardless of lifetime volume, and an old outlier hour eventually ages back out.
const ACTIVE_HOURS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // only the last 30 days count toward "typical"
const ACTIVE_HOURS_SAMPLE_LIMIT = 1000; // hard cap on rows scanned even within that window

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

// Contiguous [minHour, maxHour+1) range covering every hour the sender has transacted in within
// the last ACTIVE_HOURS_LOOKBACK_MS (not all-time history — see the comment on that constant).
// Simplification: doesn't handle an overnight-wrapping active window (e.g. 22:00-04:00) — an
// acceptable trade-off for the hackathon's scope, noted here rather than silently assumed.
function computeTypicalActiveHoursRange(db, senderId, nowMs) {
  const sinceIso = new Date(nowMs - ACTIVE_HOURS_LOOKBACK_MS).toISOString();
  const rows = db
    .prepare('SELECT timestamp FROM transactions WHERE sender_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?')
    .all(senderId, sinceIso, ACTIVE_HOURS_SAMPLE_LIMIT);
  if (rows.length === 0) return null;
  const hours = rows.map((r) => new Date(r.timestamp).getUTCHours());
  return [[Math.min(...hours), Math.max(...hours) + 1]];
}

/**
 * Updates the sender's rolling average spend (architecture.md Section 10, Task 3 formula) and,
 * once enough history exists, their typical active-hours baseline. Must run after the users
 * row for senderId already exists (see ensureUserExists) and after the current transaction has
 * already been inserted (the count below is read fresh, post-insert).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} senderId
 * @param {{ amount: number, location: {lat,lng}|null, timestamp: string }} transaction
 */
function updateUserAfterTransaction(db, senderId, transaction) {
  // Concurrency note: under the default ML_SERVING_MODE=local, getFraudProbability resolves
  // via microtask only, so Node's single-threaded event loop can't interleave another
  // request's handler between this sender's transaction being inserted and this function
  // running — no real race in the default demo path. But ML_SERVING_MODE=python-service/vertex
  // do genuine async I/O (a real fetch), which *can* interleave two concurrent requests for the
  // same sender. The average is therefore computed as a single atomic SQL UPDATE (SQLite
  // resolves `avg_transaction_amount` to its current value within that one statement, not a
  // JS-cached value read earlier) rather than a read-in-JS-then-write-back — the previous
  // version could let two concurrent requests both read the same stale average and have
  // whichever wrote last completely overwrite the other's contribution. The count is also
  // read fresh here (after this transaction's own INSERT has already committed), not carried
  // over from an earlier read taken before the insert.
  const currentCount = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE sender_id = ?').get(senderId).n;

  db.prepare(
    'UPDATE users SET avg_transaction_amount = avg_transaction_amount + (? - avg_transaction_amount) / ? WHERE user_id = ?'
  ).run(transaction.amount, currentCount, senderId);

  const existing = db.prepare('SELECT * FROM users WHERE user_id = ?').get(senderId);

  let typicalActiveHoursJson = existing.typical_active_hours;
  if (currentCount >= MIN_HISTORY_FOR_ACTIVE_HOURS) {
    const nowMs = new Date(transaction.timestamp).getTime();
    typicalActiveHoursJson = JSON.stringify(computeTypicalActiveHoursRange(db, senderId, nowMs));
  }

  let homeLat = existing.home_location_lat;
  let homeLng = existing.home_location_lng;
  if (homeLat == null && homeLng == null && transaction.location) {
    homeLat = transaction.location.lat;
    homeLng = transaction.location.lng;
  }

  db.prepare('UPDATE users SET typical_active_hours = ?, home_location_lat = ?, home_location_lng = ? WHERE user_id = ?').run(
    typicalActiveHoursJson,
    homeLat,
    homeLng,
    senderId
  );
}

module.exports = {
  ensureUserExists,
  getUserHistory,
  updateUserAfterTransaction,
  mapTransactionRow,
  computeTypicalActiveHoursRange,
  MIN_HISTORY_FOR_ACTIVE_HOURS,
  ACTIVE_HOURS_LOOKBACK_MS,
};
