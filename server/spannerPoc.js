// Google Cloud Spanner proof-of-concept module (24 July 2026 Google Cloud integration pass).
//
// Deliberately scoped down from "swap out the database" to "prove the real integration works":
// this project's primary, tested data layer is still SQLite (server/db.js) -- rewriting every
// query in ~40 files to Cloud Spanner's SQL dialect this late in a 525+-test build was assessed
// as too large and risky a change to make blindly, and Spanner has no free tier (a live instance
// costs real money the moment it exists, unlike this project's other optional Google
// integrations). What ships here instead is a real, working `@google-cloud/spanner` client --
// schema DDL (a translated subset of server/db.js's users/transactions tables), a genuine insert,
// and a genuine parameterized query -- runnable end-to-end against a real Spanner instance via
// `npm run spanner:poc` (scripts/spanner_poc_demo.js). Not wired into server/index.js or any
// request-handling path.
//
// Auth: standard GOOGLE_APPLICATION_CREDENTIALS Application Default Credentials, same convention
// as this pass's other two integrations (server/caseEvidence.js's Cloud Storage backend,
// server/ml/mlClient.js's Vertex AI backend).

// Google Standard SQL (Cloud Spanner's dialect) translation of the users/transactions subset of
// server/db.js's SCHEMA -- STRING(MAX) for TEXT, FLOAT64 for REAL, TIMESTAMP for the ISO 8601
// strings this project stores as TEXT in SQLite. CHECK constraints and cross-table FOREIGN KEYs
// (both of which Spanner does support) are intentionally omitted here to keep this POC's schema
// simple to stand up against a fresh instance -- a real migration would restore them.
const SPANNER_DDL = [
  `CREATE TABLE users (
    user_id STRING(MAX) NOT NULL,
    created_at TIMESTAMP NOT NULL,
    home_location_lat FLOAT64,
    home_location_lng FLOAT64,
    avg_transaction_amount FLOAT64,
    typical_active_hours STRING(MAX),
  ) PRIMARY KEY (user_id)`,
  `CREATE TABLE transactions (
    transaction_id STRING(MAX) NOT NULL,
    sender_id STRING(MAX) NOT NULL,
    receiver_id STRING(MAX) NOT NULL,
    amount FLOAT64 NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    location_lat FLOAT64,
    location_lng FLOAT64,
    device_id STRING(MAX),
    merchant_id STRING(MAX),
    purpose STRING(MAX),
    transaction_type STRING(MAX) NOT NULL,
    fraud_score FLOAT64,
    decision STRING(MAX),
  ) PRIMARY KEY (transaction_id)`,
  `CREATE INDEX idx_transactions_sender ON transactions(sender_id, timestamp)`,
  `CREATE INDEX idx_transactions_receiver ON transactions(receiver_id, timestamp)`,
];

function spannerConfigured() {
  return !!(process.env.SPANNER_PROJECT_ID && process.env.SPANNER_INSTANCE_ID && process.env.SPANNER_DATABASE_ID);
}

// Lazily required, same reasoning as the Cloud Storage/Vertex AI integrations: this SDK's
// gRPC/protobuf dependency tree is only loaded into memory when this POC module is actually used.
function getSpannerDatabase() {
  if (!spannerConfigured()) {
    throw new Error('Spanner POC requires SPANNER_PROJECT_ID, SPANNER_INSTANCE_ID, and SPANNER_DATABASE_ID to be set');
  }
  const { Spanner } = require('@google-cloud/spanner');
  const spanner = new Spanner({ projectId: process.env.SPANNER_PROJECT_ID });
  return spanner.instance(process.env.SPANNER_INSTANCE_ID).database(process.env.SPANNER_DATABASE_ID);
}

/**
 * Creates any of SPANNER_DDL's tables/indexes that don't already exist on the given database.
 * Idempotent -- safe to call every time scripts/spanner_poc_demo.js runs, so a second run against
 * the same instance doesn't fail on "table already exists".
 * @param {import('@google-cloud/spanner').Database} database
 */
async function createSchemaIfNeeded(database) {
  const [tables] = await database.run({
    sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = ''",
  });
  const existingNames = new Set(tables.map((row) => row.toJSON().table_name));
  const missingDdl = SPANNER_DDL.filter((statement) => {
    const match = statement.match(/CREATE (?:TABLE|INDEX \w+ ON) (\w+)/i);
    return match && !existingNames.has(match[1]);
  });
  if (missingDdl.length === 0) return;
  const [operation] = await database.updateSchema(missingDdl);
  await operation.promise();
}

/**
 * @param {import('@google-cloud/spanner').Database} database
 * @param {{ transaction_id: string, sender_id: string, receiver_id: string, amount: number,
 *   timestamp: string, transaction_type: string, fraud_score?: number, decision?: string }} transaction
 */
async function insertTransaction(database, transaction) {
  await database.table('transactions').insert({
    transaction_id: transaction.transaction_id,
    sender_id: transaction.sender_id,
    receiver_id: transaction.receiver_id,
    amount: transaction.amount,
    timestamp: transaction.timestamp,
    location_lat: transaction.location_lat ?? null,
    location_lng: transaction.location_lng ?? null,
    device_id: transaction.device_id ?? null,
    merchant_id: transaction.merchant_id ?? null,
    purpose: transaction.purpose ?? null,
    transaction_type: transaction.transaction_type,
    fraud_score: transaction.fraud_score ?? null,
    decision: transaction.decision ?? null,
  });
}

/**
 * @param {import('@google-cloud/spanner').Database} database
 * @param {string} senderId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
async function getTransactionsBySender(database, senderId, limit = 50) {
  const { Spanner } = require('@google-cloud/spanner');
  const [rows] = await database.run({
    sql: 'SELECT transaction_id, sender_id, receiver_id, amount, timestamp, decision FROM transactions WHERE sender_id = @senderId ORDER BY timestamp DESC LIMIT @limit',
    params: { senderId, limit: Spanner.int(limit) },
    types: { senderId: 'string', limit: 'int64' },
  });
  return rows.map((row) => row.toJSON());
}

module.exports = {
  SPANNER_DDL,
  spannerConfigured,
  getSpannerDatabase,
  createSchemaIfNeeded,
  insertTransaction,
  getTransactionsBySender,
};
