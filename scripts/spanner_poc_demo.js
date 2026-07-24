// Cloud Spanner proof-of-concept demo (24 July 2026 Google Cloud integration pass) -- run with
// `npm run spanner:poc`. Connects to a real Spanner instance you've already provisioned (this
// repo cannot create GCP projects, enable billing, or provision Spanner instances for you),
// creates server/spannerPoc.js's schema if it's not already there, inserts one sample
// transaction, and queries it back by sender_id -- a concrete, runnable proof that the
// integration genuinely works end-to-end, not just code that looks plausible.
//
// Requires SPANNER_PROJECT_ID, SPANNER_INSTANCE_ID, SPANNER_DATABASE_ID, and
// GOOGLE_APPLICATION_CREDENTIALS (a service-account key with Cloud Spanner Database User on the
// target database) -- see .env.example.
require('dotenv').config();
const crypto = require('node:crypto');
const {
  spannerConfigured,
  getSpannerDatabase,
  createSchemaIfNeeded,
  insertTransaction,
  getTransactionsBySender,
} = require('../server/spannerPoc');

async function main() {
  if (!spannerConfigured()) {
    console.error(
      'Spanner is not configured. Set SPANNER_PROJECT_ID, SPANNER_INSTANCE_ID, SPANNER_DATABASE_ID, ' +
        'and GOOGLE_APPLICATION_CREDENTIALS (see .env.example) before running this script.'
    );
    process.exitCode = 1;
    return;
  }

  console.log('Connecting to Cloud Spanner...');
  const database = getSpannerDatabase();

  console.log('Ensuring schema exists (creates users/transactions tables + indexes if missing)...');
  await createSchemaIfNeeded(database);

  const senderId = `u_spanner_poc_${crypto.randomUUID().slice(0, 8)}`;
  const sampleTransaction = {
    transaction_id: `t_spanner_poc_${crypto.randomUUID()}`,
    sender_id: senderId,
    receiver_id: 'u_spanner_poc_receiver',
    amount: 42.5,
    timestamp: new Date().toISOString(),
    transaction_type: 'transfer',
    fraud_score: 12,
    decision: 'allow',
  };

  console.log(`Inserting sample transaction ${sampleTransaction.transaction_id}...`);
  await insertTransaction(database, sampleTransaction);

  console.log(`Querying transactions for sender ${senderId}...`);
  const rows = await getTransactionsBySender(database, senderId);

  console.log('Round-tripped result:', rows);
  const found = rows.some((row) => row.transaction_id === sampleTransaction.transaction_id);
  console.log(found ? '\nSUCCESS: the inserted transaction round-tripped through a real Spanner instance.' : '\nFAILED: the inserted transaction was not found on read-back.');
  process.exitCode = found ? 0 : 1;
}

main().catch((err) => {
  console.error('Spanner POC demo failed:', err.message);
  process.exitCode = 1;
});
