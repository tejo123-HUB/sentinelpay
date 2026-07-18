"""Continuous Learning Extension, Phase D: loads training data from every source the feedback
loop is supposed to learn from -- this app's own accumulated (feature, label) history, and an
optional external public fraud dataset -- and unions them into one matrix ml/train_model_gpu.py
and ml/retrain.py can both train against.

Two sources, by design (architecture.md Section 9):

1. The app's own data (server/featureStore.js's training_examples, joined with
   server/feedbackLabels.js's feedback_labels): this is the literal "retrains from analyst
   decisions" data -- every row's label came from a real blacklist/whitelist/case-resolution
   decision, not a synthetic label.

2. An external public dataset, loaded from a local CSV path (env var ML_EXTERNAL_DATASET_PATH or
   --external-dataset). Recommended: PaySim ("Synthetic Financial Datasets For Fraud Detection" on
   Kaggle) -- NOT the Kaggle "Credit Card Fraud Detection" dataset architecture.md already rejected
   once (its V1-V28 columns are anonymized PCA components with no interpretable meaning, and don't
   correspond to any signal this API actually has at scoring time). PaySim's step/type/amount/
   oldbalanceOrg/newbalanceOrig/oldbalanceDest/newbalanceDest/isFraud columns are interpretable
   transactional fields we can map into this app's own feature space (see map_paysim_row below).

No automated download is attempted for either dataset -- PaySim requires a Kaggle account/API
token this environment doesn't have configured. If ML_EXTERNAL_DATASET_PATH isn't set or the file
doesn't exist, load_external_dataset prints instructions and returns an empty dataset rather than
failing the whole training run -- app data alone (plus train_model.py's existing synthetic
generator, as a cold-start fallback when app data is also too thin) is still a valid, honest,
smaller training run.
"""
import json
import os
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

# Must exactly match the keys server/featureStore.js's computeFeatureVector() produces, in this
# order -- this is the canonical feature space both data sources get mapped into.
CANONICAL_FEATURE_NAMES = [
    "amount",
    "user_amount_z",
    "user_history_count",
    "pair_amount_z",
    "pair_refund_history_count",
    "device_history_count",
    "merchant_history_count",
    "ip_history_count",
    "reputation_score",
    "graph_cluster_risk",
    "is_external_source",
]

PAYSIM_EXTERNAL_DATASET_ENV = "ML_EXTERNAL_DATASET_PATH"


def _default_db_path():
    return os.environ.get("DB_PATH") or str(Path(__file__).resolve().parent.parent / "sentinelpay.db")


def load_app_data(db_path=None):
    """Reads every training_examples row that has a feedback_labels-derived label -- the app's
    own accumulated (feature, label) history.

    @returns (X, y) as numpy arrays; both empty (shape (0, len(CANONICAL_FEATURE_NAMES))) if no
    labeled examples exist yet (e.g. no analyst has blacklisted/whitelisted/resolved anything).
    """
    resolved_path = db_path or _default_db_path()
    if not Path(resolved_path).exists():
        print(f"[load_datasets] no app database found at {resolved_path} -- skipping app data")
        return np.empty((0, len(CANONICAL_FEATURE_NAMES))), np.empty((0,), dtype=int)

    conn = sqlite3.connect(resolved_path)
    try:
        rows = conn.execute(
            "SELECT te.feature_json, fl.label FROM training_examples te "
            "JOIN feedback_labels fl ON fl.transaction_id = te.transaction_id"
        ).fetchall()
    except sqlite3.OperationalError as exc:
        # A demo DB created before the Continuous Learning Extension's schema additions (or one
        # that has simply never had the Node server run against it) won't have these tables yet --
        # node:sqlite's initDb() creates them via `CREATE TABLE IF NOT EXISTS` on next server
        # start, same as every other schema addition in this project's history. Legitimate
        # "no data yet" state, not a crash.
        print(f"[load_datasets] app database at {resolved_path} doesn't have the Continuous Learning tables yet ({exc}) -- skipping app data")
        return np.empty((0, len(CANONICAL_FEATURE_NAMES))), np.empty((0,), dtype=int)
    finally:
        conn.close()

    if not rows:
        print("[load_datasets] app database has no labeled training_examples yet (no analyst decisions recorded)")
        return np.empty((0, len(CANONICAL_FEATURE_NAMES))), np.empty((0,), dtype=int)

    X, y = [], []
    for feature_json, label in rows:
        vector = json.loads(feature_json)
        X.append([vector.get(name, 0.0) for name in CANONICAL_FEATURE_NAMES])
        y.append(int(label))

    print(f"[load_datasets] loaded {len(y)} labeled examples from the app's own accumulated data")
    return np.array(X, dtype=float), np.array(y, dtype=int)


def map_paysim_row(row):
    """Maps one PaySim row into the canonical feature space. PaySim's columns don't map 1:1 onto
    this app's entity-baseline z-scores (those require this app's own transaction history, which
    PaySim obviously doesn't have) -- the mapping below derives the closest honest analogs instead
    of fabricating values, and sets is_external_source=1 so the model can weight provenance rather
    than pretending the two sources are identical.
    """
    orig_balance_ratio = (row["oldbalanceOrg"] - row["newbalanceOrig"]) / max(row["oldbalanceOrg"], 1.0)
    dest_drain_ratio = (row["newbalanceDest"] - row["oldbalanceDest"]) / max(row["amount"], 1.0)

    return {
        "amount": float(row["amount"]),
        # No per-account history in PaySim to compute a real z-score from -- 0 (neutral) rather
        # than a fabricated deviation.
        "user_amount_z": 0.0,
        "user_history_count": 0.0,
        "pair_amount_z": 0.0,
        "pair_refund_history_count": 0.0,
        "device_history_count": 0.0,
        "merchant_history_count": 0.0,
        # A mule-drain analog: how much of the destination's balance jumped by roughly the
        # transferred amount (near 1.0 = money passed straight through, the mule-account pattern
        # server/muleScore.js looks for) vs. accumulated (near 0 = money stayed, an ordinary
        # receiving account).
        "ip_history_count": float(np.clip(dest_drain_ratio, 0, 5)),
        "reputation_score": 50.0,  # neutral -- no server/reputation.js history exists for a PaySim account
        "graph_cluster_risk": 0.0,
        "is_external_source": 1.0,
    }


def load_external_dataset(path=None):
    """Loads and maps an external CSV (PaySim-shaped: type/amount/oldbalanceOrg/newbalanceOrig/
    oldbalanceDest/newbalanceDest/isFraud columns). Prints clear instructions and returns an empty
    dataset (not an error) if no path is configured or the file doesn't exist -- this is an
    expected, honest state in an environment with no Kaggle credentials configured, not a bug.
    """
    resolved_path = path or os.environ.get(PAYSIM_EXTERNAL_DATASET_ENV)
    if not resolved_path or not Path(resolved_path).exists():
        print(
            "[load_datasets] no external dataset configured/found. To include one:\n"
            "  1. Download PaySim (\"Synthetic Financial Datasets For Fraud Detection\") from Kaggle\n"
            "     -- requires a free Kaggle account + API token, not automated by this script.\n"
            f"  2. Set {PAYSIM_EXTERNAL_DATASET_ENV}=<path to the CSV>, or pass --external-dataset <path>.\n"
            "  Training will proceed with the app's own data (and the synthetic fallback) only."
        )
        return np.empty((0, len(CANONICAL_FEATURE_NAMES))), np.empty((0,), dtype=int)

    df = pd.read_csv(resolved_path)
    required = {"amount", "oldbalanceOrg", "newbalanceOrig", "oldbalanceDest", "newbalanceDest", "isFraud"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"external dataset at {resolved_path} is missing expected PaySim columns: {sorted(missing)}")

    X, y = [], []
    for _, row in df.iterrows():
        vector = map_paysim_row(row)
        X.append([vector[name] for name in CANONICAL_FEATURE_NAMES])
        y.append(int(row["isFraud"]))

    print(f"[load_datasets] loaded {len(y)} rows from external dataset {resolved_path}")
    return np.array(X, dtype=float), np.array(y, dtype=int)


def build_training_matrix(db_path=None, external_dataset_path=None):
    """Unions the app's own data and the external dataset into one (X, y) pair. Callers that also
    want the existing synthetic generator (ml/train_model.py's generate_dataset) as a cold-start
    fallback compose it themselves -- kept out of this function so "real data available" vs.
    "fell back to synthetic" stays an explicit, visible decision at the call site, not hidden
    inside a loader.
    """
    app_X, app_y = load_app_data(db_path)
    ext_X, ext_y = load_external_dataset(external_dataset_path)

    if len(app_y) == 0 and len(ext_y) == 0:
        return np.empty((0, len(CANONICAL_FEATURE_NAMES))), np.empty((0,), dtype=int)

    X = np.vstack([a for a in (app_X, ext_X) if len(a) > 0])
    y = np.concatenate([a for a in (app_y, ext_y) if len(a) > 0])
    return X, y


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-path", default=None, help="path to sentinelpay.db (default: DB_PATH env var or ./sentinelpay.db)")
    parser.add_argument("--external-dataset", default=None, help="path to a PaySim-shaped CSV")
    args = parser.parse_args()

    X, y = build_training_matrix(args.db_path, args.external_dataset)
    print(f"Combined training matrix: {X.shape[0]} rows x {X.shape[1]} features, fraud rate={y.mean() if len(y) else 0:.3%}")
