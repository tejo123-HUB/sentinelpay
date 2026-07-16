"""Trains a lightweight logistic-regression fraud classifier on synthetic behavioral
features that mirror the same signals SentinelPay's rule engine computes (velocity,
amount deviation, travel speed, device familiarity, odd-hour activity, raw amount).

Why synthetic data instead of the raw Kaggle "Credit Card Fraud Detection" dataset (the
default suggested in architecture.md Section 10, Task 8): that dataset's features
(V1-V28) are PCA components of undisclosed raw fields, so they carry no interpretable
meaning and don't correspond to any signal this API actually has access to at scoring
time (sender/receiver identity, amount, location, device, timestamp). Training on our
own behavioral feature space instead means the ML layer complements the rule engine by
learning nonlinear interactions between the same signals, rather than operating on a
disconnected feature space it can't explain. Documented as a deliberate deviation in
architecture.md Section 9.

Usage:
    python ml/train_model.py
Exports trained weights to ml/model_export/model.json (loaded natively by
server/ml/mlClient.js for local inference — no pickle/joblib version-lock risk between
train and serve).
"""
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

RANDOM_SEED = 42
N_SAMPLES = 20000

# Order here must exactly match server/ml/features.js's extractFeatures() output order.
FEATURE_NAMES = [
    "velocity_count_60s",
    "amount_to_avg_ratio",
    "travel_speed_kmh",
    "is_new_device",
    "is_odd_hour",
    "amount",
]


def generate_dataset(n=N_SAMPLES, seed=RANDOM_SEED):
    """Synthesizes transactions as a mixture of ordinary behavior and injected fraud
    patterns, mirroring the worked examples in user-manual.md: most rows look routine;
    a minority get 1-3 simultaneously spiked signals (velocity+impossible-travel+new-device,
    or a lone sharp amount anomaly, etc.), and the fraud label follows the injected pattern
    with high but not certain probability — some anomalies are still legitimate, and a small
    baseline fraud rate exists even among normal-looking rows (fraud with no behavioral tell).
    """
    rng = np.random.default_rng(seed)

    velocity_count_60s = rng.poisson(0.4, size=n).astype(float)
    amount_to_avg_ratio = rng.lognormal(mean=0.0, sigma=0.4, size=n)
    travel_speed_kmh = np.abs(rng.normal(loc=15, scale=20, size=n))
    is_new_device = rng.binomial(1, 0.04, size=n).astype(float)
    is_odd_hour = rng.binomial(1, 0.08, size=n).astype(float)
    amount = rng.lognormal(mean=5.0, sigma=0.8, size=n)

    is_anomalous = rng.binomial(1, 0.05, size=n).astype(bool)
    anomalous_idx = np.where(is_anomalous)[0]
    signal_pool = np.array(["velocity", "travel", "amount", "device", "hour"])

    for i in anomalous_idx:
        n_signals = rng.integers(1, 4)  # 1-3 signals spike together per anomalous transaction
        signals = rng.choice(signal_pool, size=n_signals, replace=False)
        if "velocity" in signals:
            velocity_count_60s[i] = rng.integers(5, 12)
        if "travel" in signals:
            travel_speed_kmh[i] = rng.uniform(950, 2500)
        if "amount" in signals:
            amount_to_avg_ratio[i] = rng.uniform(3.5, 15)
            amount[i] = amount[i] * amount_to_avg_ratio[i]
        if "device" in signals:
            is_new_device[i] = 1.0
        if "hour" in signals:
            is_odd_hour[i] = 1.0

    X = np.column_stack(
        [velocity_count_60s, amount_to_avg_ratio, travel_speed_kmh, is_new_device, is_odd_hour, amount]
    )

    fraud_prob = np.where(is_anomalous, 0.85, 0.01)
    y = rng.binomial(1, fraud_prob)

    return X, y


def main():
    X, y = generate_dataset()
    print(f"Generated {len(y)} synthetic transactions, fraud rate={y.mean():.3%}")

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=RANDOM_SEED, stratify=y
    )

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    model = LogisticRegression(class_weight="balanced", max_iter=1000, random_state=RANDOM_SEED)
    model.fit(X_train_scaled, y_train)

    y_pred = model.predict(X_test_scaled)
    y_prob = model.predict_proba(X_test_scaled)[:, 1]

    print("Evaluation on held-out test set:")
    print(f"  accuracy:  {accuracy_score(y_test, y_pred):.4f}")
    print(f"  precision: {precision_score(y_test, y_pred):.4f}")
    print(f"  recall:    {recall_score(y_test, y_pred):.4f}")
    print(f"  roc_auc:   {roc_auc_score(y_test, y_prob):.4f}")

    export = {
        "feature_names": FEATURE_NAMES,
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "coefficients": model.coef_[0].tolist(),
        "intercept": float(model.intercept_[0]),
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_samples": N_SAMPLES,
        "test_auc": float(roc_auc_score(y_test, y_prob)),
    }

    out_path = Path(__file__).parent / "model_export" / "model.json"
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(export, indent=2))
    print(f"Exported model to {out_path}")


if __name__ == "__main__":
    main()
