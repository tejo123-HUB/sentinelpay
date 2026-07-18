# SentinelPay

Real-time fraud-detection API for micro-transactions, with a structuring/money-laundering
detection engine. Built for Digital Campus 2.0 on Google Cloud — Hack Sprint.

Combines a fast rule-based signal engine, a cross-account structuring/layering graph engine,
and a scikit-learn-trained ML classifier into a single 0-100 fraud score, returned
synchronously (allow / step-up / block) within the same `POST /transaction` request.

Built for **a merchant business's own senior risk/compliance team**, not a bank — it wires into
every payment gateway the business uses (Stripe, Razorpay, PayPal, etc.), giving one aggregated
view across gateways that no single gateway's own dashboard can show.

See **`architecture.md`** for the full technical spec (schema, API contract, build plan,
final thresholds, and every documented deviation from the original plan),
**`user-manual.md`** for a plain-language walkthrough with worked examples, and
**`deployment-guide.md`** for running this somewhere beyond localhost (env vars, the PROD/DEMO
stand-in map, Cloud Run/Spanner/Vertex AI migration path).

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
first run. Open `http://localhost:3000` in a browser for the live dashboard, which has four
tabs: **Live Monitor** (real-time transaction table + structuring alerts), **Map** (Leaflet view
of transaction origins, color-coded by decision), **Audit Trail** (a trend chart plus a
filterable history of flagged transactions), and **Analytics** (overview stats, an hour/day/week/
month fraud trend, a fraud heatmap, top-risky lists, top fraud categories, top mule accounts,
gateway comparison, and CSV/PDF export). A dark-mode toggle in the top-right applies site-wide.

**Authentication:** every API route except `GET /health` requires an `X-API-Key` header (the
dashboard handles this for you automatically). For pure localhost demo use you don't need to set
anything — the server, the dashboard, and the simulator/benchmark scripts all fall back to the
same published development-only key with a loud startup warning, **and the server only binds to
127.0.0.1 while that default key is in use** — it won't be reachable from other devices on your
network until you set a real `API_KEY`. If you're calling the API directly (`curl`, Postman, etc.)
or running this anywhere beyond localhost, copy `.env.example` to `.env`, set a real `API_KEY`,
and optionally `HOST=0.0.0.0` to listen on all interfaces — see `.env.example` for how to generate
a key, and `architecture.md` Sections 15.6–15.7 for the full reasoning.

To retrain the ML model (optional — a trained model is already included):

```bash
pip install -r ml/requirements.txt
python ml/train_model.py
```

## Running the demo

**One command, for the hackathon table:**

```bash
npm run demo
```

This resets the demo database, starts the server, opens the dashboard in your browser, starts
continuous ambient traffic, and drops you into a live menu (`1`-`5`, `q`) to fire the fraud,
structuring, and odd-hour scenarios on cue. `q` (or Ctrl+C) shuts everything down cleanly —
server and background traffic both. If a server is already running on port 3000, it reuses it
instead of starting a second one (and skips the DB reset, since that would pull the rug out
from under a live server).

Manual/step-by-step version — with the server running (`npm start`), open the dashboard and, in
another terminal:

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

# Compromised business account draining funds via rapid payouts -> block
node simulator/simulate_transactions.js --scenario=outbound-fraud

# A large refund with no matching prior purchase -> flagged
node simulator/simulate_transactions.js --scenario=refund-fraud

# Unrecognized-device merchant login followed by an immediate refund -> block
node simulator/simulate_transactions.js --scenario=merchant-takeover

# A payout to a receiver with a receive-then-quickly-drain history -> block
node simulator/simulate_transactions.js --scenario=mule

# Every scenario above, in sequence
node simulator/simulate_transactions.js --scenario=all
```

Or run `npm run demo` for an interactive menu covering all of the above — see "Running the demo" further up.

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

254 tests across the rule engine (18 detectors — the original 5 general-purpose rules plus 13
outbound-only detectors covering refund integrity, account/vendor risk, merchant/employee/
cross-gateway fraud, mule and circular-flow laundering, geo risk, duplicate transactions, and
shared-device/IP risk), the structuring/circular-flow engine (including end-to-end DB integration
tests), scoring/decision layer (including the blacklist/whitelist/watchlist precedence rules),
ML client, the ingestion API, analytics endpoints, the fraud-lists and merchant-login/dispute
ingestion routes, input validation, API key auth, rate limiting, WebSocket error resilience, and
a dashboard script-load-order regression guard. See `architecture.md` Sections 15.1–15.16 and 16
for a detailed log of bugs found and fixed across every review pass — including several real
security issues, a dashboard that was entirely unstyled and inert until opened in a real browser,
and multiple same-millisecond race conditions in time-window queries — each with a regression
test verified to fail without the fix and pass with it.

## Fraud detection coverage

Beyond the original 5 general-purpose rules and the structuring/layering graph engine, the API
now covers refund integrity (account mismatch, multiple/split refunds, refund velocity),
account/vendor risk (new-vendor tiers, dormant-account reactivation, mule scoring, geo risk),
merchant/employee/cross-gateway fraud (account takeover via login tracking, employee refund
abuse, cross-gateway structuring), circular money-flow detection, duplicate-transaction and
shared-device/IP checks, and an editable blacklist/whitelist/watchlist registry — 18 rule
detectors plus the 4-detector structuring/circular-flow engine in total, all with configurable
thresholds (`server/config.js`), a severity on every flag, a `confidence` score separate from
`fraud_score`, and a `risk_breakdown` in every `POST /transaction` response. New ingestion
endpoints: `POST /merchant-logins`, `POST /disputes`, `POST /fraud-lists`,
`POST /investigation-notes`. New read endpoints: `GET /analytics/*` (summary, trends, top-risky
lists, gateway comparison, CSV/JSON export), `GET /admin-audit-log`. Full design rationale,
what's built vs. explicitly out of scope, and why: `architecture.md` Sections 15.16 and 16.

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
