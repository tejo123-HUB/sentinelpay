// PROD: Cloud Spanner — DEMO: SQLite (via the built-in node:sqlite module, see architecture.md Section 9)
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  home_location_lat REAL,
  home_location_lng REAL,
  avg_transaction_amount REAL DEFAULT 0,
  typical_active_hours TEXT
);

-- sender_id/receiver_id are directional, not role-fixed: on an ordinary payment the customer
-- is sender_id and the merchant is receiver_id; on a refund/payout the merchant is sender_id
-- and the customer is receiver_id. merchant_id identifies which of the business's own
-- payment-gateway accounts (Stripe/Razorpay/PayPal, etc.) the transaction was ingested from.
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  amount REAL NOT NULL,
  timestamp TEXT NOT NULL,
  location_lat REAL,
  location_lng REAL,
  device_id TEXT,
  merchant_id TEXT,
  purpose TEXT, -- human-readable note, mainly populated on merchant-initiated outgoing transactions (refunds, payouts)
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('transfer', 'withdrawal', 'deposit')),
  fraud_score REAL,
  decision TEXT CHECK (decision IN ('allow', 'step_up', 'block')),
  FOREIGN KEY (sender_id) REFERENCES users(user_id),
  FOREIGN KEY (receiver_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_sender ON transactions(sender_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_transactions_receiver ON transactions(receiver_id, timestamp);

CREATE TABLE IF NOT EXISTS flags (
  flag_id TEXT PRIMARY KEY,
  transaction_id TEXT,
  flag_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  weight REAL NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_flags_transaction ON flags(transaction_id);

CREATE TABLE IF NOT EXISTS structuring_alerts (
  alert_id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  receiver_ids TEXT NOT NULL,
  total_amount REAL NOT NULL,
  transaction_count INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  withdrawal_ratio REAL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_structuring_alerts_sender ON structuring_alerts(sender_id);
-- Added during a full-project review: alertLookup.js's receiver-side check and the background
-- job's cooldown check both filter/order structuring_alerts by created_at with no supporting
-- index — fine at demo-table sizes, but a full scan waiting to happen at real volume.
CREATE INDEX IF NOT EXISTS idx_structuring_alerts_created_at ON structuring_alerts(created_at);
`;

function initDb(dbPath) {
  const resolvedPath = dbPath || process.env.DB_PATH || path.join(process.cwd(), 'sentinelpay.db');
  const db = new DatabaseSync(resolvedPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  return db;
}

module.exports = { initDb, SCHEMA };
