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
  reference_transaction_id TEXT, -- links a refund to the purchase it refunds (Section 15.16, Feature 1/3/7); optional
  employee_id TEXT, -- internal staff member who initiated a merchant-side transaction (Section 15.16, Feature 10); optional
  country TEXT, -- ISO country code, for geo-risk scoring (Section 15.16, Feature 14); optional
  ip_address TEXT, -- for geo-risk IP-range scoring (Section 15.16, Feature 14); optional
  latency_ms REAL, -- scoring-pipeline processing time for this request (Section 15.16, Feature 18 analytics); not a scoring input
  confidence REAL, -- 0-100, how much independent corroboration backs the decision (Section 16, Category 13); distinct from fraud_score
  phone TEXT, -- optional, for shared-phone detection (Section 16, Category 11)
  email TEXT, -- optional, for shared-email detection (Section 16, Category 11)
  identity_hash TEXT, -- optional, caller-computed hash of a government ID (PAN/Aadhaar/etc) -- this system never receives or stores the raw document number, only an opaque token, so shared-identity-document detection works without collecting the PII itself (Section 16, Category 11)
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
  severity TEXT, -- Low/Medium/High/Critical (Section 15.16, Feature 17); nullable since flags predating this column have none recorded
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

-- User-editable registry of the business's own account IDs (e.g. its storefront/receiver
-- accounts), so the dashboard can tell which side of a transaction is the business vs. the
-- customer instead of guessing from ID naming conventions. No FK to users -- an ID can be
-- registered before or independent of having any transactions.
CREATE TABLE IF NOT EXISTS business_accounts (
  account_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Feature 4 (Section 15.16): merchant login metadata, so a takeover attempt (new device/location
-- immediately followed by a refund/payout/settlement) can be detected. Independent of
-- transactions -- a login event carries no amount/receiver, just who logged in, from where.
CREATE TABLE IF NOT EXISTS merchant_login_events (
  login_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  device_id TEXT,
  browser TEXT,
  os TEXT,
  ip_address TEXT,
  location_lat REAL,
  location_lng REAL,
  country TEXT,
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merchant_login_events_merchant ON merchant_login_events(merchant_id, timestamp);

-- Feature 8 (Section 15.16): chargeback/dispute events, for friendly-fraud customer risk scoring.
-- No FK to transactions -- a dispute can reference a transaction the disputing party doesn't
-- control the lifecycle of, and a missing/unknown transaction_id shouldn't block ingestion.
CREATE TABLE IF NOT EXISTS disputes (
  dispute_id TEXT PRIMARY KEY,
  transaction_id TEXT,
  customer_id TEXT NOT NULL,
  dispute_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_disputes_customer ON disputes(customer_id);

-- Section 16 (Enterprise Edition roadmap, Categories 19/21): blacklist/whitelist/watchlist
-- registry, the same editable-registry pattern as business_accounts. An account can appear on
-- more than one list over time (list_type + account_id is not unique) -- e.g. watchlisted, then
-- later confirmed and blacklisted; the history stays, scoring only cares whether any row of a
-- given type currently exists.
CREATE TABLE IF NOT EXISTS fraud_lists (
  entry_id TEXT PRIMARY KEY,
  list_type TEXT NOT NULL CHECK (list_type IN ('blacklist', 'whitelist', 'watchlist')),
  account_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fraud_lists_account ON fraud_lists(account_id, list_type);

-- Section 16, Category 13/14: the safe subset of "Investigation Notes" that doesn't need a real
-- analyst-identity system -- free-text notes attachable to a transaction. Deliberately
-- append-only (no DELETE route): an investigation record that could be silently erased isn't a
-- trustworthy one. author is caller-supplied free text, same trust model as transactions.
-- employee_id -- not a verified identity, since this build has no login system (Section 15.6).
CREATE TABLE IF NOT EXISTS investigation_notes (
  note_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  note TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_investigation_notes_transaction ON investigation_notes(transaction_id);

-- Section 16, Category 20/21: records who (by IP, since there's no user auth) did what to the
-- editable registries (business_accounts, fraud_lists) and when -- the same "no real identity,
-- but a real trail" trust model as investigation_notes above.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  log_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail TEXT,
  actor_ip TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log(created_at);

-- Section 16, Category 14: the real, working subset of the Fraud Investigation Module that
-- doesn't need a full analyst-identity/login system -- case creation, assignment (caller-
-- supplied label, same trust model as employee_id/investigation_notes.author), and status
-- tracking. "Investigation Timeline"/"Fraud Replay" are served by GET /cases/:caseId/timeline,
-- which merges linked transactions, their structuring alerts, and investigation_notes in
-- chronological order -- a real feature, not a video-style replay mechanism.
CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'investigating', 'resolved', 'escalated')),
  assigned_to TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_transactions (
  case_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (case_id, transaction_id),
  FOREIGN KEY (case_id) REFERENCES cases(case_id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_case_transactions_transaction ON case_transactions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);

-- Section 16, Category 19: a real, working no-code rule engine -- new detection rules defined
-- declaratively via the API, not by writing a new server/rules/*.js file and redeploying.
-- Evaluated generically (server/customRules.js) against every outbound transaction alongside the
-- 23 hardcoded detectors.
CREATE TABLE IF NOT EXISTS custom_rules (
  rule_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  field TEXT NOT NULL,
  operator TEXT NOT NULL,
  value TEXT NOT NULL,
  weight REAL NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('Low', 'Medium', 'High', 'Critical')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_custom_rules_enabled ON custom_rules(enabled);

-- Section 16, Category 18: generated report snapshots (daily/weekly/monthly), produced by a
-- background job (server/scheduledReports.js) on the same periodic-tick pattern as the
-- structuring background job. Delivery (email, via the real notification engine, Category 17)
-- is a side effect of generation, not a separate unimplemented step.
CREATE TABLE IF NOT EXISTS scheduled_reports (
  report_id TEXT PRIMARY KEY,
  report_type TEXT NOT NULL CHECK (report_type IN ('daily', 'weekly', 'monthly')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  emailed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_reports_type_period ON scheduled_reports(report_type, period_end);
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
