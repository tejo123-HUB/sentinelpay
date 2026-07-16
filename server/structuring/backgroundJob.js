// Impure orchestration layer: wraps the pure pipeline (pipeline.js) with DB reads/writes and
// periodic scheduling. Runs every STRUCTURING_JOB_INTERVAL_MS (default 7s, configurable via
// env) — too expensive to run on every transaction, so it runs out-of-band while the
// per-transaction scoring path only does the fast indexed lookup (alertLookup.js).
const runStructuringScan = require('./pipeline');
const detectSplits = require('./splitDetection');
const correlateWithdrawal = require('./withdrawalCorrelation');

const DEFAULT_INTERVAL_MS = Number(process.env.STRUCTURING_JOB_INTERVAL_MS) || 7000;
// Only need to look as far back as the longest window any detector cares about, plus a buffer.
const LOOKBACK_MS = detectSplits.SPLIT_WINDOW_MS + correlateWithdrawal.WITHDRAWAL_WINDOW_MS + 5 * 60 * 1000;
const ALERT_LOOKBACK_MS = runStructuringScan.REALERT_COOLDOWN_MS;

const insertAlertStmtSql = `
  INSERT INTO structuring_alerts
    (alert_id, sender_id, receiver_ids, total_amount, transaction_count, window_start, window_end, withdrawal_ratio, reason, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Runs one scan cycle: reads recent transactions + recent alerts from the DB, runs the pure
 * pipeline, and persists any new alerts. Returns the alerts that were created.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} nowMs
 * @returns {Array<object>} newly created alert rows
 */
function runScanCycle(db, nowMs = Date.now()) {
  const lookbackIso = new Date(nowMs - LOOKBACK_MS).toISOString();
  const alertLookbackIso = new Date(nowMs - ALERT_LOOKBACK_MS).toISOString();

  const transactions = db
    .prepare('SELECT * FROM transactions WHERE timestamp >= ? ORDER BY timestamp ASC')
    .all(lookbackIso);

  const existingAlerts = db
    .prepare('SELECT sender_id, created_at FROM structuring_alerts WHERE created_at >= ?')
    .all(alertLookbackIso);

  // Unbounded (full account history, not just the LOOKBACK_MS-bounded `transactions` above):
  // "is this receiver new to this sender" must be answered from the real relationship history,
  // not from whatever happens to still be inside the last ~45 minutes. Reusing the bounded set
  // here was the actual bug — two people who've paid each other for months would look like a
  // brand-new fan-out receiver the moment the sender did anything resembling a quick burst of
  // transfers to them. One indexed query per candidate sender (idx_transactions_sender), not a
  // full-table scan — cheap even though it's unbounded, since split candidates are rare (at
  // most a handful of senders qualify per scan cycle).
  const priorReceiverStmt = db.prepare(
    'SELECT DISTINCT receiver_id FROM transactions WHERE sender_id = ? AND timestamp < ?'
  );
  const getPriorReceiverIds = (senderId, beforeMs) => {
    const rows = priorReceiverStmt.all(senderId, new Date(beforeMs).toISOString());
    return new Set(rows.map((r) => r.receiver_id));
  };

  const newAlerts = runStructuringScan(transactions, nowMs, existingAlerts, getPriorReceiverIds);

  if (newAlerts.length > 0) {
    const insertStmt = db.prepare(insertAlertStmtSql);
    for (const alert of newAlerts) {
      insertStmt.run(
        alert.alert_id,
        alert.sender_id,
        alert.receiver_ids,
        alert.total_amount,
        alert.transaction_count,
        alert.window_start,
        alert.window_end,
        alert.withdrawal_ratio,
        alert.reason,
        alert.created_at
      );
    }
  }

  return newAlerts;
}

/**
 * Starts the periodic background scan. Returns a handle with .stop() so callers (and tests)
 * can shut it down cleanly.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {(type: string, data: object) => void} [broadcast] - called once per new alert
 * @param {number} [intervalMs]
 */
function startStructuringJob(db, broadcast, intervalMs = DEFAULT_INTERVAL_MS) {
  if (!db) return { stop() {} };

  const timer = setInterval(() => {
    try {
      const newAlerts = runScanCycle(db, Date.now());
      if (broadcast) {
        for (const alert of newAlerts) {
          broadcast('structuring_alert', {
            sender_id: alert.sender_id,
            receiver_ids: JSON.parse(alert.receiver_ids),
            total_amount: alert.total_amount,
            transaction_count: alert.transaction_count,
            withdrawal_ratio: alert.withdrawal_ratio,
            reason: alert.reason,
            created_at: alert.created_at,
          });
        }
      }
    } catch (err) {
      console.error('Structuring background job failed:', err);
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { startStructuringJob, runScanCycle, LOOKBACK_MS };
