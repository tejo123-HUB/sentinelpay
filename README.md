# SentinelPay

Real-time fraud-detection API for micro-transactions, with a structuring/money-laundering
detection engine. Built for Digital Campus 2.0 on Google Cloud — Hack Sprint.

Combines a fast rule-based signal engine, a cross-account structuring/layering graph engine,
and a scikit-learn-trained ML classifier into a single 0-100 fraud score, returned
synchronously (allow / step-up / block) within the same `POST /transaction` request.

See **`architecture.md`** for the full technical spec (schema, API contract, build plan,
final thresholds, and every documented deviation from the original plan) and
**`user-manual.md`** for a plain-language walkthrough with worked examples.

## Requirements

- Node.js >= 22.5.0 (uses the built-in `node:sqlite` module — no native build step, see
  `architecture.md` Section 9)
- Python 3 with `numpy` and `scikit-learn` (only needed to retrain the ML model — a pre-trained
  model is already checked in at `ml/model_export/model.json`)

## Setup

```bash
npm install
npm start          # starts the API + dashboard on http://localhost:3000
```

That's it — the SQLite database (`sentinelpay.db`) and its schema are created automatically on
first run. Open `http://localhost:3000` in a browser for the live dashboard, which has three
tabs: **Live Monitor** (real-time transaction table + structuring alerts), **Map** (Leaflet view
of transaction origins, color-coded by decision), and **Audit Trail** (a trend chart plus a
filterable history of flagged transactions).

**Authentication:** every API route except `GET /health` requires an `X-API-Key` header (the
dashboard handles this for you automatically). For pure localhost demo use you don't need to set
anything — the server, the dashboard, and the simulator/benchmark scripts all fall back to the
same published development-only key with a loud startup warning. If you're calling the API
directly (`curl`, Postman, etc.) or running this anywhere beyond localhost, copy `.env.example`
to `.env` and set a real `API_KEY` — see that file for how to generate one, and
`architecture.md` Section 15.6 for the full reasoning.

To retrain the ML model (optional — a trained model is already included):

```bash
pip install -r ml/requirements.txt
python ml/train_model.py
```

## Running the demo

With the server running (`npm start`), open the dashboard and, in another terminal:

```bash
# Continuous background traffic for the dashboard to show live
node simulator/simulate_transactions.js --scenario=normal --continuous

# A single-transaction fraud pattern (velocity + impossible travel + new device) -> block
node simulator/simulate_transactions.js --scenario=fraud

# The full structuring/layering pattern (1 sender -> 6 transfers -> 3 receivers -> 2 rapid
# withdrawals) -> a single grouped structuring alert
node simulator/simulate_transactions.js --scenario=structuring

# The odd-hour rule, live -> flags a transaction outside the account's usual active hours
node simulator/simulate_transactions.js --scenario=odd-hour

# All four in sequence
node simulator/simulate_transactions.js --scenario=all
```

The structuring scenario polls `GET /alerts` for you and prints the created alert once the
background job (runs every 7s by default) picks it up — usually within one or two cycles.

The odd-hour scenario seeds a demo account's historical "typical active hours" baseline
directly in the database (bypassing the API), then sends one transaction through the real API
at genuine current time. This is necessary, not a shortcut: `POST /transaction` always scores
against server-received time (see `architecture.md` Section 15.2), so a manipulated
client-supplied timestamp can no longer fake "days of history, and it's now 3am" — that's a
deliberate security fix, and this scenario works around the *inability to fake it live*, not
around the scoring logic itself, which runs completely unmodified.

## Tests

```bash
npm test
```

77 tests across the rule engine, structuring engine (including an end-to-end DB integration
test replicating the Task 6 Definition of Done), scoring/decision layer, ML client, the
ingestion API, input validation, API key auth, rate limiting, WebSocket error resilience, and a
dashboard script-load-order regression guard. See `architecture.md` Sections 15.1–15.6 for a
detailed log of bugs found and fixed across five review passes (including several real security
issues), each with a regression test that was verified to fail without the fix and pass with it.

## Measuring latency / false-positive behavior

```bash
node simulator/benchmark.js --count=500
```

Sends 500 simulated legitimate transactions through the real synchronous scoring pipeline and
reports latency percentiles plus a rules-only-vs-full-pipeline false-positive comparison. See
`architecture.md` Section 11 (Risks 3 and 4) for the last measured results and how to interpret
them honestly.

## What's a demo stand-in for what

Per `CLAUDE.md`'s hard rule, every demo/local stand-in for a production GCP service is
commented `// PROD: X — DEMO: Y` at its point of use. Summary:

| Production target | Demo stand-in | Where |
|---|---|---|
| Cloud Spanner | SQLite via the built-in `node:sqlite` module | `server/db.js` |
| Vertex AI edge-deployed model | Local inference of the same scikit-learn-trained weights, run natively in Node | `server/ml/mlClient.js` |
| — | A genuinely runnable Python fallback server also exists | `ml/serve.py` (`ML_SERVING_MODE=python-service`) |

## Project structure

See `architecture.md` Section 8 for the full repository layout and Section 9 for the current
tech stack (kept in sync with the code — check there before assuming a package/tool choice).

## License

MIT — see [LICENSE](LICENSE).

## Repository

Public on GitHub: https://github.com/tejo123-HUB/sentinelpay
