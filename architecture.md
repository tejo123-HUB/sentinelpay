# SentinelPay
### Real-Time Micro-Transaction Fraud Detection Platform

**Theme:** Fintech | **Event:** Digital Campus 2.0 on Google Cloud — Hack Sprint (24 July 2026)
**Team Members:** [Add names] | **Team Leader:** [Add name]
**Build deadline:** 21 July 2026

---

## 1. Project Overview

Digital payments in India and globally are scaling at an extraordinary rate — but most fraud detection systems were built for high-value transactions, not the flood of low-value, high-frequency micro-transactions that now dominate UPI, wallets, and in-app purchases. These systems are either too slow to catch fraud before money moves, or too resource-heavy to run at the scale micro-transactions demand.

**SentinelPay** is a lightweight, horizontally scalable fraud-detection API purpose-built for micro-transactions. It sits between a payment gateway and the settlement layer, analyzing transaction metadata — velocity, geography, device fingerprint, and behavioral history — in real time, and returns a fraud-risk decision in milliseconds: **allow, challenge (step-up authentication), or block**.

Rather than relying on a single black-box model, SentinelPay combines fast rule-based signal detection with a machine learning scoring layer, so it can be demoed reliably even under hackathon time constraints while still showcasing genuine ML-driven intelligence. It also goes beyond single-transaction analysis: a dedicated graph engine tracks money as it moves *across* accounts, catching structuring and layering patterns — where a large sum is deliberately split into small transfers, fanned out across multiple accounts, and quickly withdrawn — that transaction-by-transaction fraud checks miss entirely.

### Key Numbers at a Glance

| Metric | Target / measured |
|---|---|
| Decision latency | **Measured (Task 12, 500-tx local benchmark): mean 12.7ms, p50 12.0ms, p95 21.5ms, p99 26.4ms, max 50.7ms** — well inside the <150ms target. See Section 11, Risk 3. |
| Transaction throughput (demo scale) | 1,000+ tx/min simulated (not separately load-tested beyond the 500-tx latency benchmark; per-request latency above implies plenty of headroom at this scale on a single local process) |
| Fraud signal types evaluated | 5 rule-based + 4 structuring/graph checks + 1 ML model |
| Risk tiers | 3 (Allow / Step-up / Block) |
| False-positive reduction target | **Claim removed as unsubstantiated — see Section 11, Risk 4 for what was actually measured instead.** |
| Data consistency model | Strong consistency (Cloud Spanner) — demo runs on SQLite (`node:sqlite`), see Section 9 |
| Model inference location | Edge-deployed (Vertex AI) is the production target; demo runs local inference of the same trained weights, see Section 9 |
| Core stack components | 7 (API, DB, ML, Dashboard, Rules Engine, Decision Layer, Graph Engine) |
| Structuring detection window | Configurable (default: 10 min rolling split window, 30 min withdrawal-correlation window) |
| Money-laundering chain depth traced | **2 hops implemented** (sender → receiver, with a forwarding-vs-cash-out distinction folded into the alert's `reason` text) — the spec's "optional" 3-hop tracing was not built; see Task 6 note below |

---

## 2. Problem Statement

- Traditional fraud models are tuned for large, infrequent transactions — not thousands of ₹10–₹500 micro-payments per second.
- Rule-only systems create too many false positives, frustrating genuine users.
- ML-only systems are often too slow or too costly to run at micro-transaction scale and volume.
- Fraud patterns (impossible travel, velocity abuse, device spoofing) need to be caught **before** settlement, not after in a batch job.
- Sophisticated actors evade single-transaction fraud checks entirely by **structuring**: splitting a large sum into many small transfers, fanning them out across multiple accounts, then withdrawing quickly — a pattern invisible to systems that only look at one transaction at a time.

## 3. Proposed Solution

A real-time scoring API that:
1. Ingests transaction metadata the instant a payment is initiated.
2. Runs fast rule-based checks (sub-10ms) for obvious red flags.
3. Checks (via fast indexed lookup) whether this account is already part of a known structuring/laundering pattern.
4. Runs a scoring model — rule-based today, ML-assisted once trained — for nuanced behavioral scoring.
5. Combines all signals into a single fraud score.
6. Returns a decision instantly to the payment gateway: allow, step-up authentication, or block.
7. Logs everything for a live monitoring dashboard and audit trail, and runs a periodic background job to detect new cross-account structuring patterns.

---

## 4. Feature List

### 4.1 Core Features (MVP)

1. **Transaction Ingestion API**
   REST endpoint accepting `sender_id`, `receiver_id`, `amount`, `timestamp`, `location`, `device_id`, `merchant_id`, and `transaction_type` (transfer / withdrawal / deposit) for every incoming transaction. Including `sender_id`/`receiver_id` from day one is required for structuring detection — it must not be bolted on later.

2. **Rule-Based Fraud Signal Engine** — five independent detectors:
   - **Velocity Check** — flags users exceeding a transaction-per-second/minute threshold.
   - **Impossible Travel Detection** — flags geographically implausible transaction pairs (e.g., two cities within minutes).
   - **Amount Anomaly Detection** — flags transactions deviating significantly (>3x) from a user's rolling average spend.
   - **Device/IP Fingerprint Mismatch** — flags transactions from previously unseen devices or IPs for a given account.
   - **Odd-Hour Behavioral Spike** — flags activity outside a user's typical active hours.

3. **Fraud Scoring & 3-Tier Decision Layer**
   - Combines rule signals + structuring-alert lookup + ML score into a single 0–100 fraud score.
   - **Score > 80** → Auto-block
   - **Score 40–80** → Step-up authentication (OTP/biometric challenge)
   - **Score < 40** → Allow

4. **Live Monitoring Dashboard**
   - Real-time stream of incoming transactions.
   - Flagged transactions highlighted with risk tier and reason.
   - Live counters: total processed, flagged, blocked, step-up challenged.
   - Dedicated panel for structuring alerts (sender → receivers → withdrawal chain).

5. **Explainability Layer**
   Every flagged transaction returns a human-readable reason (e.g., *"Flagged: 3 transactions in 10 seconds, 412 km location jump"*) instead of an opaque score. Never optional — this is a named feature, not polish.

6. **Structuring & Layering Detection (Smurfing Pattern)**
   Detects a common money-laundering pattern: a large sum is deliberately split into many small "micro" transactions (often just under detection thresholds), fanned out across multiple recipient accounts, and then withdrawn from those accounts shortly after. This requires tracking money *flow across accounts*, not just single-transaction anomalies:
   - **Split Detection**: identifies a source account making many small outgoing transactions in a short time window that sum to an unusually large total (e.g., 40 transactions of ₹2,000 within 10 minutes = ₹80,000 moved while evading a ₹50,000 single-transaction alert threshold).
   - **Fan-Out Graph Analysis**: builds a transaction graph linking sender → multiple receivers, flagging accounts that receive from a common source *and* have no prior transaction history with that source.
   - **Rapid Withdrawal Correlation**: flags receiving accounts that withdraw or transfer out a large percentage of the just-received funds within a short window (e.g., >80% withdrawn within 30 minutes of receipt) — a hallmark of "mule" accounts.
   - **Chain Depth Tracking**: optionally traces money across 2–3 hops (A → B, C, D → withdrawn) to catch layering, not just simple structuring. *(Implemented depth: 2 hops — `server/structuring/chainTracking.js` distinguishes a receiver cashing out (withdrawal) from a receiver forwarding funds onward (transfer, implying a further hop), and folds that into the alert's `reason` text. It does not recursively trace a 3rd hop's own onward transactions — out of scope for the hackathon timeline.)*
   - **Latency note:** this analysis is too expensive to run in full on every transaction. It runs as a periodic background job (every 5–10 seconds); the per-transaction path only does a fast indexed lookup against already-computed alerts, keeping the <150ms budget intact.

7. **Vertex AI ML Fraud Classifier** *(core — scoped for time constraints)*
   A lightweight gradient-boosted or logistic regression model trained on a public fraud dataset, feeding the scoring layer alongside the rule engine and structuring detector. This is core to the pitch (it's the named GCP integration and earns bonus points per the event guidelines), so it should not be dropped entirely if time is short — instead, scope it down:
   - **Full version:** train the model, deploy it to Vertex AI, call it live from the API.
   - **Fallback version:** train and run the model locally (still real, still scikit-learn), and present the Vertex AI edge-deployment step as "designed for, demoed locally" in the architecture slide — you still show a working ML component and an honest, well-reasoned GCP integration story.

### 4.2 Stretch Features — both now built

8. **Geographic Visualization** ✅ built
   Live map view (Leaflet.js) plotting transaction origins, with flagged transactions pinned in red for instant visual impact during the demo. `dashboard/map.js`, a "Map" tab in the dashboard nav. Lazily initializes on first view (Leaflet needs a visible container), seeds from `GET /transactions?limit=200`, then plots live transactions via the same WebSocket feed as the live table. Degrades gracefully (a message in the panel, nothing else breaks) if the Leaflet CDN script didn't load.

9. **Audit Trail & Analytics View** ✅ built
   Historical view of flagged transactions over time, useful for showing "improvement over time" or trend analysis to judges. `dashboard/audit.js` + an "Audit Trail" dashboard tab: a Chart.js trend line (allow/step-up/block counts per hour, via the new `GET /audit/summary` endpoint) plus a filterable table of historical flagged transactions (via `GET /transactions?decision=...`, a new optional filter on the existing endpoint).

---

## 5. GCP Architecture

```
                     ┌─────────────────────────┐
                     │   Payment Gateway /       │
                     │   Transaction Simulator   │
                     └────────────┬─────────────┘
                                  │  POST /transaction
                                  ▼
                     ┌─────────────────────────┐
                     │   Ingestion API Layer     │
                     │   (Node.js / Express)     │
                     └────────────┬─────────────┘
                                  │
           ┌──────────────────┼──────────────────────┐
           ▼                                          ▼
┌───────────────────────┐                ┌─────────────────────────┐
│  Rule-Based Signal      │                │  Vertex AI Edge Model    │
│  Engine (5 detectors)   │                │  (fraud probability)     │
└────────────┬───────────┘                └────────────┬────────────┘
             │                                           │
             │            ┌──────────────────────────────┴───────┐
             │            ▼                                       │
             │  ┌─────────────────────────────┐                   │
             │  │  Structuring / Layering        │                   │
             │  │  Graph Engine (background job    │                   │
             │  │  + fast per-tx lookup)            │                   │
             │  └────────────┬────────────────┘                   │
             │               │                                     │
             └───────────────┼─────────────────────────────────────┘
                             ▼
                     ┌─────────────────────────┐
                     │   Fraud Scoring &         │
                     │   3-Tier Decision Layer   │
                     └────────────┬─────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                                        ▼
  ┌────────────────────────┐             ┌───────────────────────────┐
  │  Cloud Spanner           │────────────►│  Live Dashboard             │
  │  (transaction history,   │             │  (WebSocket stream,         │
  │  user profiles, strong   │             │  flagged tx, counters,     │
  │  global consistency)     │             │  map view)                  │
  └────────────────────────┘             └───────────────────────────┘
```

**Why Cloud Spanner:** Fraud decisions depend on a single, up-to-the-second source of truth for a user's transaction history across regions. An eventually-consistent store (like Firestore) risks scoring a transaction against stale data. Spanner's strong consistency + horizontal scalability ensures accurate velocity and behavioral checks even at high transaction volume.

**Why Vertex AI:** Enables deploying a trained fraud model close to the point of inference (edge deployment), keeping scoring latency low enough to fit within the real-time decision window, without needing to manage custom ML infrastructure.

**Why a Graph Engine is needed for structuring detection:** Rule-based single-transaction checks and even the ML classifier evaluate one transaction in isolation. Structuring is only visible when you look at *relationships between transactions across accounts over time* — one sender, many receivers, followed by fast withdrawals. Cloud Spanner stores the transaction data with strong consistency, but the structuring detector itself needs a lightweight graph traversal layer on top of it (can be implemented in-app for the hackathon using SQL self-joins/window functions — no separate graph database is required at this scale).

**For local development and the hackathon demo:** use **SQLite** in place of Cloud Spanner, and **local scikit-learn inference** in place of Vertex AI if the deployment path proves too slow to set up. Comment this clearly in code (`// PROD: Cloud Spanner — DEMO: SQLite`) so it's obvious what's a demo stand-in vs. the intended production architecture.

---

## 6. Database Schema (SQLite, demo version)

```sql
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  home_location_lat REAL,
  home_location_lng REAL,
  avg_transaction_amount REAL DEFAULT 0,
  typical_active_hours TEXT -- JSON array of hour ranges, e.g. "[[8,22]]"
);

CREATE TABLE transactions (
  transaction_id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  amount REAL NOT NULL,
  timestamp TEXT NOT NULL,          -- ISO 8601
  location_lat REAL,
  location_lng REAL,
  device_id TEXT,
  merchant_id TEXT,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('transfer', 'withdrawal', 'deposit')),
  fraud_score REAL,
  decision TEXT CHECK (decision IN ('allow', 'step_up', 'block')),
  FOREIGN KEY (sender_id) REFERENCES users(user_id),
  FOREIGN KEY (receiver_id) REFERENCES users(user_id)
);

CREATE INDEX idx_transactions_sender ON transactions(sender_id, timestamp);
CREATE INDEX idx_transactions_receiver ON transactions(receiver_id, timestamp);

CREATE TABLE flags (
  flag_id TEXT PRIMARY KEY,
  transaction_id TEXT,
  flag_type TEXT NOT NULL,          -- e.g. 'velocity', 'impossible_travel', 'structuring'
  reason TEXT NOT NULL,             -- human-readable explanation
  weight REAL NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
);

CREATE TABLE structuring_alerts (
  alert_id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  receiver_ids TEXT NOT NULL,       -- JSON array
  total_amount REAL NOT NULL,
  transaction_count INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  withdrawal_ratio REAL,            -- % of received funds withdrawn quickly
  reason TEXT NOT NULL,             -- human-readable explanation, added Task 6 (see note below)
  created_at TEXT NOT NULL
);
```

**Schema change (Task 6):** added `reason TEXT NOT NULL` to `structuring_alerts`. It was missing from the original table above, but CLAUDE.md's hard rule ("every flag or alert needs a human-readable reason string, never just a score") applies to alerts too, and `flags.reason` already had one — this closes that gap rather than leaving structuring alerts as the one place a raw score/number could stand without explanation. Not a retrofit of `sender_id`/`receiver_id` (the one column change the hard rules forbid doing later) — just an added column.

**Important:** `sender_id` and `receiver_id` must exist from the very first schema migration — do not add them later; the structuring detector depends on them from day one.

**Implementation note (Task 2):** `server/db.js` adds two extra indexes beyond the ones listed above — `idx_flags_transaction` on `flags(transaction_id)` and `idx_structuring_alerts_sender` on `structuring_alerts(sender_id)` — both pure lookup-performance additions with no schema/column changes, needed for the fast per-transaction structuring-alert lookup (Task 6) and for fetching flags per transaction. The `users.avg_transaction_amount` running average (Task 3) is maintained using an indexed `COUNT(*)` over `transactions` for the per-user transaction count rather than adding a redundant `transaction_count` column to `users`.

---

## 7. API Contract

### `POST /transaction`
Accepts a single transaction and returns a decision **synchronously** — scoring (rules + structuring lookup + ML) happens within the same request/response cycle. There is no async/polling pattern in this project.

**Request body:**
```json
{
  "sender_id": "u_123",
  "receiver_id": "u_456",
  "amount": 250.00,
  "timestamp": "2026-07-18T10:15:00Z",
  "location": { "lat": 16.5062, "lng": 80.6480 },
  "device_id": "d_789",
  "merchant_id": "m_001",
  "transaction_type": "transfer"
}
```

**Response body:**
```json
{
  "transaction_id": "t_abc123",
  "fraud_score": 87,
  "decision": "block",
  "reasons": [
    "3 transactions in 10 seconds",
    "412 km location jump from last transaction"
  ]
}
```

### `GET /transactions?limit=50&decision=block,step_up`
Returns recent transactions with their decisions and flag reasons, for the dashboard's live table and the Task 11 audit trail. `decision` (optional, comma-separated, one or more of `allow`/`step_up`/`block`) filters the results — added when building the audit trail (Section 15.2).

### `GET /alerts`
Returns active structuring/layering alerts (grouped, not per-transaction).

### `GET /audit/summary?hours=24&bucketMinutes=60`
Task 11 (audit trail): time-bucketed counts of `allow`/`step_up`/`block` over the given lookback window, for the trend chart. Added in Section 15.2. Returns `{ hours, bucketMinutes, totalTransactions, buckets: [{ bucket_start, allow, step_up, block }, ...] }`.

### WebSocket `/ws`
Broadcasts every processed transaction and every new structuring alert to connected dashboard clients as they happen:
```json
{ "type": "transaction", "data": { "transaction_id": "...", "fraud_score": ..., "decision": "...", "reasons": [...], "sender_id": "...", "receiver_id": "...", "amount": ..., "timestamp": "...", "location": { "lat": ..., "lng": ... }, "device_id": "...", "merchant_id": "...", "transaction_type": "..." } }
{ "type": "structuring_alert", "data": { "sender_id": "...", "receiver_ids": [...], "total_amount": ..., "withdrawal_ratio": ... } }
```
**Deviation from the original spec (Section 15.3):** the `transaction` payload is the full transaction, not just the `POST /transaction` response fields as originally documented here. See Section 15.3 for why — the original "same as POST response" contract left the dashboard's live table and map view with no sender/receiver/amount/location data for any transaction that arrived over the WebSocket rather than the initial `GET /transactions` load.

---

## 8. Repository Structure

```
sentinelpay/
├── CLAUDE.md                   ← Claude Code entrypoint (kept short — points here)
├── README.md                   ← public-facing project readme
├── architecture.md             ← this file, the full spec
├── package.json
├── .env.example
├── server/
│   ├── index.js                ← Express app entrypoint, wires everything together
│   ├── db.js                   ← SQLite connection + schema setup
│   ├── routes/
│   │   └── transactions.js     ← POST /transaction, GET /transactions, GET /alerts
│   ├── rules/
│   │   ├── velocity.js
│   │   ├── impossibleTravel.js
│   │   ├── amountAnomaly.js
│   │   ├── deviceMismatch.js
│   │   └── oddHour.js
│   ├── structuring/
│   │   ├── splitDetection.js
│   │   ├── fanOutAnalysis.js
│   │   ├── withdrawalCorrelation.js
│   │   └── chainTracking.js
│   ├── ml/
│   │   └── mlClient.js         ← calls into ml/serve.py or Vertex AI endpoint
│   ├── scoring.js               ← combines rule + structuring + ML signals into 0–100 score
│   ├── decision.js              ← 3-tier decision logic (allow / step-up / block)
│   └── websocket.js             ← pushes live events to dashboard clients
├── dashboard/
│   ├── index.html
│   ├── app.js
│   ├── map.js                   ← Task 10, Leaflet map view (added in the review pass, Section 15.2)
│   ├── audit.js                 ← Task 11, audit trail trend chart + table (added in the review pass, Section 15.2)
│   └── style.css
├── ml/
│   ├── train_model.py
│   ├── serve.py                 ← local fallback inference server
│   ├── requirements.txt
│   └── model_export/
├── simulator/
│   ├── simulate_transactions.js ← generates normal + fraud + structuring demo traffic
│   └── benchmark.js             ← Task 12, latency + false-positive measurement
└── tests/
    ├── rules.test.js
    ├── structuring.test.js
    ├── scoring.test.js
    ├── ml.test.js
    ├── validate.test.js
    ├── api.test.js
    ├── websocket.test.js
    └── dashboard.test.js
```

**Implementation note (final):** a few files were added beyond this original list, all straightforward extractions/additions rather than deviations from anything binding:
- `server/validate.js` — request body validation for `POST /transaction`, factored out of the route handler.
- `server/userProfile.js` — DB reads/writes for sender/receiver profile data (running average, typical-hours baseline, device history), factored out so `routes/transactions.js` stays focused on HTTP orchestration.
- `server/utils/geo.js` — shared haversine-distance helper used by both `impossibleTravel.js` and `server/ml/features.js`.
- `server/ml/features.js` — the behavioral feature extraction shared between `mlClient.js` and (implicitly, by construction) `ml/train_model.py`'s feature order.
- `server/structuring/pipeline.js` — the pure orchestration of the four structuring detectors, kept separate from `backgroundJob.js`'s impure DB/scheduling wrapper so it's directly unit-testable (see Task 6 DoD tests).
- `server/structuring/alertLookup.js` — the fast per-transaction structuring-alert lookup described in Task 6 but not given its own filename in the original plan.
- `simulator/benchmark.js` — the Task 12 latency/false-positive measurement script.
- `tests/api.test.js`, `tests/ml.test.js`, `tests/validate.test.js`, `tests/websocket.test.js`, `tests/dashboard.test.js` — additional test coverage (ingestion API incl. the timestamp-security regression, ML client incl. the timeout regression, input validation, WebSocket error resilience, and a script-load-order regression guard) beyond the three test files originally listed.

---

## 9. Tech Stack

**This table reflects the current decision, not a fixed rule.** The stack is chosen jointly by whoever is working on the project (team + Claude Code) at the time, based on what's actually working, time remaining, and team familiarity — it's expected to evolve. The one requirement is keeping this table honest: **whenever the actual stack changes, update this table in the same commit**, so it never silently drifts out of sync with the real code.

| Layer | Current choice |
|---|---|
| Backend | Node.js + Express |
| Database (demo) | SQLite via the built-in `node:sqlite` module (`DatabaseSync`) — not `better-sqlite3` |
| Database (production target) | Google Cloud Spanner |
| Real-time transport | WebSocket (`ws` package) |
| ML training | Python 3 + scikit-learn (logistic regression, `class_weight="balanced"`) |
| ML serving (production target) | Vertex AI |
| ML serving (demo default) | Weights exported to `ml/model_export/model.json`, inference run natively inside the Node process (`server/ml/mlClient.js`, `ML_SERVING_MODE=local`) — no sidecar process |
| ML serving (demo fallback) | `ml/serve.py`, a dependency-free Python `http.server` (Flask/FastAPI are not installed in this environment) exposing `POST /predict`; reachable via `ML_SERVING_MODE=python-service` |
| Frontend dashboard | Plain HTML/CSS/JS + Chart.js (kept dependency-light so it demos with zero setup friction) |
| Map visualization (stretch) | Leaflet.js |
| Version control | Git + GitHub |
| UUID generation | Built-in `crypto.randomUUID()` — no `uuid` package dependency |

**Deviation note (16 July 2026):** `better-sqlite3` requires a native (node-gyp) build step, and the dev machine has no Visual Studio C++ build tools installed, so `npm install` failed. The Node runtime in use is v26.4.0, which ships the built-in `node:sqlite` module (`DatabaseSync`) — a synchronous SQLite API with no native compilation and no extra dependency, and it's API-compatible enough with the `better-sqlite3` patterns this doc assumes (`db.prepare(sql).run/get/all(...)`) that no schema or query logic changes were needed. Same reasoning applied to drop the `uuid` package in favor of the built-in `crypto.randomUUID()`. Requires Node >= 22.5.0 (where `node:sqlite` was introduced); pinned in `package.json` `engines`.

**ML deviation note (Task 8):** two changes from the original plan, both driven by keeping the hackathon demo self-contained and reliable:
1. **Training data.** `ml/train_model.py` does not use the Kaggle "Credit Card Fraud Detection" dataset the doc originally suggested — that dataset's `V1`-`V28` features are anonymized PCA components with no interpretable meaning, and none of them correspond to a signal this API actually has at scoring time. Instead it generates a synthetic dataset over the *same* behavioral feature space the rule engine already computes (`velocity_count_60s`, `amount_to_avg_ratio`, `travel_speed_kmh`, `is_new_device`, `is_odd_hour`, `amount`), with fraud patterns injected as a mixture of anomalous signal combinations (matching the fraud/step-up worked examples in `user-manual.md`). This lets the ML layer learn nonlinear interactions between the same signals the rules use, rather than operating on a disconnected feature space. It is a genuinely trained `scikit-learn` `LogisticRegression` (`class_weight="balanced"`), evaluated on a held-out test split (AUC ≈ 0.88, recall ≈ 0.73, precision ≈ 0.35 — recall-biased on purpose, since this is one signal feeding a broader scoring pipeline, not a standalone gate).
2. **Serving path.** The demo does not call a live Vertex AI endpoint (no GCP project provisioned in this dev environment) and does not default to a Flask/FastAPI sidecar either (neither package is installed here). Instead the trained weights are exported to `ml/model_export/model.json` and `server/ml/mlClient.js` runs the logistic-regression forward pass (standardize → dot product → sigmoid) natively inside the Node process by default (`ML_SERVING_MODE=local`) — sub-millisecond, no extra process to keep alive during a live demo. `ml/serve.py` is still a genuine, independently runnable fallback (stdlib `http.server`, `POST /predict`) reachable via `ML_SERVING_MODE=python-service`, and a `ML_SERVING_MODE=vertex` path exists as an explicit, honest stub for the production target. The pitch should say plainly: "designed for Vertex AI edge deployment, demoed with local inference of the same trained model."

*Last confirmed accurate as of: 16 July 2026, Task 1 (scaffolding).*

---

## 10. 5-Day Build Plan (16–20 July, with 21st as buffer/submission day)

Work through tasks in order within each day. Each task has a **Definition of Done (DoD)** — don't move on until it's met. If a task is taking much longer than estimated, stop and flag it rather than silently pushing on — see Section 11 for the cut order if you fall behind.

### Day 1 — 16 July (~5–6 hrs): Scaffolding, DB, Ingestion API

**Task 1 — Project Scaffolding** (~1 hr)
- Create the repo structure from Section 8.
- `npm init -y && npm install express better-sqlite3 ws uuid`
- Set up `.env.example` with placeholder config (port, DB path).
- **DoD:** `npm start` runs a bare Express server that responds `200 OK` on `GET /health`.

**Task 2 — Database Layer** (~1–2 hrs)
- Implement `server/db.js`: create the SQLite file, run the schema from Section 6 on startup if tables don't exist.
- **DoD:** Running the server creates `sentinelpay.db` with all 4 tables and indexes, verifiable via `sqlite3 sentinelpay.db ".tables"`.

**Task 3 — Ingestion API** (~2–3 hrs)
- Implement `POST /transaction`: validate required fields, insert the raw transaction, then synchronously run the scoring pipeline (Tasks 5–8) before responding, and store the resulting `fraud_score`/`decision` in the same request.
- After inserting, update the sender's `avg_transaction_amount` using a running average: `new_avg = old_avg + (amount - old_avg) / total_transaction_count`. Create the user row if it doesn't exist yet.
- **DoD:** A `curl` POST with valid fields returns a 201 with a populated `transaction_id`, `fraud_score`, and `decision` (not nulls). Invalid/missing fields return a 400 with a clear error message.

### Day 2 — 17 July (~6–7 hrs): Simulator + Rule Engine

**Task 4 — Simulator** (build immediately after Task 3 — needed to test everything downstream)
- `simulator/simulate_transactions.js`: generates a continuous stream of realistic normal transactions, plus on-demand triggers for (a) a single-transaction fraud pattern (velocity + impossible travel) and (b) a full structuring pattern (1 sender, 6 small transfers, 3 receivers, 2 rapid withdrawals).
- **DoD:** `node simulator/simulate_transactions.js --scenario=structuring` reliably produces exactly one structuring alert every time it's run. Use console output to verify until the dashboard (Day 4) exists.

**Task 5 — Rule Engine**
Each detector is a pure function: `(transaction, userHistory) => { flagged: bool, reason: string, weight: number }`.
- `velocity.js` — flag if sender has more than N transactions (default N=5) in the last 60 seconds.
- `impossibleTravel.js` — flag if distance/time between this transaction's location and the sender's last implies travel speed >900 km/h.
- `amountAnomaly.js` — flag if `amount > 3 * user.avg_transaction_amount` (skip if user has no meaningful history yet).
- `deviceMismatch.js` — flag if `device_id` has never appeared before for this `sender_id`.
- `oddHour.js` — flag if the transaction hour falls outside `user.typical_active_hours`.
- **DoD:** Each detector has ≥2 unit tests (one that should flag, one that shouldn't) in `tests/rules.test.js`, all passing.

### Day 3 — 18 July (~7–8 hrs, the critical path — do not let this slip): Structuring Engine + Scoring

**Task 6 — Structuring / Layering Graph Engine** — the hardest and most important task; budget the most time here and start it first thing in the morning.

Split into two parts to keep latency reasonable:
- A **background job** (every 5–10 seconds) that scans recent transactions and computes/updates `structuring_alerts` rows.
- A **fast synchronous lookup** used in the per-transaction scoring pipeline: "does an active alert already exist for this `sender_id`/`receiver_id`?" — cheap, indexed, fits the real-time budget.

Implement as four composable, independently testable steps:
1. **`splitDetection.js`** — sum outgoing `transfer` amounts per sender in a rolling window (default 10 min). Flag if `count >= MIN_SPLIT_COUNT` (default 5) AND `sum >= MIN_SPLIT_TOTAL` (default e.g. ₹20,000) AND each individual transaction is below the single-transaction alert threshold.
2. **`fanOutAnalysis.js`** — count distinct receivers in that window. Flag if `distinct_receivers >= MIN_FANOUT` (default 3) and none had prior history with this sender before the window.
3. **`withdrawalCorrelation.js`** — for flagged receivers, compute `withdrawal_ratio = amount_sent_out / amount_received` in the following window (default 30 min). Flag as a likely mule account if ratio `>= 0.8`.
4. **`chainTracking.js`** — combine into one `structuring_alerts` row (sender, all receivers, total, window, ratio) — never surface 40 individual small transactions as 40 separate flags.

All thresholds must be named constants at the top of their file, not magic numbers — you'll need to tune them against the demo dataset.

- **DoD:** The synthetic scenario (1 sender → 6 small transfers → 3 receivers → 2 withdraw >80% within 30 min) produces exactly one `structuring_alerts` row within one background-job cycle. Covered in `tests/structuring.test.js`.

**Task 7 — Scoring & Decision Layer**
- `scoring.js`: combine rule flags (weighted sum), the fast structuring-alert lookup (large fixed weight if active), and the ML probability (Task 8) into a 0–100 score. Document the weighting formula in a comment.
- `decision.js`: `score > 80` → `block`, `40–80` → `step_up`, `< 40` → `allow`.
- **DoD:** `tests/scoring.test.js` confirms a clean transaction scores low/allow, 2+ rule flags push into step-up/block, and an active structuring alert always pushes into block range regardless of the transaction's own size.

### Day 4 — 19 July (~6–7 hrs): ML Model + Dashboard (start)

**Task 8 — ML Model** — has a required fallback, do not skip either path silently.
- `ml/train_model.py`: load a public fraud dataset (Kaggle "Credit Card Fraud Detection" is a reasonable default), train a logistic regression or gradient-boosted classifier, export it.
- **Primary path:** deploy to Vertex AI, call it from `mlClient.js` via HTTP.
- **Required fallback if Vertex AI isn't feasible in time:** run `ml/serve.py` locally (Flask/FastAPI), have `mlClient.js` call that instead. Comment this clearly (`// FALLBACK: local inference, see Section 10 Task 8 for Vertex AI path`) and be ready to say so honestly in the pitch: "designed for Vertex AI edge deployment, demoed locally due to time constraints."
- **DoD:** `mlClient.js` returns a fraud probability (0–1) regardless of backend, and `scoring.js` incorporates it.

**Task 9 — Live Dashboard (start)**
- `server/websocket.js`: broadcast every scored transaction and every new structuring alert.
- `dashboard/index.html` + `app.js`: live table color-coded by risk tier (green/yellow/red), running counters, structuring-alert panel.
- **DoD (end of Day 4, partial is fine):** Dashboard shows live transactions and counters updating in real time.

### Day 5 — 20 July (~5–6 hrs): Finish Dashboard + Demo Prep

**Task 9 (finish)** — structuring alert panel showing sender → receivers → withdrawal chain, if not already done.

**Task 10 — Geographic Map View** ✅ built (added in the post-launch review pass) — Leaflet.js map plotting transaction origins, flagged in red. `dashboard/map.js`.

**Task 11 — Audit Trail View** ✅ built (added in the post-launch review pass) — historical view of past flags/alerts, with a trend chart. `dashboard/audit.js`, `GET /audit/summary`, `GET /transactions?decision=`.

**Task 12 — Demo Prep & Polish**
- Measure real latency: log timing around the scoring pipeline for ≥500 simulated transactions; replace the "<150ms target" in this doc with a real measured number.
- Rehearse the demo script (Section 12) — must show all three decision tiers, not just allow/block.
- Clean up README, push final commit.

### 21 July — Buffer / Submission Day
- Finalize proposal form and block diagram using this document as source of truth.
- Final GitHub push, rehearsal, submission.

---

## 11. Known Risks & Required Fallbacks

1. **Scope is tight for the timeline.** If behind schedule by end of Day 3, cut in this order: Task 11 (audit trail) → Task 10 (map) → reduce Task 8 to the local-inference fallback → reduce Task 5 to 3 rule detectors instead of 5. Do **not** cut Task 6 (structuring engine) — it's the project's main differentiator. Flag it to the team immediately if a cut is needed rather than silently descoping. *(Resolution: the full build — Tasks 1-9 plus Task 12 — was completed without needing this cut order; Tasks 10/11 (map, audit trail) were the only items intentionally left as stretch/not built.)*
2. **Structuring detection thresholds are fragile.** Tune the simulator's scripted demo scenario to be an obvious, exaggerated pattern (far more transactions/faster withdrawal than the realistic minimum thresholds) so detection is robust on stage even if the underlying thresholds aren't perfectly tuned. *(Resolution: the simulator's `--scenario=structuring` sends 6×₹4,000 transfers — count and total both comfortably above `MIN_SPLIT_COUNT=5`/`MIN_SPLIT_TOTAL=20000` — to 3 fresh receivers, 2 of whom withdraw 81-88% of received funds, well above the 80% mule threshold. Verified reliable across repeated runs in `tests/structuring.test.js` and live simulator runs; each run uses fresh random account IDs specifically so the 10-minute re-alert cooldown never makes a repeat demo run look broken.)*
   - **Bug found and fixed during Task 12 live testing:** `splitDetection.js` originally stamped a candidate's `windowEnd` as the background job's own scan time rather than the timestamp of the last actual transfer in the burst. Since a mule realistically withdraws within a second or two of receiving funds — almost always *before* the next scan even runs — the withdrawal's timestamp was always earlier than that inflated `windowEnd`, so `withdrawalCorrelation.js`'s `tMs >= windowEndMs` check silently excluded it every time. The live simulator run reliably created the alert (the DoD's core guarantee) but with `withdrawal_ratio: 0` and no mule mention in the reason — a real correctness bug, not just missing polish. Fixed by computing `windowEnd` from `MAX(timestamp)` over the candidate's own transfers; covered by a new regression test (`tests/structuring.test.js`, "a realistic background-job scan delay still correctly correlates withdrawals") that reproduces the exact live timing (transfers ~200ms apart, withdrawal ~200ms after the last transfer, scan running the default 8s later) and fails without the fix.
   - **Known remaining limitation (accepted, not fixed):** because alerts are create-once and protected by the 10-minute re-alert cooldown, if the periodic background-job tick happens to land in the narrow real-world gap between the transfers finishing and the mule withdrawal being sent, the alert is created (satisfying split+fan-out) *before* any withdrawal data exists, and — since a fresh alert for that sender now exists — is never later updated with the withdrawal/mule enrichment once it arrives. This doesn't affect the Task 6 DoD (exactly one alert, created reliably) — only the completeness of the mule detail in that alert's `reason`/`withdrawal_ratio` in the unlucky case. Not fixed here (would need alert-update logic, not just alert-create) — flagging honestly rather than leaving it to look like a flake if it's ever seen live.
3. **Latency claims must be backed by real measurements** before the demo (Task 12) — don't present target numbers as if they were results. *(Resolution: measured via `simulator/benchmark.js` over 500 real `POST /transaction` calls against a locally-running server on the dev machine — mean 12.7ms, p50 12.0ms, p95 21.5ms, p99 26.4ms, max 50.7ms. Comfortably inside the <150ms target, with the full rules+structuring-lookup+ML pipeline running synchronously on every request. Not a production/cloud load test — single local process, SQLite, modest concurrency.)*
4. **The false-positive-reduction stat (~30%) is currently unsubstantiated.** Either compute a real before/after comparison (rules only vs. full pipeline) using the simulator, or remove the claim before the pitch. *(Resolution: the ~30% figure is removed — it was never derived from anything. What was actually measured, honestly: running `simulator/benchmark.js` against 500 simulated legitimate transactions, 0% were flagged by a "rules-only" reconstruction (sum of triggered rule weights alone) and 0.4% (2/500) were flagged by the full pipeline (rules + ML + structuring lookup) — the ML signal adds a small amount of extra sensitivity beyond the rules alone on clean traffic, not a reduction. The design mechanism the original claim was gesturing at — a single moderate anomaly should route to step-up rather than an outright block, unlike a naive single-rule "any flag blocks" system — is real and directly verified in `tests/scoring.test.js` ("a single strong anomaly... lands in step-up, not allow or block"), but a statistically meaningful false-positive-reduction percentage would need a much larger, labeled real-world-like dataset than a hackathon can produce. State this plainly in the pitch rather than citing a number.)*
5. **The Vertex AI story must stay honest.** If the local-inference fallback is used, the demo script and proposal form must say so plainly — not glossed over. *(Resolution: no live GCP project was available in this dev environment. `ml/train_model.py` trains a real scikit-learn model; `server/ml/mlClient.js` runs that trained model's forward pass natively in Node by default, with `ml/serve.py` kept as a genuinely runnable Python fallback and an explicit, honest stub for the Vertex AI path. See Section 9's ML deviation note for the full explanation. Pitch line: "designed for Vertex AI edge deployment, demoed with local inference of the same trained model.")*

---

## 12. Demo Script (Suggested Flow)

1. Show dashboard idle, then start the transaction simulator.
2. Point out normal transactions flowing through as "Allowed" in green.
3. Trigger a scripted single-transaction fraud pattern (velocity + impossible travel) and show it flagged and blocked instantly.
4. Trigger a transaction that lands in the 40–80 score range and show the "step-up authentication" outcome — don't skip this tier in the demo.
5. Trigger a scripted **structuring pattern**: one account splitting a large sum into many small transfers across several receivers, followed by rapid withdrawals.
6. Show the dashboard surface this as a single grouped structuring alert (not dozens of low-value flags), with the sender → receivers → withdrawal chain visible.
7. Briefly explain the Cloud Spanner + Vertex AI architecture slide, emphasizing why strong consistency matters for catching cross-account patterns.

---

## 13. Team Roles (Suggested)

| Role | Responsibility |
|---|---|
| Backend Lead | Ingestion API, rule engine, structuring/layering graph engine, decision layer |
| Data/ML Lead | Model training, dataset prep, Vertex AI integration |
| Frontend Lead | Dashboard, WebSocket integration, structuring alert view, map view |
| Architecture/Docs Lead | Diagrams, proposal form, presentation |

---

## 14. Coding Conventions

- Plain JavaScript (no TypeScript), CommonJS (`require`/`module.exports`), matching the team's existing Node.js experience.
- Every rule/structuring detector function must be pure (no hidden global state) and independently unit-testable.
- No magic numbers — all thresholds are named constants, declared at the top of their file, with a one-line comment explaining what they control.
- Every flagged transaction/alert must carry a human-readable `reason` string — never just a numeric score with no explanation.
- Comment any place where a demo/local stand-in is used for a production GCP service, using the `// PROD: X — DEMO: Y` format.
- Keep the dashboard dependency-free beyond Chart.js and (if used) Leaflet — no frontend framework, no build step.

---

## 15. Definition of "Done" for the 21 July Deadline

- [x] Tasks 1–9 complete and passing their DoDs.
- [x] Simulator can reliably trigger and visibly resolve: (a) a clean transaction (`--scenario=normal`), (b) a single-transaction fraud block (`--scenario=fraud`, verified score 100/block), (c) a step-up/challenge case (verified in the normal stream and in `tests/scoring.test.js`), (d) a full structuring alert (`--scenario=structuring`, verified reliable across repeated runs).
- [x] Real latency numbers measured and recorded (Section 11, Risk 3): mean 12.7ms / p50 12.0ms / p95 21.5ms / p99 26.4ms / max 50.7ms over 500 real requests.
- [x] This document updated with details that changed during implementation: `node:sqlite` instead of `better-sqlite3` (Section 9), local ML inference instead of a live Vertex AI/Flask sidecar (Section 9), final rule weights (Section 10 Task 7 area / `server/scoring.js`), the `structuring_alerts.reason` schema addition (Section 6), and the false-positive claim resolution (Section 11, Risk 4).
- [x] Code committed to git and pushed to GitHub: https://github.com/tejo123-HUB/sentinelpay (public, MIT licensed, sole contributor). A clear README covering setup and how to run the demo exists (`README.md`).
- [x] Stretch tasks: Task 10 (geographic map view) and Task 11 (audit trail / analytics view) — both built in the post-launch review pass (Section 15.2). Neither was required for this Definition of Done, but both are now complete.

### 15.1 Post-build senior review (found and fixed, same session)

A second pass over the finished build, specifically looking for correctness/security/reliability issues that automated tests wouldn't necessarily catch, found and fixed three real bugs beyond the structuring `windowEnd` bug already logged under Section 11, Risk 2:

1. **Stored XSS in the dashboard (security).** `POST /transaction` only validates that `sender_id`/`receiver_id` are non-empty strings — no character restriction. `dashboard/app.js` rendered them (and `reason`/`transaction_type`/`decision`) straight into `innerHTML` template strings. A transaction with `sender_id: "<img src=x onerror=...>"` would execute arbitrary JS in the browser of anyone viewing the live dashboard — a fraud analyst's session. Fixed with an `escapeHtml()` helper applied to every dynamic value before interpolation, plus a `decision` allowlist check before it's used as a CSS class name. The API layer itself was never at risk (JSON responses are correctly escaped by `JSON.stringify`); this was purely a client-side rendering gap. Also added length caps (128 chars) on `sender_id`/`receiver_id`/`device_id`/`merchant_id` and lat/lng range validation in `server/validate.js` as defense-in-depth, with new tests in `tests/validate.test.js`.
2. **Unhandled promise rejection could crash the whole server on one bad request (reliability).** Express 4 (unlike Express 5) does not automatically forward errors thrown or rejected after an `await` inside an async route handler to error-handling middleware — confirmed by reproducing it directly (`process.on('unhandledRejection', ...)` fired, and by default modern Node terminates the process on an unhandled rejection). `POST /transaction`'s handler had no try/catch around its `await getFraudProbability(...)` and subsequent DB writes, so a single DB error would have taken the entire fraud-detection API down instead of failing just that request. Fixed by wrapping the handler body in try/catch + `next(err)`; verified with a forced DB-failure test that now correctly returns 500 and leaves the server running. Also added a process-level `unhandledRejection` logger in `server/index.js` as a last-resort safety net. GET handlers were unaffected — Express 4 does correctly catch synchronous throws in non-async handlers (verified separately).
3. **A flaky WebSocket client could turn a successfully-processed transaction into an HTTP 500 (reliability).** `websocket.js`'s `broadcast()` called `client.send()` for every connected client with no per-client isolation; one throwing client would propagate the exception back into `POST /transaction`'s synchronous tail — *after* the DB write had already succeeded — incorrectly failing the HTTP response for a transaction that was actually scored and stored correctly. Fixed by wrapping each `client.send()` in its own try/catch.

All fixes verified: `npm test` passed (48 tests at the time, up from 39 — added `tests/validate.test.js` and the structuring `windowEnd` regression test), and each fix was manually reproduced-then-verified-fixed live (forced DB failure, adversarial `sender_id` payload end-to-end) rather than assumed.

### 15.2 Second review pass: Tasks 10/11 built, independent deep review, 8 more findings fixed

A follow-up request ("review deeply, fix all problems, add any missing feature, push a new branch") prompted two things in parallel: building the two stretch features (Section 4.2), and an independent code-review agent given the full codebase (not just a diff) and explicitly told to hunt for security/reliability/correctness bugs rather than style issues. Its process note first: it flagged that its own early file reads of `server/routes/transactions.js` and `dashboard/app.js` had returned stale/truncated content, re-read everything, and cross-checked with line counts before finalizing findings — worth recording as a reminder that tooling can silently hand back stale reads.

**Built (Tasks 10/11):** `dashboard/map.js` (Leaflet map, lazy-init on tab show, live-updates via the same WebSocket feed as the live table, capped marker count) and `dashboard/audit.js` (Chart.js trend line + filterable flagged-transaction table) — both routed through a new tab-navigation bar in `dashboard/index.html`, backed by two new endpoints (`GET /audit/summary`, and a `decision` filter added to the existing `GET /transactions`). While building these, found and fixed a real bug affecting the *original* Task 9 dashboard too: `app.js`/`map.js`/`audit.js` were loaded as plain (non-deferred) `<script>` tags, which execute immediately when the HTML parser reaches them — *before* the `defer`red Chart.js/Leaflet CDN scripts (declared earlier, in `<head>`) actually run, per the HTML spec's defer-execution-order guarantee. That meant `typeof Chart === 'undefined'` was always true at init time, regardless of network conditions — the donut chart had silently never rendered since it was first built. Fixed by adding `defer` to all three app scripts too, so they execute in the same strict document-order queue as the CDN scripts. Guarded with a new `tests/dashboard.test.js` that asserts the `defer` attribute and script declaration order directly against `index.html`, so this can't silently regress.

**Review agent findings, most severe first (all fixed, all with a regression test that was verified to fail without the fix and pass with it):**

1. **Critical — client-controlled `timestamp` defeated every time-window fraud check, including the structuring-alert "always block" guarantee.** `POST /transaction`'s `timestamp` field was validated for shape only, then used directly as the `nowMs` anchor for the structuring-alert activity-window lookup (`alertLookup.js`), the velocity/impossible-travel windows, and the recent-transactions lookback. A future-dated `timestamp` shifted the alert-lookup's cutoff forward past every real alert's `created_at`, letting an account with an active structuring alert evade the mandatory block by simply claiming a far-future time. Reproduced directly (a seeded active alert + a 5-years-future `timestamp` → `'allow'` instead of `'block'`) before fixing. **Fix:** `routes/transactions.js` now overwrites `input.timestamp` with server-received time (`new Date().toISOString()`) immediately after validation, before any downstream use — the client's claimed value is checked for shape but never trusted for scoring. Since this system scores synchronously in real time, server-received and true event time are milliseconds apart for any honest caller, so this costs nothing for legitimate traffic. The DB now stores server-received time, not the client's claim. Tests: `tests/api.test.js`, "a future-dated client timestamp cannot bypass an active structuring alert" and "the stored timestamp is server-received time, not the client-supplied value."
2. **High — an unhandled WebSocket `'error'` event could crash the entire process.** `ws` sockets are `EventEmitter`s; an `'error'` event with no listener throws synchronously, outside any of this app's own try/catch (it's `ws`'s internal dispatch). Neither the `WebSocketServer` instance nor individual client connections had an `'error'` listener — the same failure class already fixed once for `broadcast()`'s `client.send()`, just one level lower (the socket's own error event, not a failed send). **Fix:** added `wss.on('error', ...)` and per-connection `ws.on('error', ...)` in `server/websocket.js`. Test: `tests/websocket.test.js`, which reaches into the real server-side `ws` instance and force-emits an `'error'` event, then confirms the server is still alive and responsive.
3. **Medium/high — the structuring engine's "no prior history" check was bounded to ~45 minutes, not real history.** `backgroundJob.js` fetches transactions within `LOOKBACK_MS` (~45 min, sized for split-detection performance) and `fanOutAnalysis.js`'s "is this receiver new" check was derived from that same bounded set — so two people who've transacted for months would look like a brand-new fan-out receiver the moment the sender did anything resembling a quick burst of transfers to them (e.g. splitting a dinner bill 3 ways), a false positive in the project's core differentiator. **Fix:** `fanOutAnalysis.js` now takes a `priorReceiverIds` Set/array directly (not transaction objects), and `pipeline.js` accepts an injectable `getPriorReceiverIds(senderId, beforeMs)` callback; `backgroundJob.js` supplies a real implementation backed by an unbounded, indexed (`idx_transactions_sender`) per-candidate query — cheap because split candidates are rare, not a full-table scan. Test: `tests/structuring.test.js`, "a genuine long-term contact outside the recent-transactions lookback is not misclassified as a new fan-out receiver."
4. **Medium — no timeout on the ML `python-service` HTTP call.** `mlClient.js`'s `scoreViaHttpService` awaited `fetch()` with no timeout; a hung `ml/serve.py` (a real, documented fallback path, not dead code) could block `POST /transaction` indefinitely. **Fix:** added `signal: AbortSignal.timeout(100)` (well inside the <150ms budget). Test: `tests/ml.test.js`, "a hung python-service backend times out and fails open, instead of hanging" — a raw TCP server that accepts the connection but never responds, confirming resolution within the timeout window.
5. **Medium (conditional on non-default ML mode) — a lost-update race in the running-average calculation.** `updateUserAfterTransaction` read `avg_transaction_amount` in JS, computed the new value, then wrote it back — under `ML_SERVING_MODE=python-service`/`vertex` (genuine async I/O, a real yield point unlike the default `local` mode), two concurrent requests for the same sender could both read the same stale average and have whichever wrote last silently discard the other's contribution. **Fix:** the average update is now a single atomic SQL statement (`avg = avg + (amount - avg) / count`), so each write resolves against SQLite's *current* value rather than a JS-cached one — no data loss even under a race, though the count-based precision can be minutely off under true concurrency (an accepted, documented trade-off, not a data-loss bug anymore). The transaction count is also read fresh (after this transaction's own insert), not carried over from an earlier pre-insert read.
6. **Low/medium — a structuring alert's `total_amount`/`transaction_count` could overstate what its `receiver_ids` actually covers.** When a sender's burst included both an already-known receiver (correctly excluded from `receiver_ids`) and enough new receivers to still trip fan-out, the alert reported totals for the *whole* burst, inflating the human-readable reason CLAUDE.md requires to be accurate. **Fix:** `pipeline.js` now scopes `totalAmount`/`count` to only the transactions going to the flagged (new) receivers. Test: `tests/structuring.test.js`, "alert totals are scoped to only the flagged new receivers, not the whole burst."
7. **Low — the mule-ratio cited in an alert's reason wasn't necessarily true of all cited mules.** `chainTracking.js` used `muleAccounts[0].withdrawalRatio` (`Map` insertion order) as if it were a lower bound, e.g. claiming "2 receivers withdrew over 99%+" when one only reached 85%. **Fix:** use `Math.min(...)` across all cited mules, so the percentage is a true lower bound. Test: `tests/structuring.test.js`, "reason cites the minimum mule ratio, not just the first one encountered."
8. **Low — `simulator/benchmark.js` could crash instead of reporting "0 successful requests."** An empty `transactionIds` array (every request failed) produced an invalid `IN ()` SQL clause; separately, a fully unreachable server crashed the loop entirely (uncaught `fetch` rejection) rather than logging per-request failures. **Fix:** guard against zero successful requests with a clear message and non-zero exit instead of proceeding to broken stats/an invalid query; wrap each request in try/catch so a dropped connection doesn't abort the whole run.

Also fixed while touching this code: the same two bugs from the *previous* review pass (Section 15.1) — the unrealistic simulator GPS jitter and the structuring `windowEnd` bug — remained fixed and were re-verified; no regressions.

`npm test`: 63 tests passing (up from 48), all fixes verified live where practical (forced DB failures, adversarial timestamps, hung TCP servers, real WebSocket error injection) rather than only unit-tested in isolation.

### 15.3 Third pass: WebSocket payload gap affecting the core dashboard, plus two smaller fixes

A further "fix all the issues" request prompted another independent review agent, scoped to the fixes from Section 15.2 and the two new dashboard files (`map.js`, `audit.js`). That agent hit a session/rate limit partway through and terminated early, but it left one confirmed finding before stopping; the rest of this pass was completed manually.

**Agent's finding (fixed):** `dashboard/audit.js`'s throttled live-refresh handler had a comment claiming to keep "the trend chart/table" fresh while the audit tab is open, but only ever called `refreshAuditTable()` — never `refreshAuditSummary()` (the trend chart). The chart only updated on manual tab-open or the Refresh button, not from live traffic. Fixed: the throttled handler now calls both.

**Found manually while verifying the agent's finding (the most significant bug of this pass):** tracing why the trend-chart bug existed led to checking what data the live `sentinelpay:transaction` event actually carries — and it turned out the WebSocket broadcast for `type: "transaction"` was exactly the `POST /transaction` HTTP response shape (`{transaction_id, fraud_score, decision, reasons}`), matching what this document's Section 7 originally specified ("same as POST /transaction response"), but missing `sender_id`, `receiver_id`, `amount`, `timestamp`, `location`, `device_id`, `merchant_id`, `transaction_type` entirely. This is a real bug in the **original Task 9 dashboard**, not just the new features:
- Every row added to the live transactions table via WebSocket (as opposed to the initial `GET /transactions` load) rendered blank `—` placeholders for sender, receiver, amount, and type — `app.js`'s `|| '—'` fallbacks masked this as if it were just "no data" rather than a bug, so it went unnoticed through the original build and both prior review passes.
- `dashboard/map.js` could never plot a single *live* transaction — `plotTransaction()` requires `tx.location`, which was always `undefined` from a WebSocket event. The map only ever showed its one-time historical seed load.

Root cause: this document's own Section 7 documented too minimal a WS contract, and the implementation matched that spec exactly — a spec gap, not a careless implementation deviation. **Fix:** `server/routes/transactions.js`'s WS broadcast now sends the full transaction (everything already available in `input`, at zero extra query cost) alongside the existing response fields; the HTTP response itself is unchanged. Section 7 above updated to document the real contract. Verified two ways: `tests/websocket.test.js`'s new "the transaction broadcast includes full transaction details" test (confirmed to fail with `sender_id: undefined` against the old code, pass against the fix), and a live raw-WebSocket-client check against a running server.

**Found while fixing the above (map.js):** enriching the live broadcast surfaced a latent race in `map.js` that the previous (undefined-`location`, always-skipped) behavior had accidentally been masking: `loadInitialMapData()` fetches the last 200 transactions once, asynchronously, when the Map tab is first opened; if a live transaction arrives over the WebSocket while that fetch is still in flight, it would get plotted immediately by the live handler *and* again when the history fetch resolves (since by then the DB already contains it too) — a duplicate marker. Fixed with a `plottedTransactionIds` Set keyed on `transaction_id`, checked before plotting and cleaned up on marker eviction (so it doesn't grow unbounded past `MAP_MAX_MARKERS`).

`npm test`: 64 tests passing (up from 63).

### 15.4 Fourth pass: systematic feature-by-feature live verification, one more real fix

A "deeply check everything is working and every feature properly" request prompted a full, systematic live walkthrough of every feature in Section 4 (not another code-review agent — direct API/WebSocket testing plus code tracing), one at a time: ingestion validation, each of the 5 rule detectors individually, all 3 decision tiers, the dashboard's static files and DOM-ID wiring, the structuring engine end-to-end, the ML classifier (both modes), the map's data dependencies, and the audit trail's endpoints including boundary/edge cases (`hours=0`, negative values, oversized ranges — all clamp correctly, no crashes).

**Found and fixed:** `GET /transactions?decision=` only handled `req.query.decision` as a string. Express parses a *repeated* query param (`?decision=block&decision=allow`) as an array instead, so `typeof === 'string'` silently failed and the endpoint returned every transaction unfiltered rather than filtering on both values or rejecting the request. This was flagged as a known minor gap during the PR #1 review (Section 15's merge) but not fixed until now. Fixed by normalizing an array into a comma-joined string before the existing parsing logic. Verified live (reproduced the unfiltered-results bug with a real repeated-param request) and with a new regression test in `tests/api.test.js` — confirmed to fail against the pre-fix code (using a step_up transaction excluded from the filter, since testing with only allow/block values wouldn't actually distinguish filtered from unfiltered).

**Noted, not a bug:** the odd-hour rule (`oddHour.js`) cannot be demonstrated live via a quick manual test anymore, now that the client-supplied `timestamp` is always overridden with server-received time (Section 15.2, finding #1). A live demo can't fake "this user has a week of daytime history, now it's 3am" within a few seconds of wall-clock time — which is exactly the intended effect of that security fix, not a regression. The rule itself remains correctly implemented and unit-tested (`tests/rules.test.js`); in real usage, where a user's history genuinely accumulates over real time, it works as designed. Worth knowing before a demo: don't script a live odd-hour trigger — it isn't fakeable by design anymore, and that's the point.

`npm test`: 65 tests passing (up from 64). Full live demo (`--scenario=all`) and the entire verification session produced zero server-side errors, warnings, or unhandled exceptions (checked directly against the server log, not just "tests passed").

---

*Document prepared for Digital Campus 2.0 on Google Cloud — Hack Sprint (24 July 2026). This is the team's single source of truth — keep it up to date as the project evolves.*
