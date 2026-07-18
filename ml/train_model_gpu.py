"""Continuous Learning Extension, Phase D: trains a GPU-accelerated XGBoost fraud classifier on
the combined (app data + external dataset) matrix from ml/load_datasets.py, and exports it as
XGBoost's native JSON format (no pickle/joblib -- same version-lock-avoidance reasoning
ml/train_model.py's header comment already gives) for server/ml/xgbTreeEval.js to evaluate.

Why XGBoost over a hand-rolled PyTorch net: gradient-boosted trees are the standard choice for
tabular fraud data at this scale, GPU acceleration is a real, meaningful workload once trained on
a real dataset (not architectural theater the way GPU-training a tiny logistic regression would
be), and it fits naturally with incremental/online updates (xgb_model= warm-start, used by
ml/retrain.py) without redesigning the serving path around a neural net.

GPU is REQUIRED, not preferred: this script hard-fails at startup if CUDA training doesn't work,
rather than silently falling back to CPU. Verified numerically (see the leaf-walk vs.
bst.predict(output_margin=True) check this repo's implementation was validated against) that
XGBoost's native JSON export can be faithfully re-evaluated in pure JS: for row x,
    margin = sum(leaf_value_for(tree, x) for tree in trees) + logit(base_score)
    probability = sigmoid(margin)
server/ml/xgbTreeEval.js implements exactly this.

Usage:
    ml/.venv/Scripts/python.exe ml/train_model_gpu.py [--db-path PATH] [--external-dataset CSV]
        [--min-real-rows N] [--synthetic-rows N]
Exports to ml/model_export/model_v<timestamp>.json and updates ml/model_export/current.json to
point at it (server/ml/mlClient.js reads current.json, so a new model is picked up without a
server restart).
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xgboost as xgb
from sklearn.metrics import accuracy_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split

from load_datasets import CANONICAL_FEATURE_NAMES, build_training_matrix

RANDOM_SEED = 42
DEFAULT_MIN_REAL_ROWS = 200  # below this many real (app + external) rows, synthetic augmentation kicks in
DEFAULT_SYNTHETIC_ROWS = 5000


def assert_gpu_available():
    """Hard-fails (not a silent CPU fallback) if XGBoost can't actually train on the GPU here --
    the user's explicit "strictly GPU only" requirement. A tiny real fit, not just an import
    check: importing xgboost succeeds even with no GPU driver at all, only training exercises
    the CUDA path.
    """
    try:
        X = np.random.default_rng(0).random((32, 2))
        y = (X[:, 0] > 0.5).astype(int)
        dtrain = xgb.DMatrix(X, label=y)
        xgb.train({"tree_method": "hist", "device": "cuda", "objective": "binary:logistic"}, dtrain, num_boost_round=1)
    except Exception as exc:  # noqa: BLE001 -- deliberately broad: any failure here means "no usable GPU"
        print(
            "GPU training is required but unavailable on this machine "
            f"(xgboost device='cuda' training failed: {exc}). Refusing to silently fall back to CPU.",
            file=sys.stderr,
        )
        sys.exit(1)


def map_synthetic_row(features_6, label):
    """Maps one row of ml/train_model.py's existing synthetic generator (6-feature space:
    velocity_count_60s, amount_to_avg_ratio, travel_speed_kmh, is_new_device, is_odd_hour, amount)
    into the canonical feature space, as a cold-start augmentation source when there isn't yet
    enough real (app + external) data to train on meaningfully -- same honest-approximation
    reasoning as load_datasets.map_paysim_row, not a fabrication of values this generator can't
    actually provide (e.g. no real device/merchant/ip history exists for a synthetic row either).
    """
    velocity_count_60s, amount_to_avg_ratio, _travel_speed_kmh, is_new_device, _is_odd_hour, amount = features_6
    return {
        "amount": float(amount),
        # amount_to_avg_ratio=1 means "exactly average" -- centering it gives a rough z-like
        # signal without claiming a specific standard deviation this generator never modeled.
        "user_amount_z": float((amount_to_avg_ratio - 1.0) * 3.0),
        "user_history_count": 10.0,  # an established (not brand-new) account, consistent with this generator's premise
        "pair_amount_z": 0.0,
        "pair_refund_history_count": 0.0,
        "device_history_count": 0.0 if is_new_device else 10.0,
        "merchant_history_count": 10.0,
        "ip_history_count": float(min(velocity_count_60s, 10)),
        "reputation_score": 50.0,
        "graph_cluster_risk": 0.0,
        "is_external_source": 1.0,  # not the app's own history, same provenance flag external rows get
    }


def synthetic_augmentation(n_rows):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from train_model import generate_dataset  # reuses the existing, already-reviewed generator

    X6, y = generate_dataset(n=n_rows)
    X = np.array([[map_synthetic_row(row, label)[name] for name in CANONICAL_FEATURE_NAMES] for row, label in zip(X6, y)])
    return X, y


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-path", default=None)
    parser.add_argument("--external-dataset", default=None)
    parser.add_argument("--min-real-rows", type=int, default=DEFAULT_MIN_REAL_ROWS)
    parser.add_argument("--synthetic-rows", type=int, default=DEFAULT_SYNTHETIC_ROWS)
    args = parser.parse_args()

    assert_gpu_available()

    real_X, real_y = build_training_matrix(args.db_path, args.external_dataset)
    sources = {"app_and_external_rows": int(len(real_y))}

    if len(real_y) < args.min_real_rows:
        print(
            f"[train_model_gpu] only {len(real_y)} real (app + external) rows available "
            f"(below --min-real-rows {args.min_real_rows}) -- augmenting with "
            f"{args.synthetic_rows} synthetic rows so training is still meaningful. "
            "This run is NOT a full real-dataset run; re-run once more analyst decisions "
            "and/or an external dataset are available."
        )
        synth_X, synth_y = synthetic_augmentation(args.synthetic_rows)
        X = np.vstack([real_X, synth_X]) if len(real_y) else synth_X
        y = np.concatenate([real_y, synth_y]) if len(real_y) else synth_y
        sources["synthetic_rows"] = int(len(synth_y))
    else:
        X, y = real_X, real_y
        sources["synthetic_rows"] = 0

    print(f"Training on {len(y)} rows (sources: {sources}), fraud rate={y.mean():.3%}")

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=RANDOM_SEED, stratify=y if len(np.unique(y)) > 1 else None
    )

    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=CANONICAL_FEATURE_NAMES)
    dtest = xgb.DMatrix(X_test, label=y_test, feature_names=CANONICAL_FEATURE_NAMES)

    params = {
        "tree_method": "hist",
        "device": "cuda",
        "objective": "binary:logistic",
        "max_depth": 4,
        "eta": 0.1,
        "eval_metric": "auc",
    }
    booster = xgb.train(params, dtrain, num_boost_round=100, evals=[(dtest, "test")], verbose_eval=False)

    y_prob = booster.predict(dtest)
    y_pred = (y_prob >= 0.5).astype(int)
    print("Evaluation on held-out test set:")
    print(f"  accuracy:  {accuracy_score(y_test, y_pred):.4f}")
    print(f"  precision: {precision_score(y_test, y_pred, zero_division=0):.4f}")
    print(f"  recall:    {recall_score(y_test, y_pred, zero_division=0):.4f}")
    test_auc = roc_auc_score(y_test, y_prob) if len(np.unique(y_test)) > 1 else float("nan")
    print(f"  roc_auc:   {test_auc:.4f}")

    export_dir = Path(__file__).parent / "model_export"
    export_dir.mkdir(exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    versioned_path = export_dir / f"model_v{timestamp}.json"

    booster.save_model(str(versioned_path))
    with open(versioned_path) as f:
        model_json = json.load(f)
    # Augment XGBoost's own native export (top-level keys "learner"/"version") with the same
    # metadata fields ml/train_model.py's logistic export carries, plus model_type so
    # server/ml/mlClient.js knows which evaluator (native logistic math vs. xgbTreeEval.js) to
    # dispatch to.
    model_json["model_type"] = "xgboost"
    model_json["trained_at"] = datetime.now(timezone.utc).isoformat()
    model_json["n_samples"] = int(len(y))
    model_json["test_auc"] = None if np.isnan(test_auc) else float(test_auc)
    model_json["data_sources"] = sources
    with open(versioned_path, "w") as f:
        json.dump(model_json, f, indent=2)

    current_pointer = export_dir / "current.json"
    current_pointer.write_text(json.dumps({"model_file": versioned_path.name}, indent=2))

    print(f"Exported model to {versioned_path}")
    print(f"Updated {current_pointer} to point at it")


if __name__ == "__main__":
    main()
