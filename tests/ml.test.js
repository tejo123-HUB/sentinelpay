const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');

const http = require('node:http');
const { getFraudProbability, scoreLocal, _setVertexClientForTests } = require('../server/ml/mlClient');
const { SCHEMA } = require('../server/db');
const { updateBaseline } = require('../server/adaptiveBaseline');

// Continuous Learning Extension: scoreLocal/getFraudProbability now take an optional db, used
// only when the currently-loaded local model happens to be an XGBoost export (server/ml/mlClient.js's
// model_type dispatch) -- passed here so these tests pass regardless of which model is active on
// this machine (the legacy logistic model by default, or a freshly GPU-trained one after
// ml/train_model_gpu.py has been run), rather than assuming one specific model is always loaded.
function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

const cleanTransaction = {
  sender_id: 'u_ml_test_sender',
  receiver_id: 'u_ml_test_receiver',
  amount: 150,
  timestamp: '2026-07-18T13:00:00Z',
  device_id: 'd_known',
};
const cleanHistory = {
  user: { avg_transaction_amount: 160, typical_active_hours: [[8, 22]] },
  recentTransactions: [],
  knownDeviceIds: ['d_known'],
};

const suspiciousTransaction = {
  sender_id: 'u_ml_test_sender',
  receiver_id: 'u_ml_test_receiver_2',
  amount: 9000,
  timestamp: '2026-07-18T03:00:00Z',
  device_id: 'd_unknown',
  location: { lat: 19.076, lng: 72.8777 },
};
const suspiciousHistory = {
  user: { avg_transaction_amount: 200, typical_active_hours: [[8, 22]] },
  recentTransactions: [
    { timestamp: '2026-07-18T02:59:00Z', location: { lat: 16.5062, lng: 80.648 } },
    { timestamp: '2026-07-18T02:58:00Z', location: null },
    { timestamp: '2026-07-18T02:57:30Z', location: null },
    { timestamp: '2026-07-18T02:57:00Z', location: null },
    { timestamp: '2026-07-18T02:56:30Z', location: null },
    { timestamp: '2026-07-18T02:56:00Z', location: null },
  ],
  knownDeviceIds: ['d_known'],
};

test('scoreLocal: returns a probability in [0, 1] for a clean transaction', () => {
  const db = buildTestDb();
  const p = scoreLocal(cleanTransaction, cleanHistory, db);
  assert.ok(p >= 0 && p <= 1, `expected [0,1], got ${p}`);
});

test('scoreLocal: a suspicious multi-signal transaction scores higher than a clean one', () => {
  const db = buildTestDb();
  // Continuous Learning Extension: scoreLocal now dispatches to whichever model is currently
  // loaded (legacy logistic, via extractFeatures' userHistory-based heuristics, or an XGBoost
  // export, via computeFeatureVector's DB-derived entity_baselines z-scores) -- seeding a real
  // baseline history here (mirroring tests/adaptiveRiskEngine.test.js's seeding pattern) is what
  // makes "suspicious" actually read as anomalous under *either* feature space, rather than this
  // test only holding for whichever model happened to be active.
  for (let i = 0; i < 10; i++) {
    updateBaseline(db, cleanTransaction.sender_id, 'amount', 150 + i, '2026-07-18T09:00:00.000Z');
  }

  const clean = scoreLocal(cleanTransaction, cleanHistory, db);
  const suspicious = scoreLocal(suspiciousTransaction, suspiciousHistory, db);
  assert.ok(suspicious > clean, `expected suspicious (${suspicious}) > clean (${clean})`);
});

test('getFraudProbability: resolves to a number in [0, 1] under the default local mode', async () => {
  const db = buildTestDb();
  const p = await getFraudProbability(cleanTransaction, cleanHistory, db);
  assert.equal(typeof p, 'number');
  assert.ok(p >= 0 && p <= 1);
});

test('getFraudProbability: fails open to 0 when ML_SERVING_MODE=vertex is unconfigured (regression: must not attempt a real network call)', async () => {
  const db = buildTestDb();
  const original = process.env.ML_SERVING_MODE;
  process.env.ML_SERVING_MODE = 'vertex';
  delete process.env.VERTEX_AI_PROJECT_ID;
  delete process.env.VERTEX_AI_LOCATION;
  delete process.env.VERTEX_AI_ENDPOINT_ID;
  try {
    const p = await getFraudProbability(cleanTransaction, cleanHistory, db);
    assert.equal(p, 0);
  } finally {
    if (original === undefined) delete process.env.ML_SERVING_MODE;
    else process.env.ML_SERVING_MODE = original;
  }
});

// Google Cloud Vertex AI integration (24 July 2026): scoreViaVertexAi() now makes a real
// PredictionServiceClient.predict() call when configured. No live Vertex AI endpoint is available
// in this test environment, so these tests inject a fake client via mlClient.js's
// _setVertexClientForTests() seam (same reasoning as caseEvidence.js's _setGcsBucketForTests --
// the aiplatform SDK talks gRPC, not fetch, so this project's usual global.fetch monkeypatching
// doesn't reach it).
test('getFraudProbability: ML_SERVING_MODE=vertex genuinely calls PredictionServiceClient.predict with the feature vector', async () => {
  const { helpers } = require('@google-cloud/aiplatform');
  const db = buildTestDb();
  const original = process.env.ML_SERVING_MODE;
  process.env.ML_SERVING_MODE = 'vertex';
  process.env.VERTEX_AI_PROJECT_ID = 'test-project';
  process.env.VERTEX_AI_LOCATION = 'us-central1';
  process.env.VERTEX_AI_ENDPOINT_ID = '1234567890';

  let capturedRequest = null;
  const fakeClient = {
    predict: async (request) => {
      capturedRequest = request;
      return [{ predictions: [helpers.toValue(0.42)] }];
    },
  };
  _setVertexClientForTests(fakeClient, 'us-central1');

  try {
    const p = await getFraudProbability(cleanTransaction, cleanHistory, db);
    assert.equal(p, 0.42);
    assert.equal(capturedRequest.endpoint, 'projects/test-project/locations/us-central1/endpoints/1234567890');
    assert.equal(capturedRequest.instances.length, 1);
    const expectedFeatures = require('../server/ml/features')(cleanTransaction, cleanHistory);
    assert.deepEqual(capturedRequest.instances[0], helpers.toValue(expectedFeatures));
  } finally {
    if (original === undefined) delete process.env.ML_SERVING_MODE;
    else process.env.ML_SERVING_MODE = original;
    delete process.env.VERTEX_AI_PROJECT_ID;
    delete process.env.VERTEX_AI_LOCATION;
    delete process.env.VERTEX_AI_ENDPOINT_ID;
    _setVertexClientForTests(null);
  }
});

test('getFraudProbability: ML_SERVING_MODE=vertex fails open to 0 on an out-of-range predicted probability (regression: must not poison scoring)', async () => {
  const { helpers } = require('@google-cloud/aiplatform');
  const db = buildTestDb();
  const original = process.env.ML_SERVING_MODE;
  process.env.ML_SERVING_MODE = 'vertex';
  process.env.VERTEX_AI_PROJECT_ID = 'test-project';
  process.env.VERTEX_AI_LOCATION = 'us-central1';
  process.env.VERTEX_AI_ENDPOINT_ID = '1234567890';

  const fakeClient = { predict: async () => [{ predictions: [helpers.toValue(42)] }] };
  _setVertexClientForTests(fakeClient, 'us-central1');

  try {
    const p = await getFraudProbability(cleanTransaction, cleanHistory, db);
    assert.equal(p, 0);
  } finally {
    if (original === undefined) delete process.env.ML_SERVING_MODE;
    else process.env.ML_SERVING_MODE = original;
    delete process.env.VERTEX_AI_PROJECT_ID;
    delete process.env.VERTEX_AI_LOCATION;
    delete process.env.VERTEX_AI_ENDPOINT_ID;
    _setVertexClientForTests(null);
  }
});

test('getFraudProbability: a hung python-service backend times out and fails open, instead of hanging (regression)', async () => {
  // Accepts the TCP connection but never writes an HTTP response, simulating a wedged
  // ml/serve.py process — without a fetch timeout this would hang POST /transaction forever.
  const hungServer = net.createServer((socket) => {
    /* deliberately never responds */
    socket.on('error', () => {});
  });
  await new Promise((resolve) => hungServer.listen(0, resolve));
  const port = hungServer.address().port;

  const originalMode = process.env.ML_SERVING_MODE;
  const originalUrl = process.env.ML_SERVICE_URL;
  process.env.ML_SERVING_MODE = 'python-service';
  process.env.ML_SERVICE_URL = `http://127.0.0.1:${port}/predict`;

  try {
    const start = Date.now();
    const p = await getFraudProbability(cleanTransaction, cleanHistory);
    const elapsedMs = Date.now() - start;

    assert.equal(p, 0, 'should fail open to a neutral probability, not hang or throw uncaught');
    assert.ok(elapsedMs < 2000, `expected the timeout to bound the wait, took ${elapsedMs}ms`);
  } finally {
    if (originalMode === undefined) delete process.env.ML_SERVING_MODE;
    else process.env.ML_SERVING_MODE = originalMode;
    if (originalUrl === undefined) delete process.env.ML_SERVICE_URL;
    else process.env.ML_SERVICE_URL = originalUrl;
    hungServer.close();
  }
});

test('getFraudProbability: a malformed python-service probability fails open to 0, not NaN (regression)', async () => {
  // A compromised or misbehaving ml/serve.py returning a non-numeric/out-of-range `probability`
  // must not reach computeFraudScore() as NaN -- Math.max(NaN, FLOOR) is NaN, which would
  // silently defeat every Critical/structuring/blacklist floor for every future transaction.
  const badServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ probability: 'high' }));
  });
  await new Promise((resolve) => badServer.listen(0, resolve));
  const port = badServer.address().port;

  const originalMode = process.env.ML_SERVING_MODE;
  const originalUrl = process.env.ML_SERVICE_URL;
  process.env.ML_SERVING_MODE = 'python-service';
  process.env.ML_SERVICE_URL = `http://127.0.0.1:${port}/predict`;

  try {
    const p = await getFraudProbability(cleanTransaction, cleanHistory);
    assert.equal(p, 0, 'a malformed probability should fail open to neutral 0, not propagate as NaN');
  } finally {
    if (originalMode === undefined) delete process.env.ML_SERVING_MODE;
    else process.env.ML_SERVING_MODE = originalMode;
    if (originalUrl === undefined) delete process.env.ML_SERVICE_URL;
    else process.env.ML_SERVICE_URL = originalUrl;
    badServer.close();
  }
});
