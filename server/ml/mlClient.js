// Demo default (ML_SERVING_MODE=local): local inference of scikit-learn-trained logistic-
// regression weights (exported by ml/train_model.py to ml/model_export/model.json), run natively
// in this Node process. Chosen over spawning/managing a live Python sidecar for the demo default,
// since a second process is one more thing that can fail mid-demo — but the weights are
// genuinely trained (see ml/train_model.py), and ml/serve.py exists as a real, runnable fallback
// for ML_SERVING_MODE=python-service.
//
// ML_SERVING_MODE=vertex (24 July 2026): a real, working Vertex AI online-prediction call, not a
// documented stand-in — see scoreViaVertexAi() below and architecture.md Section 9's Google Cloud
// integration note. Requires a model already deployed to a Vertex AI Endpoint (out of scope for
// this repo to provision).
const fs = require('node:fs');
const path = require('node:path');
const extractFeatures = require('./features');
const { scoreXgboost } = require('./xgbTreeEval');
const { computeFeatureVector } = require('../featureStore');

const MODEL_DIR = path.join(__dirname, '..', '..', 'ml', 'model_export');
const LEGACY_MODEL_PATH = path.join(MODEL_DIR, 'model.json');
// Continuous Learning Extension, Phase E: ml/train_model_gpu.py writes each new model to a
// versioned model_v<timestamp>.json and updates this small pointer file -- checking it (a tiny
// file) on every call, rather than only at process start, is what makes a hot model swap work
// without a server restart.
const CURRENT_POINTER_PATH = path.join(MODEL_DIR, 'current.json');
const ML_SERVICE_TIMEOUT_MS = 100; // budget for the python-service fallback call, well inside the <150ms end-to-end target

function resolveModelPath() {
  try {
    const pointer = JSON.parse(fs.readFileSync(CURRENT_POINTER_PATH, 'utf-8'));
    if (pointer && pointer.model_file) {
      return path.join(MODEL_DIR, pointer.model_file);
    }
  } catch {
    // No pointer yet (never trained a GPU model on this machine), or it's unreadable -- fall
    // back to the original static model.json path, same behavior as before this Continuous
    // Learning Extension existed.
  }
  return LEGACY_MODEL_PATH;
}

let cachedModel = null;
let cachedModelPath = null;
function loadModel() {
  const modelPath = resolveModelPath();
  if (cachedModel && cachedModelPath === modelPath) return cachedModel;
  const raw = fs.readFileSync(modelPath, 'utf-8');
  const model = JSON.parse(raw);
  if (model.model_type !== 'xgboost') {
    // extractFeatures()'s output order is only correct if it matches what this model was
    // actually trained on. Previously enforced by a comment alone (ml/train_model.py's
    // FEATURE_NAMES vs. server/ml/features.js's extraction order) -- checked here against the
    // model's own exported feature_names so a drift fails loudly at load time instead of
    // silently scoring against the wrong feature slots.
    const expected = extractFeatures.FEATURE_NAMES;
    const actual = model.feature_names;
    const matches = Array.isArray(actual) && actual.length === expected.length && actual.every((name, i) => name === expected[i]);
    if (!matches) {
      throw new Error(
        `${modelPath} feature_names ${JSON.stringify(actual)} do not match server/ml/features.js's ` +
        `FEATURE_NAMES ${JSON.stringify(expected)} -- legacy model scoring would silently use the wrong feature order`
      );
    }
  }
  cachedModel = model;
  cachedModelPath = modelPath;
  return cachedModel;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// Continuous Learning Extension, Phase E: model.json now comes in two shapes -- the original
// hand-exported logistic-regression weights (ml/train_model.py, no model_type field, scored by
// the standardize+dot-product+sigmoid math below), and ml/train_model_gpu.py's XGBoost export
// (model_type: "xgboost", scored by server/ml/xgbTreeEval.js). Dispatching on model_type keeps
// both formats readable by the same loadModel()/current.json machinery rather than needing two
// separate client paths.
//
// `db` is only required for the xgboost path -- computeFeatureVector needs live DB access to
// read entity_baselines/reputation (server/featureStore.js), unlike the legacy path's
// extractFeatures, which only needs the userHistory object the caller already assembled. Not
// threaded through scoreViaHttpService below: ML_SERVING_MODE=python-service's ml/serve.py only
// implements the legacy logistic scoring today, a known scope boundary, not an oversight.
function scoreLocal(transaction, userHistory, db) {
  const model = loadModel();

  if (model.model_type === 'xgboost') {
    if (!db) throw new Error('xgboost model scoring requires db access to compute the feature vector');
    const featureVector = computeFeatureVector(db, transaction);
    const orderedFeatures = model.learner.feature_names.map((name) => featureVector[name] ?? 0);
    return scoreXgboost(model, orderedFeatures);
  }

  const features = extractFeatures(transaction, userHistory);
  const z = features.reduce((sum, x, i) => {
    const standardized = (x - model.scaler_mean[i]) / model.scaler_scale[i];
    return sum + standardized * model.coefficients[i];
  }, model.intercept);

  return sigmoid(z);
}

async function scoreViaHttpService(transaction, userHistory) {
  const url = process.env.ML_SERVICE_URL || 'http://127.0.0.1:8000/predict';
  const features = extractFeatures(transaction, userHistory);

  // Without a timeout, a hung/unreachable-but-not-yet-refused ml/serve.py could block
  // POST /transaction indefinitely — this is a real (documented) fallback mode, not dead code,
  // so it needs the same real-time guarantee the rest of the pipeline has.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ features }),
    signal: AbortSignal.timeout(ML_SERVICE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ML service responded with status ${res.status}`);
  const data = await res.json();
  // A malformed/hostile response (non-numeric, NaN, out-of-range `probability`) must not reach
  // computeFraudScore(), which uses Math.max/Math.min to blend and floor the score -- any NaN
  // input there poisons the whole result (Math.max(NaN, ...) is NaN), silently defeating the
  // Critical/structuring/blacklist floors on every future transaction. Fail closed to the same
  // neutral-0 fallback the outer catch already uses for other ML errors.
  if (typeof data.probability !== 'number' || !Number.isFinite(data.probability) || data.probability < 0 || data.probability > 1) {
    throw new Error(`ML service returned an invalid probability: ${JSON.stringify(data.probability)}`);
  }
  return data.probability;
}

const VERTEX_AI_TIMEOUT_MS = 3000;

// Lazily required (not at top of file) for two reasons: the common ML_SERVING_MODE=local path
// shouldn't pay the cold-start cost of loading this SDK's gRPC/protobuf dependency tree, and it
// makes the client constructor mockable from tests without requiring real GCP credentials at
// module-load time.
let cachedVertexClient = null;
let cachedVertexClientLocation = null;
function getVertexClient(location) {
  if (cachedVertexClient && cachedVertexClientLocation === location) return cachedVertexClient;
  const { PredictionServiceClient } = require('@google-cloud/aiplatform').v1;
  // Vertex AI's regional REST/gRPC surface requires the client to target that region's endpoint
  // host explicitly -- the default (global) host will not resolve a regional Endpoint resource.
  cachedVertexClient = new PredictionServiceClient({ apiEndpoint: `${location}-aiplatform.googleapis.com` });
  cachedVertexClientLocation = location;
  return cachedVertexClient;
}

// Test-only seam, same reasoning as caseEvidence.js's _setGcsBucketForTests: the aiplatform SDK
// talks gRPC, not fetch, so global.fetch monkeypatching (this project's usual approach) doesn't
// reach it -- an explicit injection point stands in for a real client in tests.
function _setVertexClientForTests(client, location = null) {
  cachedVertexClient = client;
  cachedVertexClientLocation = location;
}

/**
 * PROD/current: a real, working Vertex AI online-prediction call -- not a documented stand-in.
 * Requires a model already deployed to a Vertex AI Endpoint (out of scope for this repo to
 * provision) and authenticates via standard GOOGLE_APPLICATION_CREDENTIALS Application Default
 * Credentials, same convention as the Cloud Storage integration in server/caseEvidence.js. Fails
 * fast with a clear config error (no network attempt) when the required env vars are missing --
 * getFraudProbability()'s outer catch turns that into the same neutral-0 fail-open fallback as
 * every other ML backend error, so an unconfigured `vertex` mode behaves exactly as it did before
 * this integration existed (see tests/ml.test.js's "fails open to 0" regression test).
 *
 * Feature contract: instances are the same ordered feature vector extractFeatures() produces
 * elsewhere in this file (see ml/train_model.py's FEATURE_NAMES), sent as a single flat array of
 * numbers per instance; the deployed model is expected to return one scalar fraud-probability
 * value per instance in `predictions`.
 * @param {object} transaction
 * @param {object} userHistory
 * @returns {Promise<number>}
 */
async function scoreViaVertexAi(transaction, userHistory) {
  const projectId = process.env.VERTEX_AI_PROJECT_ID;
  const location = process.env.VERTEX_AI_LOCATION;
  const endpointId = process.env.VERTEX_AI_ENDPOINT_ID;
  if (!projectId || !location || !endpointId) {
    throw new Error(
      'Vertex AI serving mode requires VERTEX_AI_PROJECT_ID, VERTEX_AI_LOCATION, and VERTEX_AI_ENDPOINT_ID to be set'
    );
  }

  const { helpers } = require('@google-cloud/aiplatform');
  const client = getVertexClient(location);
  const endpoint = `projects/${projectId}/locations/${location}/endpoints/${endpointId}`;
  const features = extractFeatures(transaction, userHistory);
  const instance = helpers.toValue(features);

  const [response] = await client.predict(
    { endpoint, instances: [instance] },
    { timeout: VERTEX_AI_TIMEOUT_MS }
  );

  const predictions = response.predictions || [];
  if (predictions.length === 0) throw new Error('Vertex AI returned no predictions');
  // helpers.fromValue() only decodes struct-shaped (object) protobuf Values, not scalars -- our
  // documented contract is a single scalar numberValue per instance, so read it directly; if a
  // model instead returns an object (e.g. { probability: 0.42 }), fall back to decoding that.
  const raw = predictions[0];
  const probability = typeof raw.numberValue === 'number' ? raw.numberValue : helpers.fromValue(raw)?.probability;

  // Same "never let a malformed/hostile response poison computeFraudScore()'s Math.max/Math.min
  // blend" reasoning as scoreViaHttpService above.
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(`Vertex AI returned an invalid probability: ${JSON.stringify(probability)}`);
  }
  return probability;
}

/**
 * @param {object} transaction
 * @param {object} userHistory
 * @param {import('node:sqlite').DatabaseSync} [db] - only required when the currently-loaded
 *   local model is an XGBoost export (model_type: "xgboost"); unused by the legacy logistic path
 *   and by python-service/vertex modes.
 * @returns {Promise<number>} fraud probability in [0, 1]
 */
async function getFraudProbability(transaction, userHistory, db) {
  const mode = process.env.ML_SERVING_MODE || 'local';
  try {
    if (mode === 'python-service') return await scoreViaHttpService(transaction, userHistory);
    if (mode === 'vertex') return await scoreViaVertexAi(transaction, userHistory);
    return scoreLocal(transaction, userHistory, db);
  } catch (err) {
    // Fail open on the ML signal alone — rules and the structuring lookup still apply, and a
    // missing/broken ML backend shouldn't take the whole scoring pipeline down synchronously.
    console.error('ML scoring failed, using neutral probability 0:', err.message);
    return 0;
  }
}

module.exports = { getFraudProbability, scoreLocal, _setVertexClientForTests };
