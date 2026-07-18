// Continuous Learning Extension, Phase E: pure-JS XGBoost tree-ensemble evaluator
// (server/ml/xgbTreeEval.js). Hand-built trees with known expected outputs -- no dependency on
// Python/a real trained model file, so this stays fast and deterministic. The formula itself
// (leaf-sum + logit(base_score), then sigmoid) was separately verified against Python's
// bst.predict(dmatrix, output_margin=True) for a real trained model before this file was written
// (see ml/train_model_gpu.py's header comment).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreXgboost, sigmoid, logit, parseBaseScore } = require('../server/ml/xgbTreeEval');

function makeModel(trees, baseScore = '[5.0E-1]') {
  return {
    learner: {
      learner_model_param: { base_score: baseScore },
      gradient_booster: { model: { trees } },
    },
  };
}

test('sigmoid/logit: are inverses of each other', () => {
  for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    assert.ok(Math.abs(sigmoid(logit(p)) - p) < 1e-9);
  }
});

test('parseBaseScore: strips XGBoost\'s bracketed-string encoding', () => {
  assert.equal(parseBaseScore('[5.7E-1]'), 0.57);
  assert.equal(parseBaseScore('[0.5]'), 0.5);
});

test('scoreXgboost: a single-leaf tree (no splits) with base_score=0.5 returns sigmoid(leaf_value)', () => {
  const tree = { left_children: [-1], right_children: [-1], split_indices: [0], split_conditions: [0], base_weights: [2] };
  const model = makeModel([tree]);
  const prob = scoreXgboost(model, [0]);
  assert.ok(Math.abs(prob - sigmoid(2)) < 1e-9);
});

test('scoreXgboost: a two-tree ensemble matches a hand-computed leaf-walk + logit(base_score) + sigmoid', () => {
  // Tree 1: split on feature[0] < 0.5 -> leaf -1 (left) or leaf 1 (right)
  const tree1 = {
    left_children: [1, -1, -1],
    right_children: [2, -1, -1],
    split_indices: [0, 0, 0],
    split_conditions: [0.5, 0, 0],
    base_weights: [0, -1, 1],
  };
  // Tree 2: split on feature[1] < 1.0 -> leaf -2 (left) or leaf 2 (right)
  const tree2 = {
    left_children: [1, -1, -1],
    right_children: [2, -1, -1],
    split_indices: [1, 0, 0],
    split_conditions: [1.0, 0, 0],
    base_weights: [0, -2, 2],
  };
  const model = makeModel([tree1, tree2], '[5.0E-1]'); // logit(0.5) = 0

  // feature[0]=0.3 (<0.5, tree1 -> left leaf -1), feature[1]=2.0 (>=1.0, tree2 -> right leaf 2)
  const prob = scoreXgboost(model, [0.3, 2.0]);
  const expectedMargin = -1 + 2 + logit(0.5);
  assert.ok(Math.abs(prob - sigmoid(expectedMargin)) < 1e-9);
  assert.ok(Math.abs(prob - 0.7310585786300049) < 1e-9);
});

test('scoreXgboost: a non-neutral base_score shifts every prediction (verifies logit(base_score) is actually applied)', () => {
  const tree = { left_children: [-1], right_children: [-1], split_indices: [0], split_conditions: [0], base_weights: [0] };
  const neutral = scoreXgboost(makeModel([tree], '[5.0E-1]'), [0]);
  const skewed = scoreXgboost(makeModel([tree], '[8.0E-1]'), [0]);
  assert.ok(Math.abs(neutral - 0.5) < 1e-9); // leaf=0, base_score=0.5 -> margin 0 -> prob 0.5
  assert.ok(skewed > neutral); // a higher base_score should skew the prediction upward
});

test('scoreXgboost: right-branch is taken when the feature value equals the split threshold (XGBoost convention: < goes left)', () => {
  const tree = {
    left_children: [1, -1, -1],
    right_children: [2, -1, -1],
    split_indices: [0, 0, 0],
    split_conditions: [1.0, 0, 0],
    base_weights: [0, -5, 5],
  };
  const prob = scoreXgboost(makeModel([tree], '[5.0E-1]'), [1.0]);
  assert.ok(Math.abs(prob - sigmoid(5)) < 1e-9); // value == threshold -> not < threshold -> right leaf
});
