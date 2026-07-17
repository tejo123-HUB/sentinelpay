// Impure orchestration layer: wraps the pure pipeline (pipeline.js) with DB reads/writes and
// periodic scheduling. Runs every STRUCTURING_JOB_INTERVAL_MS (default 7s, configurable via
// env) — too expensive to run on every transaction, so it runs out-of-band while the
// per-transaction scoring path only does the fast indexed lookup (alertLookup.js).
const crypto = require('node:crypto');
const runStructuringScan = require('./pipeline');
const detectSplits = require('./splitDetection');
const correlateWithdrawal = require('./withdrawalCorrelation');
const detectCircularFlow = require('./circularFlow');
const { CIRCULAR_FLOW } = require('../config');

const DEFAULT_INTERVAL_MS = Number(process.env.STRUCTURING_JOB_INTERVAL_MS) || 7000;
// Only need to look as far back as the longest window any detector cares about, plus a buffer.
const LOOKBACK_MS = detectSplits.SPLIT_WINDOW_MS + correlateWithdrawal.WITHDRAWAL_WINDOW_MS + 5 * 60 * 1000;
const ALERT_LOOKBACK_MS = runStructuringScan.REALERT_COOLDOWN_MS;
// Feature 6 (circular flow) deliberately uses its own, much longer lookback than LOOKBACK_MS
// above (sized for split-detection performance, ~50 min): a laundering cycle routed through
// several intermediate accounts can easily take hours to close, and a short window would miss
// it entirely.
const CIRCULAR_FLOW_LOOKBACK_MS = CIRCULAR_FLOW.CIRCULAR_FLOW_LOOKBACK_MS;
// Reuses the same cooldown constant/reasoning as the split/fan-out alerts: don't re-alert the
// same origin's cycle every scan cycle once it's already been recorded.
const CIRCULAR_FLOW_REALERT_COOLDOWN_MS = runStructuringScan.REALERT_COOLDOWN_MS;

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

  // Feature 6 (circular flow): reuses the same structuring_alerts table and the same fast
  // per-transaction lookup (alertLookup.js already checks sender_id and receiver_ids membership
  // generically -- no changes needed there) rather than a parallel alert mechanism. Origins are
  // the business's own registered accounts: circular flow only matters relative to money that
  // started at the business, matching this extension's outbound-only scoping (Section 15.12).
  const businessAccountRows = db.prepare('SELECT account_id FROM business_accounts').all();
  const originIds = businessAccountRows.map((r) => r.account_id);
  const circularFlowAlerts = [];
  if (originIds.length > 0) {
    const circularLookbackIso = new Date(nowMs - CIRCULAR_FLOW_LOOKBACK_MS).toISOString();
    const circularFlowTransactions = db
      .prepare('SELECT sender_id, receiver_id, amount, timestamp FROM transactions WHERE timestamp >= ? ORDER BY timestamp ASC')
      .all(circularLookbackIso);

    const cooldownSinceIso = new Date(nowMs - CIRCULAR_FLOW_REALERT_COOLDOWN_MS).toISOString();
    const recentCircularAlertOrigins = new Set(
      db
        .prepare("SELECT sender_id FROM structuring_alerts WHERE reason LIKE 'Circular transaction pattern detected.%' AND created_at >= ?")
        .all(cooldownSinceIso)
        .map((r) => r.sender_id)
    );

    const cycles = detectCircularFlow(circularFlowTransactions, originIds);
    for (const cycle of cycles) {
      if (recentCircularAlertOrigins.has(cycle.originId)) continue;
      const nowIso = new Date(nowMs).toISOString();
      circularFlowAlerts.push({
        alert_id: `alert_${crypto.randomUUID()}`,
        sender_id: cycle.originId,
        receiver_ids: JSON.stringify(cycle.path.slice(1, -1)),
        total_amount: cycle.totalAmount,
        transaction_count: cycle.transactionCount,
        window_start: cycle.windowStart,
        window_end: cycle.windowEnd,
        withdrawal_ratio: null,
        reason: `Circular transaction pattern detected. (${cycle.path.join(' -> ')})`,
        created_at: nowIso,
      });
    }
  }

  const allNewAlerts = [...newAlerts, ...circularFlowAlerts];

  if (allNewAlerts.length > 0) {
    const insertStmt = db.prepare(insertAlertStmtSql);
    for (const alert of allNewAlerts) {
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

  return allNewAlerts;
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
