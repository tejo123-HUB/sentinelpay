// Cloud Spanner proof-of-concept module (24 July 2026 Google Cloud integration pass). No live
// Spanner instance is available in this test environment (see server/spannerPoc.js's header
// comment for why this stayed a POC rather than becoming the primary datastore) -- these tests
// cover what doesn't need one: the DDL's shape, spannerConfigured()'s env-var gating, and that
// insertTransaction/getTransactionsBySender build the correct request against a real `database`
// object's API surface (mocked here, matching the @google-cloud/storage/aiplatform mocking
// approach used in tests/caseEvidence.test.js and tests/ml.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  SPANNER_DDL,
  spannerConfigured,
  getSpannerDatabase,
  createSchemaIfNeeded,
  insertTransaction,
  getTransactionsBySender,
} = require('../server/spannerPoc');

delete process.env.SPANNER_PROJECT_ID;
delete process.env.SPANNER_INSTANCE_ID;
delete process.env.SPANNER_DATABASE_ID;

test('SPANNER_DDL: defines the translated users and transactions tables with their indexes', () => {
  assert.equal(SPANNER_DDL.length, 4);
  const usersDdl = SPANNER_DDL.find((s) => /CREATE TABLE users/i.test(s));
  const transactionsDdl = SPANNER_DDL.find((s) => /CREATE TABLE transactions/i.test(s));
  assert.ok(usersDdl, 'expected a users table DDL statement');
  assert.ok(transactionsDdl, 'expected a transactions table DDL statement');
  // Google Standard SQL types, not SQLite's TEXT/REAL -- the actual dialect translation under test.
  assert.match(usersDdl, /user_id STRING\(MAX\) NOT NULL/);
  assert.match(usersDdl, /PRIMARY KEY \(user_id\)/);
  assert.match(transactionsDdl, /amount FLOAT64 NOT NULL/);
  assert.match(transactionsDdl, /timestamp TIMESTAMP NOT NULL/);
  assert.match(transactionsDdl, /PRIMARY KEY \(transaction_id\)/);
  assert.ok(SPANNER_DDL.some((s) => /CREATE INDEX idx_transactions_sender ON transactions\(sender_id, timestamp\)/i.test(s)));
  assert.ok(SPANNER_DDL.some((s) => /CREATE INDEX idx_transactions_receiver ON transactions\(receiver_id, timestamp\)/i.test(s)));
});

test('spannerConfigured: false when any of the three required env vars is missing', () => {
  assert.equal(spannerConfigured(), false);
  process.env.SPANNER_PROJECT_ID = 'p';
  process.env.SPANNER_INSTANCE_ID = 'i';
  try {
    assert.equal(spannerConfigured(), false);
  } finally {
    delete process.env.SPANNER_PROJECT_ID;
    delete process.env.SPANNER_INSTANCE_ID;
  }
});

test('spannerConfigured: true when all three required env vars are set', () => {
  process.env.SPANNER_PROJECT_ID = 'p';
  process.env.SPANNER_INSTANCE_ID = 'i';
  process.env.SPANNER_DATABASE_ID = 'd';
  try {
    assert.equal(spannerConfigured(), true);
  } finally {
    delete process.env.SPANNER_PROJECT_ID;
    delete process.env.SPANNER_INSTANCE_ID;
    delete process.env.SPANNER_DATABASE_ID;
  }
});

test('getSpannerDatabase: throws a fast, clear config error when unconfigured (no network attempt)', () => {
  assert.throws(() => getSpannerDatabase(), /SPANNER_PROJECT_ID/);
});

test('getSpannerDatabase: constructs a database handle without throwing when configured (no live connection made)', () => {
  process.env.SPANNER_PROJECT_ID = 'test-project';
  process.env.SPANNER_INSTANCE_ID = 'test-instance';
  process.env.SPANNER_DATABASE_ID = 'test-database';
  try {
    const database = getSpannerDatabase();
    assert.equal(typeof database.run, 'function');
    assert.equal(typeof database.table, 'function');
  } finally {
    delete process.env.SPANNER_PROJECT_ID;
    delete process.env.SPANNER_INSTANCE_ID;
    delete process.env.SPANNER_DATABASE_ID;
  }
});

test('createSchemaIfNeeded: only creates tables/indexes not already present, and waits on the operation', async () => {
  const ranQueries = [];
  let updateSchemaCalledWith = null;
  let operationAwaited = false;
  const fakeDatabase = {
    run: async (req) => {
      ranQueries.push(req.sql);
      return [[{ toJSON: () => ({ table_name: 'users' }) }]];
    },
    updateSchema: async (statements) => {
      updateSchemaCalledWith = statements;
      return [{ promise: async () => { operationAwaited = true; } }];
    },
  };

  await createSchemaIfNeeded(fakeDatabase);

  assert.equal(ranQueries.length, 1);
  assert.match(ranQueries[0], /information_schema\.tables/);
  assert.ok(updateSchemaCalledWith, 'expected updateSchema to be called for the missing tables/indexes');
  // "users" already reported as existing -> only the transactions table + its two indexes are missing.
  assert.equal(updateSchemaCalledWith.length, 3);
  assert.ok(updateSchemaCalledWith.every((stmt) => !/CREATE TABLE users/i.test(stmt)));
  assert.ok(operationAwaited, 'expected the schema-update operation to be awaited to completion');
});

test('createSchemaIfNeeded: does nothing when every table already exists', async () => {
  let updateSchemaCalled = false;
  const fakeDatabase = {
    run: async () => [[{ toJSON: () => ({ table_name: 'users' }) }, { toJSON: () => ({ table_name: 'transactions' }) }]],
    updateSchema: async () => {
      updateSchemaCalled = true;
      return [{ promise: async () => {} }];
    },
  };

  await createSchemaIfNeeded(fakeDatabase);
  assert.equal(updateSchemaCalled, false);
});

test('insertTransaction: inserts into the transactions table with the full expected row shape', async () => {
  let insertedTable = null;
  let insertedRow = null;
  const fakeDatabase = {
    table: (name) => {
      insertedTable = name;
      return { insert: async (row) => { insertedRow = row; } };
    },
  };

  await insertTransaction(fakeDatabase, {
    transaction_id: 't_1',
    sender_id: 'u_a',
    receiver_id: 'u_b',
    amount: 100,
    timestamp: '2026-07-24T00:00:00.000Z',
    transaction_type: 'transfer',
    fraud_score: 5,
    decision: 'allow',
  });

  assert.equal(insertedTable, 'transactions');
  assert.equal(insertedRow.transaction_id, 't_1');
  assert.equal(insertedRow.sender_id, 'u_a');
  assert.equal(insertedRow.amount, 100);
  assert.equal(insertedRow.decision, 'allow');
  // Optional fields not supplied by the caller must be normalized to null, not left undefined
  // (Spanner's client rejects undefined column values).
  assert.equal(insertedRow.device_id, null);
  assert.equal(insertedRow.merchant_id, null);
});

test('getTransactionsBySender: queries by sender_id with a parameterized, bounded LIMIT', async () => {
  let capturedRequest = null;
  const fakeDatabase = {
    run: async (req) => {
      capturedRequest = req;
      return [[{ toJSON: () => ({ transaction_id: 't_1', sender_id: 'u_a', receiver_id: 'u_b', amount: 100, timestamp: '2026-07-24T00:00:00.000Z', decision: 'allow' }) }]];
    },
  };

  const rows = await getTransactionsBySender(fakeDatabase, 'u_a', 10);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].transaction_id, 't_1');
  assert.match(capturedRequest.sql, /WHERE sender_id = @senderId/);
  assert.match(capturedRequest.sql, /LIMIT @limit/);
  assert.equal(capturedRequest.params.senderId, 'u_a');
  assert.equal(capturedRequest.types.senderId, 'string');
  assert.equal(capturedRequest.types.limit, 'int64');
});
