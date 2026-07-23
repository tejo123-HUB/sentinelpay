// PROD: Vertex AI edge-deployed model — DEMO: local inference of scikit-learn-trained
// logistic-regression weights (exported by ml/train_model.py to ml/model_export/model.json),
// run natively in this Node process. Chosen over spawning/managing a live Python sidecar for
// the demo default, since a second process is one more thing that can fail mid-demo — but the
// weights are genuinely trained (see ml/train_model.py), and ml/serve.py exists as a real,
// runnable fallback for ML_SERVING_MODE=python-service. See architecture.md Section 9.
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
  return data.probability;
}

async function scoreViaVertexAi() {
  // PROD path — not implemented in this demo build (no GCP project provisioned in this
  // environment). Kept as an explicit, honest stub rather than a silent fallback.
  throw new Error('Vertex AI serving mode is not implemented in the demo build');
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

module.exports = { getFraudProbability, scoreLocal };
