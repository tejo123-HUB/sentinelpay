// Continuous Learning Extension, Phase E: pure-JS evaluator for an XGBoost binary:logistic
// model's native JSON export (ml/train_model_gpu.py's booster.save_model(".json") output, with a
// few metadata fields appended). Walks each tree's split/leaf structure and sums leaf values,
// mirroring what xgboost's own Booster.predict() does -- verified numerically against Python's
// bst.predict(dmatrix, output_margin=True) for a known model before this file was written:
//   margin = sum(leaf_value_for(tree, x) for every tree) + logit(base_score)
//   probability = sigmoid(margin)
// where base_score is learner.learner_model_param.base_score (a probability-space value XGBoost
// stores as a bracketed string, e.g. "[5.7E-1]") and logit(p) = ln(p / (1 - p)).
//
// Deliberately does not handle missing/NaN feature values (this app's feature vectors --
// server/featureStore.js's computeFeatureVector -- are always fully computed numbers, never
// missing) or multi-class output (this model is always binary:logistic) -- scope matched to what
// this app actually produces, not a general-purpose XGBoost runtime.
//
// PROD: Vertex AI's own model server evaluating the real booster artifact -- DEMO: this file,
// so ML_SERVING_MODE=local stays the primary, most-reliable serving path (no second process to
// keep alive mid-demo) the same way it already was for the logistic model.

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function logit(p) {
  return Math.log(p / (1 - p));
}

function walkTree(tree, features) {
  let node = 0;
  while (tree.left_children[node] !== -1) {
    const featureIndex = tree.split_indices[node];
    const threshold = tree.split_conditions[node];
    const value = features[featureIndex];
    node = value < threshold ? tree.left_children[node] : tree.right_children[node];
  }
  return tree.base_weights[node];
}

function parseBaseScore(baseScoreField) {
  // XGBoost's JSON export stores this as a bracketed string, e.g. "[5.7E-1]" -- not a bare number.
  return parseFloat(String(baseScoreField).replace(/[[\]]/g, ''));
}

/**
 * @param {object} xgboostModelJson - the object produced by XGBoost's Booster.save_model(".json"),
 *   as loaded from ml/model_export/*.json (top-level `learner`/`version` keys, XGBoost's own
 *   native format -- see ml/train_model_gpu.py)
 * @param {number[]} features - feature vector, ordered to match xgboostModelJson.learner.feature_names
 * @returns {number} fraud probability in [0, 1]
 */
function scoreXgboost(xgboostModelJson, features) {
  const learner = xgboostModelJson.learner;
  const baseScore = parseBaseScore(learner.learner_model_param.base_score);
  const trees = learner.gradient_booster.model.trees;

  const leafSum = trees.reduce((sum, tree) => sum + walkTree(tree, features), 0);
  const margin = leafSum + logit(baseScore);
  return sigmoid(margin);
}

module.exports = { scoreXgboost, sigmoid, logit, parseBaseScore };
