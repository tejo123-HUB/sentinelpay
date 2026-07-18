"""Continuous Learning Extension, Phase F: the actual online-learning retraining loop --
continues training the currently-live model from new feedback_labels rows (real analyst
decisions: server/feedbackLabels.js) via XGBoost's native incremental boosting, rather than a
full retrain from scratch every time. This is the specific capability architecture.md's FA196/
FA197 ("Adaptive Rule Learning"/"Auto Threshold Learning") and FA057/FA059/FA064 (adaptive/
behavioral/predictive scoring) were declined for lacking -- "a real online-learning retraining
loop... statistical model updates, not declarative rule matching."

Invoked manually or via cron/scheduled task, matching this project's existing manual-script
convention (npm run seed/simulate) -- no new daemon process, no CI changes.

GPU is required, same "strictly GPU only" hard-fail as ml/train_model_gpu.py.

Usage:
    ml/.venv/Scripts/python.exe ml/retrain.py [--db-path PATH] [--external-dataset CSV]
        [--min-new-rows N]
Exports a new versioned model (model_v<timestamp>.json) warm-started from the current model, and
updates current.json to point at it -- same hot-swap mechanism train_model_gpu.py uses.
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
from train_model_gpu import assert_gpu_available

RANDOM_SEED = 42
DEFAULT_MIN_NEW_ROWS = 20  # below this many labeled rows, a warm-start round isn't worth the noise


def _model_export_dir():
    return Path(__file__).parent / "model_export"


def load_current_booster():
    """Loads the currently-live model (via current.json's pointer, falling back to the shipped
    model.json) as an xgb.Booster to warm-start from. Returns None if the current model isn't an
    XGBoost export yet (e.g. this machine has never run train_model_gpu.py) -- retrain.py then
    falls back to a fresh (non-warm-started) fit, which is still a real training run, just not
    an incremental one.
    """
    export_dir = _model_export_dir()
    pointer_path = export_dir / "current.json"
    if pointer_path.exists():
        model_path = export_dir / json.loads(pointer_path.read_text())["model_file"]
    else:
        model_path = export_dir / "model.json"

    if not model_path.exists():
        return None

    with open(model_path) as f:
        model_json = json.load(f)
    if model_json.get("model_type") != "xgboost":
        print(f"[retrain] current model at {model_path} is not an XGBoost export (no prior GPU-trained model yet) -- fitting fresh instead of warm-starting")
        return None

    booster = xgb.Booster()
    booster.load_model(str(model_path))
    return booster


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-path", default=None)
    parser.add_argument("--external-dataset", default=None)
    parser.add_argument("--min-new-rows", type=int, default=DEFAULT_MIN_NEW_ROWS)
    args = parser.parse_args()

    assert_gpu_available()

    X, y = build_training_matrix(args.db_path, args.external_dataset)
    if len(y) < args.min_new_rows:
        print(
            f"[retrain] only {len(y)} labeled rows available (below --min-new-rows {args.min_new_rows}) -- "
            "not enough new analyst decisions yet to retrain meaningfully. Nothing done."
        )
        return

    print(f"[retrain] retraining on {len(y)} labeled rows, fraud rate={y.mean():.3%}")

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=RANDOM_SEED, stratify=y if len(np.unique(y)) > 1 else None
    )
    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=CANONICAL_FEATURE_NAMES)
    dtest = xgb.DMatrix(X_test, label=y_test, feature_names=CANONICAL_FEATURE_NAMES)

    previous_booster = load_current_booster()
    params = {
        "tree_method": "hist",
        "device": "cuda",
        "objective": "binary:logistic",
        "max_depth": 4,
        "eta": 0.1,
        "eval_metric": "auc",
    }
    # xgb_model=previous_booster is the actual online-learning step: additional boosting rounds
    # appended on top of the existing trees, not a from-scratch refit -- what makes this a
    # genuine incremental retraining loop rather than train_model_gpu.py run again.
    booster = xgb.train(
        params, dtrain, num_boost_round=20, evals=[(dtest, "test")], verbose_eval=False, xgb_model=previous_booster
    )

    y_prob = booster.predict(dtest)
    y_pred = (y_prob >= 0.5).astype(int)
    test_auc = roc_auc_score(y_test, y_prob) if len(np.unique(y_test)) > 1 else float("nan")
    print("Evaluation on held-out test set:")
    print(f"  accuracy:  {accuracy_score(y_test, y_pred):.4f}")
    print(f"  precision: {precision_score(y_test, y_pred, zero_division=0):.4f}")
    print(f"  recall:    {recall_score(y_test, y_pred, zero_division=0):.4f}")
    print(f"  roc_auc:   {test_auc:.4f}")

    export_dir = _model_export_dir()
    export_dir.mkdir(exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    versioned_path = export_dir / f"model_v{timestamp}.json"

    booster.save_model(str(versioned_path))
    with open(versioned_path) as f:
        model_json = json.load(f)
    model_json["model_type"] = "xgboost"
    model_json["trained_at"] = datetime.now(timezone.utc).isoformat()
    model_json["n_samples"] = int(len(y))
    model_json["test_auc"] = None if np.isnan(test_auc) else float(test_auc)
    model_json["warm_started"] = previous_booster is not None
    with open(versioned_path, "w") as f:
        json.dump(model_json, f, indent=2)

    (export_dir / "current.json").write_text(json.dumps({"model_file": versioned_path.name}, indent=2))
    print(f"Exported retrained model to {versioned_path} (warm_started={previous_booster is not None})")


if __name__ == "__main__":
    main()
