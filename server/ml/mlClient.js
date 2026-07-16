// PROD: Vertex AI edge-deployed model — DEMO: local inference of scikit-learn-trained
// logistic-regression weights (exported by ml/train_model.py to ml/model_export/model.json),
// run natively in this Node process. Chosen over spawning/managing a live Python sidecar for
// the demo default, since a second process is one more thing that can fail mid-demo — but the
// weights are genuinely trained (see ml/train_model.py), and ml/serve.py exists as a real,
// runnable fallback for ML_SERVING_MODE=python-service. See architecture.md Section 9.
const fs = require('node:fs');
const path = require('node:path');
const extractFeatures = require('./features');

const MODEL_PATH = path.join(__dirname, '..', '..', 'ml', 'model_export', 'model.json');

let cachedModel = null;
function loadModel() {
  if (cachedModel) return cachedModel;
  const raw = fs.readFileSync(MODEL_PATH, 'utf-8');
  cachedModel = JSON.parse(raw);
  return cachedModel;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function scoreLocal(transaction, userHistory) {
  const model = loadModel();
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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ features }),
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
 * @returns {Promise<number>} fraud probability in [0, 1]
 */
async function getFraudProbability(transaction, userHistory) {
  const mode = process.env.ML_SERVING_MODE || 'local';
  try {
    if (mode === 'python-service') return await scoreViaHttpService(transaction, userHistory);
    if (mode === 'vertex') return await scoreViaVertexAi(transaction, userHistory);
    return scoreLocal(transaction, userHistory);
  } catch (err) {
    // Fail open on the ML signal alone — rules and the structuring lookup still apply, and a
    // missing/broken ML backend shouldn't take the whole scoring pipeline down synchronously.
    console.error('ML scoring failed, using neutral probability 0:', err.message);
    return 0;
  }
}

module.exports = { getFraudProbability, scoreLocal };
