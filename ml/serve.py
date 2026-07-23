"""Local inference fallback server for the trained fraud model.

# PROD: Vertex AI edge-deployed endpoint — DEMO: this local HTTP server

Built on Python's standard library (http.server) rather than Flask/FastAPI, since neither
is installed in this environment and pulling them in for a single JSON endpoint isn't
worth the extra dependency for a hackathon demo. server/ml/mlClient.js can call this over
HTTP when ML_SERVING_MODE=python-service, but the demo defaults to running the exact same
trained weights natively inside the Node process (ML_SERVING_MODE=local) to avoid the
operational fragility of managing a second server process during a live demo. This file
exists to make the "local Python inference" fallback genuinely runnable, matching
architecture.md Section 10, Task 8.

Usage:
    python ml/serve.py [--port 8000]
"""
import argparse
import json
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL_DIR = Path(__file__).parent / "model_export"
LEGACY_MODEL_PATH = MODEL_DIR / "model.json"
CURRENT_POINTER_PATH = MODEL_DIR / "current.json"


def resolve_model_path():
    """Mirrors server/ml/mlClient.js's resolveModelPath(): checks current.json for a
    GPU-retrained model before falling back to the original static model.json."""
    try:
        pointer = json.loads(CURRENT_POINTER_PATH.read_text(encoding="utf-8"))
        if pointer.get("model_file"):
            return MODEL_DIR / pointer["model_file"]
    except (OSError, ValueError, KeyError):
        pass
    return LEGACY_MODEL_PATH


def load_model():
    model_path = resolve_model_path()
    with open(model_path, "r", encoding="utf-8") as f:
        model = json.load(f)
    if model.get("model_type") == "xgboost":
        # This fallback's predict() only implements the legacy logistic math (standardize +
        # dot-product + sigmoid). Silently serving the logistic model.json here while
        # ML_SERVING_MODE=local (mlClient.js) is scoring against a newer XGBoost export would be a
        # silent divergence between serving modes -- fail loudly instead, same "no silent
        # fallback" philosophy as this repo's GPU hard-fail and the Vertex AI stub.
        raise SystemExit(
            f"{model_path} is an XGBoost export (model_type=xgboost) -- ml/serve.py's "
            "python-service fallback does not support XGBoost models yet (only the legacy "
            "logistic-regression format). Either run with ML_SERVING_MODE=local (native JS "
            "scoring supports both model types), or point current.json back at a logistic export."
        )
    return model


def sigmoid(z):
    return 1 / (1 + math.exp(-z))


def predict(model, features):
    standardized = [
        (x - mean) / scale
        for x, mean, scale in zip(features, model["scaler_mean"], model["scaler_scale"])
    ]
    z = model["intercept"] + sum(c * x for c, x in zip(model["coefficients"], standardized))
    return sigmoid(z)


class Handler(BaseHTTPRequestHandler):
    model = None

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"status": "ok"})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/predict":
            self._send_json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            features = body["features"]
            if len(features) != len(self.model["feature_names"]):
                raise ValueError(
                    f"expected {len(self.model['feature_names'])} features, got {len(features)}"
                )
            probability = predict(self.model, features)
            self._send_json(200, {"probability": probability})
        except Exception as exc:  # noqa: BLE001 - single JSON error response is fine here
            self._send_json(400, {"error": str(exc)})

    def log_message(self, format, *args):  # noqa: A002 - quiet default logging
        print(f"[ml/serve.py] {self.address_string()} - {format % args}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    model_path = resolve_model_path()
    if not model_path.exists():
        raise SystemExit(f"Model not found at {model_path} - run `python ml/train_model.py` first")

    Handler.model = load_model()
    # ThreadingHTTPServer, not HTTPServer: the plain single-threaded server processes one
    # /predict request at a time, so under concurrent load (this is a real, documented fallback
    # path for ML_SERVING_MODE=python-service, not dead code) requests queue up and are more
    # likely to blow mlClient.js's 100ms fetch timeout, causing extra fail-open (probability 0)
    # scoring than necessary. Handler.model is set once here, before serve_forever, and never
    # mutated afterwards, so concurrent read-only access from multiple request threads is safe.
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"ml/serve.py listening on http://127.0.0.1:{args.port} (POST /predict, GET /health)")
    server.serve_forever()


if __name__ == "__main__":
    main()
