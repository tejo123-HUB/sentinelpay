# SentinelPay
### Real-Time Micro-Transaction Fraud Detection Platform

**Theme:** Fintech | **Event:** Digital Campus 2.0 on Google Cloud — Hack Sprint (24 July 2026)
**Team Members:** [Add names] | **Team Leader:** [Add name]
**Build deadline:** 21 July 2026

---

## 1. Project Overview

SentinelPay is built for **a merchant business's own senior risk/compliance team** — not a bank, and not a consumer-facing app. A merchant (an online store, marketplace, or subscription business) takes payments through several payment gateways (Stripe, Razorpay, PayPal, etc.), issues refunds and payouts back out through those same gateways, and needs one place to watch all of that money movement for fraud and money laundering — something no single gateway's own dashboard can show, since each only sees its own slice of traffic. Most fraud detection systems were also built for high-value, low-frequency transactions, not the flood of low-value, high-frequency micro-transactions that now dominate digital commerce; they're either too slow to catch fraud before money moves, or too resource-heavy to run at the scale micro-transactions demand.

**SentinelPay** is a lightweight, horizontally scalable fraud-detection API purpose-built for micro-transactions. It wires into every payment gateway the business uses, sitting between those gateways and the settlement layer, analyzing transaction metadata — velocity, geography, device fingerprint, and behavioral history — in real time, and returns a fraud-risk decision in milliseconds: **allow, challenge (step-up authentication), or block**.

Rather than relying on a single black-box model, SentinelPay combines fast rule-based signal detection with a machine learning scoring layer, so it can be demoed reliably even under hackathon time constraints while still showcasing genuine ML-driven intelligence. It also goes beyond single-transaction analysis: a dedicated graph engine tracks money as it moves *across* accounts, catching structuring and layering patterns — where a large sum is deliberately split into small transfers, fanned out across multiple accounts, and quickly withdrawn — that transaction-by-transaction fraud checks miss entirely, even when that activity is dressed up as ordinary customer payments, refunds, or vendor payouts flowing through the business.

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
- Rule-only systems create too many false positives, frustrating genuine customers.
- ML-only systems are often too slow or too costly to run at micro-transaction scale and volume.
- Fraud patterns (impossible travel, velocity abuse, device spoofing) need to be caught **before** settlement, not after in a batch job.
- A merchant using several payment gateways has no single view across them — each gateway's own dashboard only shows its own slice of the business's traffic, so laundering that spreads activity across gateways can hide in the gaps between them.
- Sophisticated actors evade single-transaction fraud checks entirely by **structuring**: splitting a large sum into many small transfers (often disguised as ordinary customer payments, refunds, or vendor payouts), fanning them out across multiple accounts, then withdrawing quickly — a pattern invisible to systems that only look at one transaction at a time.

## 3. Proposed Solution

A real-time scoring API that:
1. Ingests transaction metadata the instant a payment is initiated.
2. Runs fast rule-based checks (sub-10ms) for obvious red flags.
3. Checks (via fast indexed lookup) whether this account is already part of a known structuring/laundering pattern.
4. Runs a scoring model — rule-based today, ML-assisted once trained — for nuanced behavioral scoring.
5. Combines all signals into a single fraud score.
6. Returns a decision instantly to whichever of the business's payment gateways originated the transaction: allow, step-up authentication, or block.
7. Logs everything for a live monitoring dashboard and audit trail, and runs a periodic background job to detect new cross-account structuring patterns.

---

## 4. Feature List

### 4.1 Core Features (MVP)

1. **Transaction Ingestion API**
   REST endpoint accepting `sender_id`, `receiver_id`, `amount`, `timestamp`, `location`, `device_id`, `merchant_id`, `purpose`, and `transaction_type` (transfer / withdrawal / deposit) for every incoming transaction. `sender_id`/`receiver_id` are directional, not role-fixed: on an ordinary payment the customer is `sender_id` and the merchant is `receiver_id`; on a refund/payout the merchant is `sender_id` and the customer is `receiver_id`. `merchant_id` identifies which of the business's own payment-gateway accounts (Stripe/Razorpay/PayPal, etc.) the transaction was ingested from — the field that makes cross-gateway aggregation visible. `purpose` is an optional human-readable note, mainly populated on merchant-initiated outgoing transactions (refunds, payouts, vendor settlements), for analyst context — not a scoring input. Including `sender_id`/`receiver_id` from day one is required for structuring detection — it must not be bolted on later.

2. **Rule-Based Fraud Signal Engine — outbound-only.** Fraud/AML behavioral scoring only runs when `sender_id` is a registered business account (`business_accounts` table, editable from the dashboard's Business Accounts strip — see Section 6/7) — i.e. money *leaving* the business. A customer paying the business is not scored at all: a stolen card used to pay a merchant is the card network's/payment gateway's problem (CVV, 3D-Secure, chargebacks), not money laundering or theft of the business's own funds, and this system is scoped to the latter. The one universal exception is the structuring-alert fast lookup (item 6, below) — a known laundering ring is still blocked regardless of which direction it's transacting, since that's enforcement of an already-detected pattern, not behavioral scoring.

   Five general-purpose detectors (run against the business account's own history):
   - **Velocity Check** — flags an account exceeding a transaction-per-second/minute threshold.
   - **Impossible Travel Detection** — flags geographically implausible transaction pairs (e.g., two cities within minutes).
   - **Amount Anomaly Detection** — flags transactions deviating significantly (>3x) from the account's rolling average spend.
   - **Device/IP Fingerprint Mismatch** — flags transactions from previously unseen devices or IPs for a given account.
   - **Odd-Hour Behavioral Spike** — flags activity outside the account's typical active hours.

   Four outbound-specific detectors (`server/rules/`, run against `server/outboundContext.js`'s query results — a longer 90-day lookback than the five above, since refunds/vendor relationships can span months, plus a short 10-minute burst window for the fan-out check):
   - **Refund Without Purchase** (`refundWithoutPurchase.js`) — a refund-purpose payment with no (or insufficient) matching prior purchase from that customer at this business account — the "fake refund" laundering pattern.
   - **Payout to New Receiver** (`payoutToNewReceiver.js`) — a non-refund payout to a receiver this business account has never paid before, once it has enough history to have a baseline.
   - **Outbound Ratio Anomaly** (`outboundRatioAnomaly.js`) — rolling outbound total badly outpacing rolling inbound revenue in the same window — money leaving with no legitimate revenue basis for it.
   - **Outbound Fan-Out Burst** (`outboundFanOutBurst.js`) — 3+ distinct new receivers paid within a 10-minute window — a fast, synchronous companion to the deferred structuring background job (item 6), catching a compromised-account drain immediately rather than waiting for the next 5–10s scan cycle.

3. **Fraud Scoring & 3-Tier Decision Layer**
   - Combines rule signals + structuring-alert lookup + ML score into a single 0–100 fraud score, then (for outbound transactions only) an amount-based restrictor: `server/outboundRestrictor.js` floors the score at the step-up threshold when the transaction exceeds `MAX_OUTBOUND_WITHOUT_REVIEW` (₹25,000), regardless of what rules/ML alone produced — mirroring `scoring.js`'s existing structuring-alert floor.
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

### 4.3 21-Feature Extension (Section 15.16) — status tracked here, design detail in the dev log

The full spec (verbatim) and design rationale live in Section 15.16; this table is the canonical status list this doc's own anti-drift rule requires — updated in the same commit as each feature lands, not after the fact.

| # | Feature | Status | Where it lives |
|---|---|---|---|
| 1 | Refund Account Mismatch Detection | ✅ built | `server/rules/refundAccountMismatch.js` |
| 2 | Multiple Refund Detection | ✅ built | `server/rules/multipleRefundDetection.js` |
| 3 | Improve Existing Refund Validation | ✅ built | `server/rules/refundWithoutPurchase.js` (reference-based path) |
| 4 | Merchant Account Takeover Detection | ✅ built | `server/rules/merchantAccountTakeover.js`, `POST/GET /merchant-logins` |
| 5 | New Vendor Risk Detection | ✅ built | `server/rules/newVendorRisk.js` |
| 6 | Circular Money Flow Detection | ✅ built | `server/structuring/circularFlow.js`, wired into `backgroundJob.js` |
| 7 | Split Refund Detection | ✅ built | `server/rules/splitRefundDetection.js` |
| 8 | Friendly Fraud Detection | ✅ built | `server/rules/friendlyFraud.js`, `POST/GET /disputes` |
| 9 | Refund Velocity Detection | ✅ built | `server/rules/refundVelocity.js` |
| 10 | Employee Fraud Detection | ✅ built | `server/rules/employeeFraud.js` |
| 11 | Cross Gateway Fraud Detection | ✅ built | `server/rules/crossGatewayStructuring.js` |
| 12 | Dormant Account Detection | ✅ built | `server/rules/dormantAccountReactivation.js` |
| 13 | Mule Account Detection | ✅ built | `server/muleScore.js` + `server/rules/muleReceiverRisk.js` |
| 14 | Geo Risk Scoring | ✅ built | `server/rules/geoRisk.js` |
| 15 | Advanced Merchant Risk Dashboard | ✅ built | new "Analytics" tab (`dashboard/analytics.js`) + dark mode (`app.js`/`style.css`) |
| 16 | Risk Scoring Engine (weights + critical force-block) | ✅ built | `server/scoring.js`'s `CRITICAL_SEVERITY_FLOOR` |
| 17 | Fraud Explainability (severity on every detector) | ✅ built | `severity` backfilled onto all 13 detectors; `POST /transaction` and `GET /transactions` return `severity` + `risk_breakdown` |
| 18 | Analytics endpoints | ✅ built | `server/routes/analytics.js` |
| 19 | Configuration (no magic numbers) | ✅ built | `server/config.js` |
| 20 | Testing (100% detector coverage) | 🔄 ongoing | every feature above ships with unit + integration tests as it lands; a final coverage sweep is still pending |
| 21 | Documentation | 🔄 ongoing | this section + Section 15.16, updated per phase as each feature lands; a final consistency pass is still pending |

All 21 features are now built and merged with passing tests. Feature 20 (100% detector coverage) and Feature 21 (documentation) are ongoing consistency passes, not new functionality — see below.

**Feature 15 design note:** a fourth dashboard tab, "Analytics" (`dashboard/analytics.js`, `dashboard/index.html`), consumes every Feature 18 endpoint: an 8-stat overview row (reusing the existing `.stat-card` component), a trend chart with an hour/day/week/month bucket selector (Chart.js, same pattern as `audit.js`'s existing trend chart), a fraud heatmap (hour-of-day × day-of-week, computed client-side from a bounded `/analytics/export` call — a plain CSS-grid heatmap, sequential single-hue ramp per the dataviz skill's convention, not a new charting dependency), a dimension-selectable "Top Risky" table, top fraud categories, top mule accounts, gateway comparison, and CSV/PDF export (CSV via a blob download; PDF via the browser's native print-to-PDF against a `@media print` stylesheet that isolates the Analytics panel — no server-side PDF library, keeping this project's two-dependency-only convention). Dark mode (`app.js`'s `initThemeToggle`) applies site-wide via a `[data-theme="dark"]` CSS override block reusing the exact palette values already validated by the dataviz skill in the project's original dark theme (Section 15.8) — every existing component (all three prior tabs) inherits it for free since the whole stylesheet is already custom-property-driven.

**Bug found and fixed while visually verifying the dashboard in a browser:** the business's own registered account showed up in the "Top Mule Accounts" panel. A merchant receiving customer payments and paying them back out (refunds, settlements, vendor payouts) is normal operation, but technically satisfies `computeMuleScore`'s generic receive-then-quickly-drain heuristic by construction — the detector had no notion of "this receiver is the business itself." Fixed in two places: `getOutboundContext`'s `receiverMuleScore` field now short-circuits to a non-mule result for any registered `business_accounts` entry (so `muleReceiverRisk.js` never flags a business account either), and `GET /analytics/mule-accounts` excludes business accounts from its candidate scan. Caught only by opening the dashboard in Chrome with seeded demo data — none of the unit/integration tests had a fixture combining "business account" with "receive-then-refund" activity. Two regression tests added (`tests/outboundContext.test.js`, `tests/analytics.test.js`) reproducing the exact live scenario.

**Feature 18 design note:** `server/routes/analytics.js` adds `GET /analytics/summary`, `top-frauds`, `top-risky` (one generic endpoint parameterized by `dimension`, covering all of customers/merchants/employees/vendors/devices/IPs/countries rather than seven near-identical routes), `mule-accounts`, `gateway-comparison`, `trend` (generalizes the existing `/audit/summary` to hour/day/week/month buckets), and `export` (CSV or JSON; no server-side PDF generation — the dashboard's PDF export button renders client-side from this JSON, keeping this project's dependency-light convention). All read-only, all reuse the existing `transactions`/`flags` tables — no new tables. `transactions.latency_ms` (new nullable column) is measured via `process.hrtime.bigint()` around each `POST /transaction` request, purely for the `avg_latency_ms` analytics stat — not a scoring input, and distinct from `simulator/benchmark.js`'s own separate, more rigorous latency measurement (Section 11, Risk 3).

**"Recovered amount," precisely defined:** this system has no post-decision recovery workflow to observe (no chargeback-resolution event, no "money actually got back" signal) — `recovered_amount` is the total value of transactions that scored `fraud_score >= 40` (step-up/block-tier risk) but were not ultimately blocked, i.e. money a step-up challenge plausibly kept from being lost. Documented here so the number is never mistaken for an audited recovery figure.

**Bug found and fixed while testing Feature 18:** `server/muleScore.js`'s outflow query used a strict `timestamp >` lower bound — the same same-millisecond race class fixed twice already in this extension (Section 15.13, and the merchant-login-takeover query above). A receipt immediately followed by its outflow (the exact pattern this function exists to detect) can land on the same millisecond, and the strict bound silently excluded that outflow from the withdrawal ratio, undercounting a genuine mule pattern. Caught by `tests/analytics.test.js`'s new mule-accounts end-to-end test failing on a fast local run. Fixed by using `>=` instead of `>` — safe because a row can never be both the receipt and the outflow for the same account (`validate.js` enforces `sender_id != receiver_id`). Regression test added directly against `computeMuleScore` with two rows forced to an exact timestamp tie.

**Feature 16/17 design note:** `scoring.js` gained `CRITICAL_SEVERITY_FLOOR` (85, above the block threshold) — any flagged rule carrying `severity: 'Critical'` (merchant account takeover, suspected mule receiver) floors the score there, the same explicit-floor pattern as the pre-existing `STRUCTURING_ALERT_FLOOR`, rather than a second implicit mechanism. Circular laundering and known structuring/fraud rings were already covered by `STRUCTURING_ALERT_FLOOR` (any active `structuring_alerts` row, direct or circular) with zero changes needed. `computeFraudScore` now also returns `riskBreakdown` (one `{type, reason, weight, severity}` entry per contributing signal, including the structuring alert and — when it fires — the outbound-amount restrictor) and an overall `severity` (the highest-ranked contributing signal, `'None'` if nothing flagged); both are surfaced in `POST /transaction`'s response and `GET /transactions`'s rows. `flags.severity` (new nullable column) persists each flag's severity so `GET /transactions` can reconstruct it without re-running detectors. All 13 detectors (the original 9 plus the 4 refund-integrity ones from Phase B, which already had severity) now carry a severity, backfilled without changing any existing detector's flagging logic or weight.

**Bug found and fixed while wiring Feature 4/16:** `getOutboundContext`'s new merchant-login-takeover query used a strict `timestamp <` boundary to find "the login before the most recent one" — the same class of same-millisecond race already fixed once in this file (Section 15.13, finding #3) for the refund-context queries, reintroduced here in new code. Two `POST /merchant-logins` calls fired fast enough (a loaded test suite, or a real seed script) can land on the same millisecond; the strict comparison then silently excluded the earlier login entirely, leaving `takeoverRisk` null and the takeover flag never firing. Caught by the full test suite flaking under load, not by the individual test file run in isolation. Fixed by using SQLite's implicit `rowid` (unique even when timestamps tie) as the ordering/exclusion key instead of `timestamp` alone — `ORDER BY timestamp DESC, rowid DESC` and `rowid != ? AND timestamp <= ?` rather than a plain `timestamp <`. Verified with a regression test that inserts two logins at the exact same timestamp and confirms the correct one is still identified as "previous," plus 5 consecutive clean full-suite runs after the fix (previously flaky under load).

**Feature 6 design note:** circular-flow alerts reuse the existing `structuring_alerts` table and the existing fast per-transaction lookup (`alertLookup.js`) with zero changes to either — a cycle is stored with `sender_id` = the origin business account and `receiver_ids` = the intermediate hop accounts, which `alertLookup.js`'s existing sender-match/receiver-membership checks already cover for any future transaction touching any account in the cycle. This is the "reuse existing graph engine" requirement satisfied structurally, not just in spirit: no parallel alert mechanism, no new scoring-floor logic (the existing `STRUCTURING_ALERT_FLOOR` already forces block once any structuring alert — split/fan-out or circular — is active for an account). The detector itself (`server/structuring/circularFlow.js`) is a pure DFS over a 24h-lookback transaction graph, bounded to `CIRCULAR_FLOW.MAX_CYCLE_HOPS` (3) intermediate hops, run from the background job (not per-transaction — too expensive, same reasoning as the existing split/fan-out detectors) against the business's own registered accounts as cycle origins.

---

## 5. GCP Architecture

```
                     ┌─────────────────────────┐
                     │  Payment Gateways        │
                     │  (Stripe/Razorpay/etc.) /│
                     │  Transaction Simulator   │
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
  merchant_id TEXT,                 -- which of the business's payment-gateway accounts this came from
  purpose TEXT,                     -- note on outgoing merchant-initiated transactions (refunds, payouts)
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

**Schema change (merchant/multi-gateway reframe):** added `purpose TEXT` (nullable) to `transactions` — a pure addition, same as `reason` above, not a retrofit of `sender_id`/`receiver_id`. Mainly populated on merchant-initiated outgoing transactions (refunds, payouts, vendor settlements) as analyst-facing context, not a scoring input.

**Schema change (dashboard ID-column collapse):** added a new table, `business_accounts (account_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)` — the dashboard's editable registry of the business's own account IDs (see Section 7's `/business-accounts` routes), used to resolve which side of a `sender_id`/`receiver_id` pair is the customer. No FK to `users`, deliberately: an ID can be registered before or independent of having any transactions.

**Schema changes (Section 15.16, 21-feature extension):** `transactions` gains four nullable columns — `reference_transaction_id` (links a refund to the purchase it refunds), `employee_id` (which staff member initiated a merchant-side transaction), `country`, `ip_address` (geo-risk scoring). Two new tables: `merchant_login_events` (merchant login metadata for takeover detection, Feature 4, including a `country` column) and `disputes` (chargeback/dispute events for friendly-fraud scoring, Feature 8), both indexed on their lookup key. `flags` gains a nullable `severity` column (Feature 17). All pure additions — see Section 15.16 for the full rationale and which feature each backs.

**Important:** `sender_id` and `receiver_id` must exist from the very first schema migration — do not add them later; the structuring detector depends on them from day one. They're directional, not role-fixed: on an ordinary payment the customer is `sender_id` and the merchant is `receiver_id`; on a refund/payout the merchant is `sender_id` and the customer is `receiver_id`.

**Implementation note (Task 2):** `server/db.js` adds two extra indexes beyond the ones listed above — `idx_flags_transaction` on `flags(transaction_id)` and `idx_structuring_alerts_sender` on `structuring_alerts(sender_id)` — both pure lookup-performance additions with no schema/column changes, needed for the fast per-transaction structuring-alert lookup (Task 6) and for fetching flags per transaction. The `users.avg_transaction_amount` running average (Task 3) is maintained using an indexed `COUNT(*)` over `transactions` for the per-user transaction count rather than adding a redundant `transaction_count` column to `users`.

**Implementation note (Section 15.6):** `server/db.js` adds a third index, `idx_structuring_alerts_created_at` on `structuring_alerts(created_at)` — `alertLookup.js`'s receiver-side check and the background job's re-alert cooldown check both filter/order by `created_at` with no supporting index before this; fine at demo-table sizes, but a full scan waiting to happen at real volume. Pure performance addition, no schema/column change.

---

## 7. API Contract

**Authentication (Section 15.6):** every route below except `GET /health` requires a shared-secret
`X-API-Key` header (the WebSocket takes it as a `?apiKey=...` query param instead — browsers can't
set custom headers on a WS handshake). Missing or wrong key -> `401`. See `server/middleware/
apiKeyAuth.js` and Section 15.6 for why this was added and its documented demo-only limitation
(the dashboard page itself is handed the key at load time, since there's no login system in this
build). Requests are also rate-limited per IP (`server/middleware/rateLimit.js`, default 2000/60s
across all routes) -> `429` once exceeded.

### `POST /transaction`
Accepts a single transaction and returns a decision **synchronously** — scoring (rules + structuring lookup + ML) happens within the same request/response cycle. There is no async/polling pattern in this project. `amount` must be a positive finite number, capped at `MAX_AMOUNT` (10,000,000 — a sanity bound added in Section 15.6, well above any plausible transaction here, including a whole structuring burst).

`sender_id`/`receiver_id` are directional, not role-fixed: the paying party (a customer, or the merchant itself on a refund/payout) is `sender_id`, and the receiving party (the merchant, or the customer on a refund) is `receiver_id`. `merchant_id` (optional) identifies which of the business's own payment-gateway accounts (Stripe/Razorpay/PayPal, etc.) the transaction was ingested from. `purpose` (optional, max 256 chars) is a human-readable note, mainly populated on merchant-initiated outgoing transactions (refunds, payouts, vendor settlements) for analyst context — it is not a scoring input.

**New optional fields (Section 15.16):** `reference_transaction_id` (the specific purchase a refund is refunding — powers Features 1/3/7's account-mismatch/purchase-validation/split-refund checks, sharper than the purpose-string/customer-aggregate fallback used when it's omitted), `employee_id` (which internal staff member initiated a merchant-side transaction — Feature 10), `country`/`ip_address` (geo-risk scoring — Feature 14). All four are pure additions, analyst/detection context only, never required.

**Request body (ordinary customer payment):**
```json
{
  "sender_id": "u_123",
  "receiver_id": "m_store_electronics",
  "amount": 250.00,
  "timestamp": "2026-07-18T10:15:00Z",
  "location": { "lat": 16.5062, "lng": 80.6480 },
  "device_id": "d_789",
  "merchant_id": "stripe_acct_primary",
  "transaction_type": "transfer"
}
```

**Request body (merchant-initiated refund):**
```json
{
  "sender_id": "m_store_electronics",
  "receiver_id": "u_123",
  "amount": 250.00,
  "timestamp": "2026-07-18T10:15:00Z",
  "merchant_id": "stripe_acct_primary",
  "purpose": "Refund - order #482913",
  "transaction_type": "transfer"
}
```

**Response body:**
```json
{
  "transaction_id": "t_abc123",
  "fraud_score": 87,
  "decision": "block",
  "severity": "High",
  "reasons": [
    "3 transactions in 10 seconds",
    "412 km location jump from last transaction"
  ],
  "risk_breakdown": [
    { "type": "velocity", "reason": "3 transactions in 10 seconds", "weight": 35, "severity": "Medium" },
    { "type": "impossible_travel", "reason": "412 km location jump from last transaction", "weight": 40, "severity": "High" }
  ]
}
```
**`severity`/`risk_breakdown` (Section 15.16, Feature 17):** `severity` is the highest-ranked severity (`Low`/`Medium`/`High`/`Critical`) among every contributing signal, `None` if nothing was flagged. `risk_breakdown` gives per-signal detail (detector name, reason, weight, severity) beyond the flat `reasons` array, which is kept unchanged for backward compatibility. `GET /transactions` returns the same two fields per row, reconstructed from the `flags` table's new `severity` column.

### `GET /transactions?limit=50&decision=block,step_up`
Returns recent transactions with their decisions and flag reasons, for the dashboard's live table and the Task 11 audit trail. `decision` (optional, comma-separated, one or more of `allow`/`step_up`/`block`) filters the results — added when building the audit trail (Section 15.2).

### `GET /alerts`
Returns active structuring/layering alerts (grouped, not per-transaction).

### `GET /business-accounts`, `POST /business-accounts`, `DELETE /business-accounts/:accountId`
The dashboard's editable registry of the business's own account IDs. There's no schema flag marking an ID as "the business" vs. "a customer" — `merchant_id` identifies which *gateway* a transaction came through, not which party in `sender_id`/`receiver_id` is the business. This registry is what lets the dashboard collapse the Sender/Receiver pair into a single "ID" column showing only the customer: `GET` returns `[{ account_id, created_at }, ...]`; `POST { account_id }` registers one (`INSERT OR IGNORE` — re-adding is a no-op, not an error); `DELETE /business-accounts/:accountId` removes one (idempotent — removing an unregistered ID still returns `204`). Analyst-facing only, like `purpose`/`merchant_id` — not a scoring input.

### `POST /merchant-logins`, `GET /merchant-logins?merchant_id=...&limit=20` (Section 15.16, Feature 4)
Ingests merchant login/session metadata (`merchant_id`, `device_id`, `browser`, `os`, `ip_address`, `location`, `country`, optional `timestamp`) used by `merchantAccountTakeover.js` to detect an unrecognized-device login shortly before a refund/payout/settlement. Same trust model as `POST /transaction` — a backend-to-backend integration point (in production, sourced from the business's own auth/session system), not something end users call. Unlike `POST /transaction`, a caller-supplied `timestamp` is honored rather than overridden, since seed/demo data legitimately needs to backdate login history and this endpoint moves no money.

### `POST /disputes`, `GET /disputes?customer_id=...&limit=50` (Section 15.16, Feature 8)
Ingests chargeback/dispute events (`transaction_id` optional, `customer_id`, `dispute_type`) used by `friendlyFraud.js` to score repeat-dispute customers. In production this would arrive via a payment gateway's chargeback webhook; here it's a directly-callable ingestion endpoint, same trust model as the routes above.

### `GET /analytics/*` (Section 15.16, Feature 18)
`summary` (overview stat-card totals), `top-frauds?limit=` (most common flag types), `top-risky?dimension=customers|merchants|employees|vendors|devices|ips|countries&limit=`, `mule-accounts?limit=`, `gateway-comparison`, `trend?bucket=hour|day|week|month&lookbackHours=`, `export?format=csv|json&limit=`. All read-only, all `requireApiKey`. See Section 15.16 for field-level detail and the "recovered amount" definition.

### `GET /fraud-lists?list_type=`, `POST /fraud-lists`, `DELETE /fraud-lists/:entryId` (Section 16, Categories 19/21)
The blacklist/whitelist/watchlist registry. `POST { list_type: 'blacklist'|'whitelist'|'watchlist', account_id, reason? }` — not `INSERT OR IGNORE` like `business_accounts`: the same account can validly appear more than once over time (e.g. watchlisted, then later confirmed and blacklisted), so `entry_id` is the primary key, not `(list_type, account_id)`. `DELETE` is idempotent. Checked on **every** transaction regardless of direction (`server/fraudLists.js`'s `checkFraudLists`, called alongside the structuring-alert lookup in `routes/transactions.js`) — a blacklisted account is a confirmed bad actor whether it's paying the business or being paid by it. Precedence in `scoring.js`: an active structuring alert or a blacklist entry always forces block; a whitelist entry only reduces the score when neither of those apply, and never overrides a Critical-severity rule flag (merchant takeover, suspected mule) even on an otherwise-trusted account; a watchlist entry just adds `WATCHLIST_WEIGHT` (15) and a reason, never forcing an outcome.

### `GET /audit/summary?hours=24&bucketMinutes=60`
Task 11 (audit trail): time-bucketed counts of `allow`/`step_up`/`block` over the given lookback window, for the trend chart. Added in Section 15.2. Returns `{ hours, bucketMinutes, totalTransactions, buckets: [{ bucket_start, allow, step_up, block }, ...] }`.

### WebSocket `/ws`
Broadcasts every processed transaction and every new structuring alert to connected dashboard clients as they happen:
```json
{ "type": "transaction", "data": { "transaction_id": "...", "fraud_score": ..., "decision": "...", "reasons": [...], "sender_id": "...", "receiver_id": "...", "amount": ..., "timestamp": "...", "location": { "lat": ..., "lng": ... }, "device_id": "...", "merchant_id": "...", "purpose": "...", "transaction_type": "..." } }
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
- `server/middleware/apiKeyAuth.js`, `server/middleware/rateLimit.js`, `server/middleware/securityHeaders.js` — added in Section 15.6's security review pass: shared-secret API key auth, per-IP rate limiting, and response security headers, all hand-rolled (no new npm dependencies) to match this project's dependency-light conventions.
- `tests/userProfile.test.js`, `tests/rateLimit.test.js` — additional test coverage added alongside Section 15.6 (the bounded/narrowing `typical_active_hours` fix, and the rate limiter).
- **Section 15.16 (21-feature extension) additions:** `server/config.js` (Feature 19); `server/muleScore.js` (Feature 13); `server/structuring/circularFlow.js` (Feature 6); `server/routes/merchantLogins.js`, `server/routes/disputes.js`, `server/routes/analytics.js` (Features 4/8/18); thirteen new files in `server/rules/` (Features 1/2/4/5/7/8/9/10/11/12/13/14 — see Section 4.3 for the full mapping); `dashboard/analytics.js` (Feature 15); `tests/newIngestionRoutes.test.js`, `tests/analytics.test.js` (new test files, same one-file-per-concern convention as `tests/rateLimit.test.js`/`tests/userProfile.test.js` above).

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

**Noted, not a bug (at the time):** the odd-hour rule (`oddHour.js`) could no longer be demonstrated live via a quick manual test, now that the client-supplied `timestamp` is always overridden with server-received time (Section 15.2, finding #1). A live demo can't fake "this user has a week of daytime history, now it's 3am" within a few seconds of wall-clock time — the intended effect of that security fix, not a regression. Addressed in Section 15.5 below.

`npm test`: 65 tests passing (up from 64). Full live demo (`--scenario=all`) and the entire verification session produced zero server-side errors, warnings, or unhandled exceptions (checked directly against the server log, not just "tests passed").

### 15.5 Making the odd-hour rule demonstrable live again, without reopening the timestamp fix

A follow-up request to fix the odd-hour demo gap noted in Section 15.4. The constraint: the fix must not weaken or bypass the Section 15.2 timestamp-security fix (`POST /transaction` scoring against server-received time, not a client claim) — that fix closed a real vulnerability and stays exactly as-is.

**Approach:** a new `--scenario=odd-hour` in `simulator/simulate_transactions.js` seeds a demo account's `typical_active_hours` baseline directly into the SQLite database — bypassing `POST /transaction` entirely, the same way a real account's baseline would only exist after real accumulated usage over real time, never something the API itself lets a caller assert. It picks a baseline window (one of two fixed 8-hour UTC ranges) that provably excludes whatever the actual current hour is when the scenario runs, so the demo is reliable regardless of time zone or time of day. It then sends exactly **one** transaction through the unmodified, real `POST /transaction` API at genuine current time. The odd-hour check itself runs completely unchanged against real server time; only how the account's pre-existing history came to exist differs from organic usage — which is unavoidable for *any* single-command demo of a rule whose whole premise is "history accumulated over real time," not a compromise specific to this fix.

Verified live, twice in a row (fresh random account each run, matching the existing fraud/structuring scenario pattern): the transaction is correctly flagged with `"Transaction at HH:00 UTC is outside this user's typical active hours"`. Also verified: the overall decision stays `allow` (score ~32), because `odd_hour` is deliberately the weakest single rule weight (`server/rules/oddHour.js`) — a lone mild signal shouldn't challenge/block a user by design. That's correct, expected scoring behavior, not a shortcoming of this fix; the scenario's console output now explains this explicitly so it doesn't read as a failure. `--scenario=all` includes it as a fourth step.

`npm test`: 65 tests (unchanged — this is a simulator/demo-tooling addition, not a scoring-pipeline change, so no new server-side behavior needed a new test; the existing `oddHour.js` unit tests already cover the rule's own logic, and this addition was verified through direct live execution instead).

### 15.6 Fifth review pass: full-project security/quality audit, all findings fixed

A "check for all vulnerabilities and errors and problems, like a senior developer" request prompted an independent, full-codebase read (every server/dashboard/ML/simulator/test file, not a diff) explicitly looking past the four prior review passes above for anything they hadn't caught. Findings, most severe first, all fixed on this branch with regression tests:

1. **Critical — no authentication on any endpoint.** `POST /transaction`, `GET /transactions`, `GET /alerts`, and `GET /audit/summary` had zero auth: anyone who could reach the server could read every user's transaction history (sender/receiver IDs, exact GPS location, amount, device ID) and inject arbitrary transactions. **Fix:** `server/middleware/apiKeyAuth.js` — a shared-secret `X-API-Key` header required on every route except `GET /health`, checked with `crypto.timingSafeEqual`. The WebSocket (`/ws`) takes the same key as a `?apiKey=...` query param instead, checked in `verifyClient` before the upgrade completes, since browsers can't set custom headers on a WS handshake — `server/websocket.js`. **Documented trade-off, not glossed over:** this hackathon build has no login system, so the dashboard can't hold the key server-side behind real user auth the way a production deployment would (PROD: real SSO/session + a backend-for-frontend holding the key — DEMO noted inline in `apiKeyAuth.js` and `.env.example`). Instead `server/index.js` hands the key to the dashboard page itself via a `<meta>` tag injected at serve time (`serveDashboardIndex`), so anyone who loads the dashboard can read the key from its own page source — an accepted limitation of a login-free demo UI, not a secret being kept from that page's own viewer. What it *does* stop: anonymous traffic that never engages with this application's UI/API at all (internet scanners, drive-by bots, casual scraping). If `API_KEY` isn't set in `.env`, the server and the simulator/benchmark CLI tools fall back to the same published, insecure `DEFAULT_DEV_API_KEY` constant (with a loud startup warning) so they can still interoperate for pure localhost demo use without any setup step — anything reachable beyond localhost must set a real key. Tests: `tests/api.test.js` (401 with no/wrong key, `/health` stays open), a live end-to-end check (server + simulator + a raw WebSocket client, all verified manually against a running instance).
2. **High — no rate limiting.** Nothing throttled `POST /transaction` or any other route — trivial to flood, with no auth in place (finding 1) or even after it (an authenticated caller, or one brute-forcing the key, could still hammer the endpoint). **Fix:** `server/middleware/rateLimit.js`, a small dependency-free per-IP sliding-window limiter (matching this project's minimal-dependency conventions — no `express-rate-limit`), default 2000 requests/60s across all API routes, configurable via `RATE_LIMIT_MAX_PER_MINUTE`. Sized generously so it never interferes with real demo traffic (the simulator's continuous stream, the 500-request benchmark run) while still meaningfully blocking a flood. Verified live: a 60-request benchmark run and the full `--scenario=all` simulator flow both completed with zero 429s. Tests: `tests/rateLimit.test.js`.
3. **Medium — `typical_active_hours` recomputed from a sender's entire lifetime history, unbounded, on every transaction.** `userProfile.js`'s `computeTypicalActiveHoursRange` ran `SELECT timestamp FROM transactions WHERE sender_id = ?` with no `LIMIT`, and re-ran on *every* transaction once a sender passed `MIN_HISTORY_FOR_ACTIVE_HOURS` — an O(n) query per request growing without bound as a power user's transaction count grew, at odds with this system's real-time latency claims. Worse, the range was `[min(hour), max(hour)+1)` over all-time history, so it could only ever widen, never narrow: a single early off-hour transaction (even a genuine one-off) permanently "unlocked" that hour from ever tripping `oddHour.js` again — a soft evasion vector for a patient attacker. **Fix:** bounded to a rolling `ACTIVE_HOURS_LOOKBACK_MS` (30 days) with an `ACTIVE_HOURS_SAMPLE_LIMIT` (1000 rows) cap, so query cost is capped regardless of lifetime volume and an old outlier hour eventually ages back out of the baseline. Tests: `tests/userProfile.test.js` — an old outlier is excluded, a recent one still widens the range, and `updateUserAfterTransaction` recomputes correctly end-to-end.
4. **Low — no upper bound on `amount`.** Only checked `> 0` and finite; a pathological value (e.g. `1e300`) passed straight through into `avg_transaction_amount` and every dashboard total. **Fix:** `MAX_AMOUNT = 10,000,000` in `server/validate.js` (Section 7 updated). Tests: `tests/validate.test.js`, `tests/api.test.js`.
5. **Low — missing SRI hashes and security headers.** The dashboard's CDN `<script>`/`<link>` tags (Chart.js, Leaflet) had no Subresource Integrity hashes — a compromised or MITM'd jsdelivr response could have swapped in arbitrary JS with no browser-side warning. Chart.js was also pulled from an unpinned `@4` floating tag. **Fix:** `dashboard/index.html` now pins exact versions (`chart.js@4.5.1`, `leaflet@1.9.4`) with `integrity`/`crossorigin` attributes — SHA-384 hashes computed directly from the fetched files, not copied from memory. `server/middleware/securityHeaders.js` adds `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and a `Content-Security-Policy` scoped to `'self'` plus the jsdelivr/OpenStreetMap-tile hosts the dashboard actually needs. Verified live via `curl -I`.
6. **Low — `structuring_alerts` had no index on `created_at`.** `alertLookup.js`'s receiver-side scan and the background job's re-alert cooldown check both filter/order by `created_at` with no supporting index — fine at demo-table sizes, a full scan waiting to happen at real volume. **Fix:** `idx_structuring_alerts_created_at` added in `server/db.js` (Section 6 updated).
7. **Low — `ml/serve.py`'s fallback server was single-threaded.** Plain `HTTPServer` processes one `/predict` request at a time; under concurrent load (a real, documented fallback path for `ML_SERVING_MODE=python-service`, not dead code), requests would queue and were more likely to blow `mlClient.js`'s 100ms fetch timeout than necessary. **Fix:** switched to `ThreadingHTTPServer` — safe here since `Handler.model` is loaded once before `serve_forever` and never mutated afterwards.

What the audit confirmed was already solid and left untouched: no SQL injection anywhere (every query is parameterized, including the dynamically-built `IN (...)` clauses), the dashboard's XSS escaping, the timestamp-spoofing fix, WebSocket per-client error isolation, and the running-average race fix from prior passes.

`npm test`: 77 tests passing (up from 65) — 12 new tests across `tests/api.test.js`, `tests/validate.test.js`, `tests/userProfile.test.js` (new file), and `tests/rateLimit.test.js` (new file). All fixes additionally verified live against a running server: `curl` checks for 401/429/200 and response headers, a raw WebSocket client confirming the handshake is rejected without `?apiKey=` and accepted with it, and full `--scenario=all` / `benchmark.js` runs confirming the simulator and benchmark tooling still work unmodified-in-behavior against the now-protected API.

### 15.7 Sixth pass: code review of the Section 15.6 PR, all findings fixed — including one found only by actually opening the dashboard in a browser

An independent review of the Section 15.6 pull request (not another full-codebase audit — scoped to that PR's diff) found seven issues, all fixed here:

1. **Rate limiting didn't cover everything it implied it did.** The limiter was only mounted in front of `transactionsRouter`, leaving `GET /`, `GET /index.html` (real per-request work — a disk read, before this pass's caching fix below), static assets, and the WebSocket handshake completely unthrottled. **Fix:** `rateLimit` is now applied globally in `server/index.js` (with `/health` exempted internally, so liveness checks stay cheap and unaffected), and `server/websocket.js`'s `verifyClient` now calls the same shared counter (`rateLimit.checkAndRecord`, newly exported) before the auth check — a flood can't just split itself across HTTP and WS to double its effective budget. Tests: `tests/api.test.js` (429 over real HTTP, `/` covered, `/health` stays exempt), `tests/websocket.test.js` (WS handshake rejected with 429 once the shared budget is exhausted via plain HTTP).
2. **`serveDashboardIndex` did a synchronous disk read on every single request** to `/` or `/index.html` instead of caching the template once. **Fix:** the raw HTML is now read once at startup and cached (`cachedIndexHtmlTemplate`); each request only does a cheap string replace — same trade-off as `mlClient.js`'s `cachedModel` (a restart picks up on-disk edits, not live).
3. **The `RATE_LIMIT_MAX_PER_MINUTE=0` case silently fell back to the default** because `Number(raw) || DEFAULT` treats `0` as falsy, overriding an operator's explicit "block everything non-exempt" setting. **Fix:** `resolveMaxPerWindow()` in `rateLimit.js` now only falls back when the value is genuinely absent/unparseable, not merely falsy.
4. **A dead test-only export** (`module.exports._hitsByIp`) in `rateLimit.js` was never actually used by any test. **Fix:** removed; `checkAndRecord` (needed for real, by `websocket.js`) is the only extra export now.
5. **Duplicated raw HTTP boilerplate** in two `tests/api.test.js` auth tests instead of extending the existing `request()` helper. **Fix:** `request()` now accepts an optional `headerOverrides` argument (a key set to `undefined` removes it entirely) — both tests, and several new ones, reuse it instead of hand-rolling `http.request` calls.
6. **The `DEFAULT_DEV_API_KEY` residual risk was previously only a console warning** — nothing stopped the server from actually binding to all network interfaces and serving traffic with the known-public default key if `API_KEY` was left unset (a real scenario for a laptop demoed on hackathon venue WiFi). **Fix:** `server/index.js` now binds to `127.0.0.1` only whenever the insecure default key is in use (verified live: the server became genuinely unreachable from the machine's own LAN-facing IP), and to all interfaces as before once a real `API_KEY` is configured — overridable either way via a new `HOST` env var (documented in `.env.example`).
7. **CSP/SRI were never verified in an actual browser** — the previous pass only checked header presence via `curl`. Verified this time with Chrome via the `claude-in-chrome` browser automation tool: navigated to the dashboard, inspected the Network panel and console, and clicked through all three tabs (Live Monitor, Map, Audit Trail). This is what surfaced the real bug below — CSP/SRI themselves turned out to be completely fine (OpenStreetMap tiles, Chart.js, and Leaflet all loaded with no CSP violations in the console).

**Found only by actually loading the dashboard in a browser (the most significant bug of this pass):** `requireApiKey` was originally mounted as `app.use('/', requireApiKey, transactionsRouter)` in `server/index.js` — which, same as `router.use()` would, runs for *every* request reaching that layer, not just paths `transactionsRouter` defines a route for. `curl` testing (used throughout Section 15.6's own verification) never caught this because every check explicitly sent the `X-API-Key` header. But `<link rel="stylesheet">` and `<script src="...">` tags cannot attach custom headers the way `authFetch()`'s explicit `fetch()` calls can — so `style.css`, `app.js`, `map.js`, and `audit.js` were all being rejected with `401` before they could ever reach `express.static`. **The entire dashboard had been unstyled and inert since the moment auth was added in Section 15.6** — no chart, no map, no live table styling, nothing — and none of that section's own tests caught it, because every test in the suite talks to the API directly and none of them load the actual HTML page with its sub-resources the way a browser does. **Fix:** `requireApiKey` is now applied per-route inside `server/routes/transactions.js` (`router.post('/transaction', requireApiKey, ...)` etc.) instead of once for the whole router mount, so an unmatched path falls through to `express.static` exactly as it would with no auth middleware in the chain at all. Verified live in Chrome: all three tabs render correctly (styled dashboard, Leaflet map with OpenStreetMap tiles, Chart.js donut/trend charts), a live `--scenario=fraud` run visibly updated the counters and donut chart in real time over the WebSocket feed, and zero console errors. Test: `tests/api.test.js`, "dashboard static assets ... are servable with no API key (regression)" and a companion test confirming the actual API routes still correctly require one.

`npm test`: 84 tests passing (up from 77).

### 15.8 Dashboard visual redesign — dark "developer tool" design system, validated palette

A request for "professional realistic ... modern developer 3D" visual design prompted a full rewrite of `dashboard/style.css` plus the color/theming pieces of `dashboard/app.js`, `dashboard/audit.js`, and `dashboard/map.js`. No new dependencies (still Chart.js + Leaflet only, per CLAUDE.md's coding conventions), no HTML structural changes beyond one additive wrapper (below) — every existing DOM ID/class the JS depends on (`getElementById`/`querySelector` targets, `.tab-btn`/`.active`/`.view`/`.hidden`/`.alert-card`/`decision-${type}` classes) was inventoried first and left untouched.

**Design system:** layered dark surfaces (`--bg-void` → `--surface-1/2/3`) instead of a flat two-tone background, a soft mesh-gradient + dot-grid atmosphere behind the content, glass-panel cards with real elevation (layered shadows, an inset top-highlight for a beveled edge, a subtle `perspective()`/`rotateX()` tilt + lift on hover), pill-style tabs and buttons with gradient fills, a pulsing "Live" indicator, custom thin scrollbars, and decision values rendered as small colored badge cells rather than plain colored text.

**Palette — validated, not eyeballed.** Ran the dataviz skill's `validate_palette.js` against this dashboard's actual dark card surface (`#0f1626`) rather than picking hex values by eye. The original Tailwind-style colors (`#34d399`/`#fbbf24`/`#f87171`/`#a78bfa`) failed the categorical CVD-separation and lightness-band checks outright. The final set —
`--allow: #22ac74`, `--stepup: #b8891b`, `--block: #cc4646`, `--struct: #9085e9` — passes every check except one: pure red vs. pure green cannot be made fully separable under simulated deuteranopia/protanopia (that is the literal definition of red-green color blindness, not a tuning failure), so that one pair sits in the documented WARN band (worst adjacent ΔE 7.9 against a floor of 6, reached by deliberately widening the lightness gap between the two so brightness still separates them even when hue collapses). Per the skill's own mitigation for that band — secondary encoding, never hue alone — every decision in this UI was already spelled out in text everywhere a color appears (table cells, stat-card labels, alert reasons, map popups), so the WARN band is an accepted, justified trade-off rather than an oversight. `--accent` (`#3987e5`, used only for UI chrome — the live dot, active-tab fill, buttons — never as a data-identity color) was deliberately not run through the same all-pairs check against `--struct`, since chrome and data-identity colors are never presented as two marks a user must visually discriminate.

**Found and fixed along the way (both are correctness bugs the visual pass surfaced, not style choices):**
- The `#decision-chart` `<canvas>` had no CSS-level size constraint, so Chart.js's `responsive: true` (the default) grew it to fill most of the panel header's width instead of staying a compact 72×72 glance-able indicator — a real, pre-existing bug (not introduced by this pass), just not visually obvious until the dashboard was actually opened in a browser and scrolled. Fixed with the standard Chart.js pattern: a `.decision-chart-frame` wrapper div with a fixed CSS size (`index.html`), rather than fighting Chart.js's own JS-set inline canvas styles with `!important`.
- Leaflet's default zoom/attribution/popup chrome is styled for a light basemap and clashed hard against the dark theme (stark white boxes). Re-themed via CSS targeting Leaflet's own stable class names (`.leaflet-control-zoom`, `.leaflet-popup-content-wrapper`, etc.) — `style.css`'s `<link>` was reordered to load *after* `leaflet.css` in `index.html` specifically so these overrides win the cascade without needing `!important`. The OSM tiles themselves (a light basemap by design) are dark-mode-tinted via `invert(1) hue-rotate(180deg)` on `.leaflet-tile-pane` only — the standard CSS-only trick for a dark map from a light tile source, chosen over adding a separate dark-tile CDN dependency. The filter is scoped to the tile pane specifically so it doesn't invert the marker/popup panes, which need to keep their true status colors.

Verified live in Chrome (`claude-in-chrome`) with real data from a full `--scenario=all` run: all three tabs (Live Monitor, Map, Audit Trail), the donut chart's slice-gap rendering, the alert card's accent glow, table row badges, the pill tabs' active/hover states, the stat-card hover tilt, and the dark-themed Leaflet controls/popups/tiles — all confirmed rendering correctly with zero console errors.

`npm test`: 84 tests (unchanged — a visual/CSS pass with no behavioral or DOM-contract changes; the existing `tests/dashboard.test.js` script-order regression guard already covers the one HTML structural risk, and continues to pass).

**Follow-up bug-fix pass on this same branch:** a "fix all bugs and errors" request prompted a second, more adversarial read of the redesign, checking things the first pass hadn't: actual WCAG text-contrast ratios (not just the dataviz skill's categorical-mark check, which is a looser 3:1 bar), and re-reading every new comment for accuracy. Found and fixed:
- **`--block` (the validated categorical-mark red) fails WCAG AA text contrast at the sizes it was also being used at as text** — 3.90:1 against the card surface (and 3.48:1 against its own badge tint), below the 4.5:1 required for small/bold text (it only clears the *mark* floor the palette validator checks, a different and looser bar). Measured directly with the same validator script's `contrast()` export, not assumed. Since `--block` needs to stay relatively dark for its categorical-mark job (the CVD-separation-from-green trick from Section 15.8 above relies on a lightness gap), the fix is a second token, `--block-text` (`#ef6a6a`, 5.97:1 / 5.00:1 against its badge tint), used only where block is rendered as actual text (`.stat-block .stat-value`, `.decision-cell`'s block variant) — every mark usage (map dots, chart slices, the accent bar, the row-tint background) keeps the original validated `--block`. `allow`/`stepup`/`struct` were all already comfortably ≥4.5:1 as text (checked, not assumed) and needed no equivalent.
- Two stale/inaccurate comments: the Leaflet dark-theme section had two overlapping comments written at different points that partially repeated each other — merged into one. The `.decision-chart-frame` explanation (both in `index.html` and this document, above) said "90×90" — a leftover from before the actual implemented size was tuned down to 72×72; the canvas element's own `width`/`height` attributes had the same stale `90` value. All three now consistently say 72.
- The stat-card grid's mobile breakpoint (`repeat(2, 1fr)` for 5 cards) left the 5th card stranded alone in its row with an empty gap beside it. Fixed with `grid-column: span 2` on `.counters .stat-card:last-child` inside the media query.

Verified: contrast values computed via the validator's own `contrast()` export (not eyeballed), the brighter block-red visually confirmed in Chrome against a live `--scenario=all` run (both the stat-tile value and a `block` table badge), `npm test` still 84/84.

### 15.9 WebSocket hardening: payload cap, connection cap, heartbeat

A "bug hunt and vulnerability list" request, done fresh against the current `main` (post-redesign) rather than from memory, re-verified everything from prior passes was still intact (auth, rate limiting, XSS escaping, SQL parameterization, HOST binding, dependency CVEs — `npm audit` clean) and specifically hunted for what hadn't been checked yet. Found three real gaps, all in `server/websocket.js`, all fixed:

1. **No `maxPayload` on the WebSocketServer.** Left unconfigured, `ws`'s own default is 100 MiB per frame — an authenticated client (this requires clearing the API-key check first, capping severity) could force a large per-message allocation even though nothing downstream ever reads incoming WS data (there is no `ws.on('message', ...)` handler anywhere in this app; the feed is broadcast-only). **Fix:** `maxPayload: 1024` on the `WebSocketServer` constructor — confirmed via `npm test` and a direct raw-`ws`-client check that this only bounds *incoming* (client→server) frames, not the server's own outgoing broadcasts (which regularly exceed 1KB — a full transaction object with reasons).
2. **No cap on total concurrent connections.** `rateLimit.js` already bounded how *fast* new connections could open, but nothing bounded how many could be open *at once* — a long-running demo session could accumulate an unbounded number of them. **Fix:** `WS_MAX_CONCURRENT_CONNECTIONS` (default 500, env-configurable like `RATE_LIMIT_MAX_PER_MINUTE`), checked in `verifyClient` via `wss.clients.size` before the upgrade completes, rejecting with `503` once reached.
3. **No ping/pong heartbeat.** A connection that died without a clean close (network drop, a laptop sleeping mid-demo) stayed in `wss.clients` until the OS-level TCP timeout eventually noticed — minutes to hours, a slow resource leak over a long session rather than an active exploit. **Fix:** a `WS_HEARTBEAT_INTERVAL_MS`-interval (default 30s, env-configurable, `.unref()`'d like `rateLimit.js`'s own cleanup timer) that pings every connected client and terminates anyone who didn't pong back since the previous cycle.

All three required real regression tests, not just constant-value checks, to be worth anything: `tests/websocket.test.js` now includes a test that sends an oversized frame and confirms close code 1009, a test that opens connections up to a lowered cap and confirms the next one is rejected with 503, and a test that force-sets a server-side socket's heartbeat state to simulate "already missed a pong" and confirms the next tick terminates it and removes it from `wss.clients` — all three exercise the real code paths against a real running server and real WebSocket connections, not mocks. The heartbeat test in particular couldn't use a real unresponsive client (the WebSocket spec/`ws` library auto-answer ping frames at the protocol level in any normal client, making genuine unresponsiveness hard to simulate from the outside), so it reaches into the server-side socket object directly, the same established pattern the existing "unhandled per-client error" test already used.

Verified live: a standalone raw-`ws` script (bypassing a flaky browser-automation session that got stuck on an unrelated tooling issue) confirmed connect → welcome message → a real `POST /transaction` broadcast all still arrive correctly over the hardened socket. `npm test`: 87 tests passing (up from 84).

### 15.10 Merchant/multi-gateway reframe

The product framing was corrected: SentinelPay is built for **a merchant business's own senior risk/compliance team**, not a bank — it wires into every payment gateway the business uses (Stripe, Razorpay, PayPal, etc.) rather than integrating with one gateway in isolation, since laundering can otherwise hide by spreading activity across gateways no single integration would see in full. This was a positioning/data-shape correction, not a scoring-logic change:

1. **`sender_id`/`receiver_id` clarified as directional, not role-fixed.** On an ordinary payment the customer is `sender_id` and the merchant is `receiver_id`; on a refund/payout the merchant is `sender_id` and the customer is `receiver_id`. No schema change — this was always true of the data, just not documented that way.
2. **`purpose TEXT` added to `transactions`** (nullable, pure addition — see Section 6) — a human-readable note, mainly populated on merchant-initiated outgoing transactions (refunds, payouts, vendor settlements), for analyst context only. Threaded through `validate.js` (bounded at 256 chars via `MAX_PURPOSE_LENGTH`), the `POST /transaction` insert, the WebSocket broadcast, `GET /transactions`, and `userProfile.js`'s `mapTransactionRow`.
3. **`merchant_id`'s role clarified**, not changed structurally: it identifies which of the business's own payment-gateway accounts (Stripe/Razorpay/PayPal, etc.) a transaction was ingested from — the field that makes cross-gateway aggregation visible. It had existed since the original build but was never read by any rule/scoring/structuring code (still isn't — deliberately analyst-facing, not a detection input) and was never surfaced on the dashboard; both are now fixed (below).
4. **Dashboard**: added "Gateway" (`merchant_id`) and "Purpose" columns to the live and audit tables, and an optional purpose line in the map popup — pure data/copy additions reusing the existing `reasons`-style wrapping CSS, no layout/design changes (`dashboard/index.html`, `app.js`, `audit.js`, `map.js`).
5. **Simulator and demo-data seeder** (`simulator/simulate_transactions.js`, `scripts/generate_demo_data.js`) reworked from a single undifferentiated 300-user pool to a `CUSTOMER_POOL` (300) plus a small `MERCHANT_RECEIVER_POOL` (8 storefront-style accounts) and `GATEWAY_POOL` (4 gateway-account-style values), with `generateNormalTransaction` now producing a realistic mix: ordinary purchases (86%), merchant-initiated refunds with a `purpose` note (6%), store-credit top-ups (6%), and settlement payouts to the business's bank (2%). The merchant-account-as-sender share was deliberately kept small and spread across 8 accounts to stay well under the velocity detector's threshold — the same reasoning that originally sized `CUSTOMER_POOL` at 300. The fraud and odd-hour scenarios now target a real merchant account instead of a throwaway random receiver; the structuring scenario's narrative was re-anchored to shell vendor/payout accounts riding the platform's payment flow, with its detection mechanics unchanged.
6. **`architecture.md`/`user-manual.md`/`README.md`** reframed accordingly (Sections 1–3, 5–7 here; Sections 1, 2, and 9 of `user-manual.md` — the latter's AML-reporting language was also corrected to attribute the statutory reporting obligation to the business's payment processor/banking partner, not the merchant itself).

No new `transaction_type` enum value was added (refunds are modeled as `'transfer'` + `purpose`, not a new `'refund'` type) and no new fraud/scoring logic was added keyed off `purpose` or `merchant_id` — both remain explainability-only. `npm test`: 91 tests passing (up from 87; two `validate.test.js` cases and one `api.test.js` round-trip test cover `purpose`, one `websocket.test.js` assertion extended to cover `merchant_id`/`purpose` in the broadcast payload).

### 15.11 Dashboard ID-column collapse, backed by an editable business-accounts registry

On any given row, one side of `sender_id`/`receiver_id` is always one of the business's own accounts and the other is the customer — showing both separately (as "Sender"/"Receiver") was redundant now that the direction is understood (Section 15.10). Fixed:

1. **New table `business_accounts`** (`account_id TEXT PRIMARY KEY, created_at TEXT NOT NULL`, Section 6) — an editable registry of the business's own account IDs. No FK to `users`, deliberately: an ID can be registered before or independent of having any transactions.
2. **New routes** `GET`/`POST`/`DELETE /business-accounts` (`server/routes/businessAccounts.js`, Section 7), mounted the same way `transactionsRouter` is — `requireApiKey` per-route, not a blanket `router.use()`, for the same reason as `transactions.js` (a blanket gate would 401 the dashboard's own static assets). `validate.js`'s `MAX_ID_LENGTH` is now exported and reused for `account_id` validation rather than duplicated.
3. **Dashboard**: both the live and audit tables' separate `Sender`/`Receiver` columns collapsed into one `ID` column. `resolveCounterpartyId(tx)` (`dashboard/app.js`, shared globally with `audit.js`/`map.js`) looks up `sender_id`/`receiver_id` against the registry: exactly one side known → show the other (the customer); neither (or both) known → show `"sender → receiver"` rather than guess. A new always-visible strip between the counters and the tabs (`.business-accounts` in `style.css`, styled to match the existing `.audit-filters` input/button look) lets the account IDs be added/removed live; any registry change re-fetches and re-renders the live table from scratch so it applies retroactively to already-drawn rows, not just new ones (counters are untouched — they track the cumulative live event stream, not what's currently displayed).
4. **Deliberately unchanged**: the scoring/decision pipeline (this registry is dashboard display logic only, never a detection input) and `merchant_id`'s meaning (still "which gateway," orthogonal to "which side is the business").

`npm test`: 97 tests passing (up from 91; six new `api.test.js` cases cover the three routes, including the no-op-not-error re-add/re-delete behavior and the missing-API-key regression).

### 15.12 Fraud/AML scoring scoped to outbound only, with four new detectors and a restrictor

**Supersedes 15.11 item 4:** the `business_accounts` registry was built purely as dashboard display logic, explicitly *not* a detection input. That's no longer true — it's now the signal that decides whether fraud/AML scoring runs on a transaction at all. The reasoning (worked out with the user across several rounds): a customer paying the business isn't a risk this system is positioned to police — a stolen card is the card network's/payment gateway's problem (CVV, 3D-Secure, chargebacks), not money laundering or theft of the business's own funds. The actual risk this product exists to catch is money *leaving* the business unaccountably. So:

1. **`server/routes/transactions.js`**: `isBusinessAccount(db, input.sender_id)` (new, `server/businessAccounts.js`) gates the rule/ML pipeline. Outbound (sender is a registered business account) → the existing 5 rules + 4 new outbound-only detectors + ML all run, same as before. Inbound (everyone else) → `ruleResults = []`, `mlProbability = 0`, auto-allow. **Not gated:** the structuring-alert fast lookup (`findActiveAlert`) — it always runs and still feeds `computeFraudScore`, preserving the "an active structuring alert always forces block, regardless of transaction size" guarantee (Task 7 DoD) for every transaction, not just outbound ones. `scripts/generate_demo_data.js`'s `insertTransaction` mirrors this exactly, per that file's own "if the pipeline's shape changes, mirror it here too" comment.
2. **`server/outboundContext.js`** (new) — computes, in a few queries against the already-indexed `sender_id`/`receiver_id`/`timestamp` columns, the context the new detectors need: prior purchase total from this specific customer, prior outbound count, known receivers, rolling inbound/outbound totals (90-day lookback — refunds/vendor relationships can span months, longer than `getUserHistory`'s 24h window), and a short 10-minute burst-window receiver list.
3. **Four new detectors** (`server/rules/`, Section 4.1 has the full list): `refundWithoutPurchase.js`, `payoutToNewReceiver.js`, `outboundRatioAnomaly.js`, `outboundFanOutBurst.js`.
4. **`server/outboundRestrictor.js`** (new) — a hard floor beyond scoring: an outbound transaction above `MAX_OUTBOUND_WITHOUT_REVIEW` (₹25,000) always gets at least step-up, regardless of score, mirroring `scoring.js`'s `STRUCTURING_ALERT_FLOOR` pattern.
5. **A real bug this surfaced**: the refund branches in `simulator/simulate_transactions.js` and `scripts/generate_demo_data.js` previously set `device_id` to the *customer's* device on a business-initiated refund — under the old universal scoring this was inert, but it would have made `deviceMismatch` flag every single refund once outbound scoring went live (the business account has never seen the customer's device, and never would). Fixed: refunds now omit `device_id` entirely, like withdrawal/payout transactions already did. A second latent bug from the same fix was only caught by actually running the seeder end-to-end (not just `node --check`): `insertTransaction` never normalized a missing `device_id` to `null` before binding it to SQLite (only `merchant_id`/`purpose` got that treatment), so the now-`device_id`-less refund rows crashed the seed script outright. Fixed alongside.
6. **Demo scenarios**: the old `--scenario=fraud`/`--scenario=odd-hour` (both inbound attacks) are kept for reference but their console output no longer claims a block — they now assert the correct new behavior (auto-allow, no flags) and point at the replacements. New `--scenario=outbound-fraud` (a compromised business account rapidly draining funds to new receivers — the flagship demo now) and `--scenario=refund-fraud` (a large refund with no matching purchase). Both self-register the simulator's known storefront accounts (`ensureMerchantAccountsRegistered`, called once at the top of every simulator run) so outbound detection works immediately without a manual dashboard step; `scripts/generate_demo_data.js` does the equivalent via a direct insert, plus matching historical seed-event generators (`runOutboundFraudEvent`, `runRefundFraudEvent`) so the Audit Trail has believable flagged outbound history from the moment the dashboard opens. `scripts/demo.js`'s interactive menu updated to match.

No change to the structuring background job's own detection mechanics — it's already generic over sender/receiver and already covers "a business account structuring its own payouts" as a special case with zero changes needed.

`npm test`: 122 tests passing (up from 97) — 19 new unit tests across the 4 new detectors (`tests/rules.test.js`) and `outboundContext.js`/`outboundRestrictor.js`/`isBusinessAccount` (new `tests/outboundContext.test.js`), 2 new route-level tests locking in the inbound-skip and the preserved structuring floor, and 2 existing `tests/api.test.js` tests fixed to register their sender as a business account first (they relied on rule-scoring firing on an unregistered sender, which no longer happens).

### 15.13 Bug hunt on the 15.12 outbound-only pipeline: three real findings, all fixed

A combined security-vulnerability scan and general bug hunt (finder pass + a specialized false-positive filter) against the 15.10–15.12 changes, in the same spirit as the 15.6/15.7 review passes. Found three real issues, all fixed:

1. **`refundWithoutPurchase.js` never converged (High).** It compared a refund's amount against the customer's *gross* lifetime purchase total, but never subtracted refunds already paid out against that same purchase — so a single ₹500 purchase could justify refund after refund to the same customer forever, since the total it checked against never went down. **Fix:** `getOutboundContext` now also computes `priorRefundTotal` (refunds already issued to this customer at this business account, no age gate — a refund issued a moment ago must reduce available credit immediately), and `refundWithoutPurchase.js` flags against `priorPurchaseTotal - priorRefundTotal` ("available credit") instead of the raw total.
2. **A fabricated inbound "purchase" could defeat the new detectors (Medium, contested).** Since inbound transactions get zero scoring, an actor with API access could insert a fake inbound "purchase" for free, then immediately reference it in a matching outbound "refund" to defeat `refundWithoutPurchase` (and `outboundRatioAnomaly`, via the fabricated leg inflating `rollingInboundTotal`). A specialized false-positive-filter pass scored this 4/10 and would normally drop it — anyone who can call `POST /transaction` already has full pre-existing trust to assert arbitrary `sender_id`/`amount` (a backend-to-backend integration point, not something end users call), so this is evasion of a new heuristic by an already-trusted caller, not a new unauthorized-access hole. Fixed anyway since it directly undermines the new detectors' purpose: `getOutboundContext` now only counts a purchase toward `priorPurchaseTotal` once it's at least `OUTBOUND_MIN_PURCHASE_AGE_MS` (5 minutes) old. This closes the immediate/scripted version of the attack (the one an automated drain would actually use); it does not stop a patient attacker willing to wait out the gate — an accepted, documented trade-off rather than a full fix, proportionate to this project's scope.
3. **A same-millisecond race in `getOutboundContext`'s query boundaries (found via flaky test, not the review pass).** Every query used a strict `timestamp < transaction.timestamp` upper bound. Timestamps are server-assigned via `new Date().toISOString()` (millisecond resolution) — two requests for the same account fired fast enough (the exact rapid/scripted-attack scenario these checks exist to catch) can land on the same millisecond, and the strict `<` would silently exclude the earlier one from every total (`priorPurchaseTotal`, `priorRefundTotal`, `priorOutboundCount`, `knownOutboundReceiverIds`, both rolling totals, `recentBurstReceiverIds`). Caught when the new "second refund against an already-refunded purchase" regression test (below) failed intermittently — 1 run in 6 — not by static review. **Fix:** all seven queries now use `<=`; safe because `getOutboundContext` always runs before the current transaction's own row is inserted, so there's no risk of a row matching itself. Verified with 6 consecutive clean full-suite runs after the fix (0 flakes, previously ~1-in-6).

New tests: `tests/outboundContext.test.js` covers the purchase-age gate and `priorRefundTotal`; `tests/rules.test.js` covers the double-refund regression and the partial-refund-remaining-credit case at the pure-function level; `tests/api.test.js` adds two end-to-end regressions (`a same-burst fabricated purchase cannot be immediately used as refund credit`, `a second refund against an already-refunded purchase is flagged`) — the latter seeds its "old" purchase directly into the DB, since `POST /transaction` always stamps server-received time and won't let a caller backdate one through the real API.

`npm test`: 128 tests passing (up from 122).

### 15.14 Dashboard visual redesign #2 — light "enterprise fintech console" theme

Replaced the dark "developer tool at night" theme (15.8) with a light, white-surface theme — same information architecture and DOM structure, every class name/ID JS depends on unchanged, only the visual system rebuilt:

- **Palette**: chart chrome/ink and the accent blue are the dataviz skill's reference palette values directly (`references/palette.md`), not invented. Re-ran the skill's validator (`validate_palette.js`) against the light surface for the allow/step-up/block/struct quartet: CVD separation and the normal-vision floor both pass, but step-up (amber `#fab219`) fails light-surface contrast outright (1.83:1) — expected, already documented by the skill itself as a designed trade-off. Every status color therefore ships as two steps: a **mark** step (the canonical hue — dots, left-border accents, chart fills beside a legend) and a darker **text** step (badge labels, stat-tile values, hand-picked past 4.5:1 on white) — the same two-step pattern the dark theme used for `--block`/`--block-text` alone, just needed for the whole quartet here since amber fails so much harder on light than on dark.
- **Typography**: initially the `system-ui` stack (matches the dataviz skill's typeface guidance); upgraded to **IBM Plex Sans/Plex Mono** — IBM's own enterprise/technical design-system typeface, a deliberate choice over the far more common Inter/system-font default, loaded as pinned Fontsource npm packages via jsdelivr (exact versions + SRI hashes in `dashboard/index.html`, only the weights actually used) with the system stack kept as the graceful-degradation fallback if the CDN doesn't load. Google Fonts' own CSS endpoint was ruled out specifically because it varies its response by request user-agent, which is incompatible with a fixed SRI hash — this project SRI-pins every CDN asset (see the very first comment in `index.html`), so the font source had to be one that could carry the same guarantee, not a documented exception to it. Mono is used for identifiers, amounts, scores, and business-account chips — the numeric/ID columns read as tabular data, not prose.
- **Motion**: a restrained perspective-tilt + lift on stat-card hover, a matching tilt on the brand mark on topbar hover, an eased count-up animation on stat-tile values (skipped on the initial historical-data load — only live updates animate — and under `prefers-reduced-motion`), and a fade/slide-in on new table rows and tab-view switches.
- **Map**: Leaflet's default light tiles no longer need the dark-theme's `invert()+hue-rotate()` CSS filter — removed entirely; the map now renders OpenStreetMap's natural basemap.
- **Brand mark**: replaced the Unicode ◈ glyph placeholder with a custom inline SVG shield-check icon (reused as an SVG data-URI favicon), since a Unicode-symbol-as-logo reads as a placeholder rather than a designed mark.

No HTML structural changes beyond the brand-mark markup and a `<link rel="icon">` addition — `dashboard/app.js`/`map.js`/`audit.js` changes are confined to the duplicated chart-color constants (documented at each site as needing to stay in sync with `style.css`'s custom properties, since Chart.js/Leaflet can't read CSS variables) plus the new count-up helper. `npm test`: unaffected (128 passing) — this was a frontend-only change with no server-side surface.

### 15.15 Security-hardening pass: the ML serving pipeline and a fresh full-schema SQL sweep

Every prior review pass (15.1–15.13) was scoped to whichever feature had just landed. This pass deliberately targeted the areas that had *never* been explicitly security-reviewed on their own — the ML serving pipeline (`ml/serve.py`, `server/ml/mlClient.js`, `server/ml/features.js`) — plus a fresh full-codebase SQL injection sweep to catch anything the accumulated feature set might have introduced by later code interacting with earlier code, not just what each individual PR touched.

**One real bug, fixed:** `ml/serve.py`'s `do_POST` computed `length = int(self.headers.get("Content-Length", 0))` *outside* the `try`/`except` that wraps the rest of request handling — a request with a non-numeric `Content-Length` header raised an unhandled `ValueError` instead of the clean 400 JSON error every other malformed-input path returns. Not a crash of the server (`ThreadingHTTPServer` isolates each connection to its own thread), but a real robustness gap — verified live: before the fix, a malformed header produced an unhandled exception in the server log; after moving the `int()` call inside the `try`, the same request returns `400 {"error": "invalid literal for int() with base 10: '...'"}`, and the server continues serving subsequent requests normally (confirmed with a follow-up `/health` check and a valid `/predict` call, both succeeding immediately after).

**Two clean sweeps, no findings:**
- **SQL injection**, across every `db.prepare()` call in `server/routes/*.js`, `server/*.js`, `server/structuring/*.js`, `server/businessAccounts.js`, and `scripts/generate_demo_data.js` (16 call sites), plus every `db.exec()` call (only ever fixed pragma/schema strings in `server/db.js`, never request-derived). The two places SQL text is built dynamically (`GET /transactions`'s decision-filter `IN (...)` clause and its flags lookup) were checked with extra care: the interpolated part is always just a `?`-placeholder count, and the actual filter values are both bound parameters *and* pre-validated against a fixed whitelist (`VALID_DECISIONS`) before ever reaching the query.
- **The ML pipeline**, end to end: no eval/exec/shell/deserialization gadgets anywhere (model persistence is deliberately plain JSON, not pickle — `ml/train_model.py`'s own comment notes this was chosen specifically to avoid that risk class); `ml/serve.py` binds only to `127.0.0.1`, never network-exposed; attacker-controlled `amount`/`location` values are guaranteed finite numbers by `validate.js` before they ever reach feature extraction, so there's no path to a NaN fraud score silently defeating detection; the fail-open-to-probability-0 behavior on ML failure is intentional and documented (rules + the structuring lookup still fully apply), not a gap.

`npm test`: 128 passing, unchanged (this pass fixed a Python-only file with no JS test surface; verified separately via live `curl` checks, described above).

### 15.16 21-feature extension: refund integrity, account/vendor risk, employee/merchant/gateway fraud, geo risk, circular-flow detection, dashboard v2, analytics, config-driven thresholds

A large follow-on spec (21 numbered features, verbatim, on `feature/advanced-fraud-detection-suite`) extending the outbound-fraud pipeline from 15.12 well beyond the original MVP. Recorded here per this doc's own anti-drift rule — every implementation decision below is binding until superseded by a later dev-log entry, the same as every other numbered feature in Section 4.

**Ground rules carried over from the spec, non-negotiable:** don't rewrite working modules — extend; reuse existing tables/graph engine/websocket/scoring engine wherever possible, new tables only where the data genuinely doesn't exist yet; every detector is its own file, pure, unit-tested; every flag/alert has a human-readable reason and a severity (Low/Medium/High/Critical); every dashboard update goes through the existing WebSocket; every threshold is a named constant in `server/config.js`, not scattered magic numbers; run `npm test` after every feature and fix regressions before moving on; docs updated as part of the same work, not deferred to the end.

**Schema additions (all pure additions — no `sender_id`/`receiver_id`-style retrofit, nothing removed):**
- `transactions.reference_transaction_id TEXT` (nullable) — links a refund to the specific purchase it refunds. Optional in the API; when present, powers Feature 1 (account-mismatch) and sharpens Feature 3/7 (same-purchase refund accounting) beyond the purpose-string/customer-total heuristics `refundWithoutPurchase.js` already used.
- `transactions.employee_id TEXT` (nullable) — which internal staff member initiated a merchant-side transaction (refunds/payouts), for Feature 10. No employee identity table — `employee_id` is caller-supplied, same trust model as `sender_id`/`merchant_id` today.
- `transactions.country TEXT`, `transactions.ip_address TEXT` (nullable) — for Feature 14 (geo risk); no existing field carried country/IP, only lat/lng and device_id.
- New table `merchant_login_events` (`login_id` PK, `merchant_id`, `device_id`, `browser`, `os`, `ip_address`, `location_lat`, `location_lng`, `timestamp`, `created_at`) — Feature 4 needs merchant login metadata, which is not transaction data and has no existing home. New `POST /merchant-logins` ingestion route (simulator/demo-only caller, same trust model as `POST /transaction`).
- New table `disputes` (`dispute_id` PK, `transaction_id`, `customer_id`, `dispute_type`, `created_at`) — Feature 8 needs chargeback/dispute events, which don't exist anywhere in the current schema. New `POST /disputes` ingestion route. Scope cut: delivery-status tracking (mentioned in the spec's Feature 8 text) is out — this system has no shipping/fulfillment integration to source it from, and the dispute-recurrence signal alone is sufficient for a customer risk score at this project's scope; documented here rather than silently dropped.
- No new table for mule scoring (Feature 13) or dormant-account detection (Feature 12) — both are computed on demand from existing `transactions` rows (a receiver's receive/withdraw ratio; a sender's/receiver's `MAX(timestamp)` gap), consistent with "reuse existing tables whenever possible."
- Cross-gateway detection (Feature 11) needs no new field at all — `merchant_id` already identifies the gateway a transaction came through; the detector is a new query pattern over existing columns, not a new column.

**`server/config.js` (new, Feature 19):** centralizes every threshold introduced by this extension (`MAX_REFUNDS`, `MAX_REFUND_RATIO`, `MAX_NEW_VENDOR_AMOUNT`, `MAX_NEW_VENDOR_BLOCK_AMOUNT`, `HIGH_RISK_COUNTRIES`, `HIGH_RISK_IP_PREFIXES`, `MULE_WITHDRAWAL_RATIO`, `MULE_WINDOW_MS`, `REFUND_VELOCITY_COUNT`/`_WINDOW_MS`, `DORMANT_DAYS`, `DORMANT_REACTIVATION_AMOUNT`, `CROSS_GATEWAY_WINDOW_MS`/`_AMOUNT`, `EMPLOYEE_REFUND_COUNT_THRESHOLD`, etc.), one object per feature area, each constant commented with what it controls. Deliberately scoped to the *new* features only — Section 14's existing convention (named constants at the top of each existing rule file, e.g. `velocity.js`'s own `MAX_TRANSACTIONS_PER_WINDOW`) is left as-is per "do not rewrite existing working modules"; migrating those into `config.js` too would touch nine already-shipped, already-tested files for no functional gain and is explicitly out of scope for this pass.

**Detector wiring:** all new outbound-side detectors join the existing `server/rules/` directory and the same `(transaction, context) => {flagged, reason, weight, severity}` shape as the nine detectors already there, extended with a `severity` field (Low/Medium/High/Critical, Feature 17) that the six pre-existing detectors also gain (backfilled, not just the new nine) so `scoring.js`'s explainability output is uniform rather than half the detectors having severity and half not. Circular-flow (Feature 6) and cross-gateway-structuring (Feature 11) are graph/aggregate patterns, not per-transaction rules, so they follow the existing `server/structuring/` background-job + fast-lookup split (same shape as split/fan-out/withdrawal-correlation) rather than living in `server/rules/`.

**Force-block list (Feature 16):** `scoring.js` gains a small `CRITICAL_DETECTORS` set — merchant account takeover (Feature 4), circular laundering (Feature 6), known mule (Feature 13), known structuring/fraud ring (already-existing alert lookup) — any of which floors the decision at `block` regardless of the numeric score, mirroring the existing `STRUCTURING_ALERT_FLOOR`/`outboundRestrictor.js` floor pattern rather than inventing a new mechanism.

**Phasing (given the 21 July deadline, 4 days out from when this section was written):** implemented in dependency order, `npm test` gating each step — (A) `config.js` + schema; (B) refund-integrity cluster, Features 1/2/3/7/9 (highest value, builds directly on the already-shipped `refundWithoutPurchase.js`/`outboundContext.js`, no new data model); (C) account/vendor risk, Features 5/12/13/14 (query-only, existing tables); (D) new data-model features, 4/8/10/11; (E) circular-flow graph, Feature 6; (F) scoring/explainability wiring, 16/17; (G) dashboard v2 + analytics endpoints, 15/18; (H) test-coverage/doc sweep, 20/21. Each lettered phase is a commit; this doc and `README.md` are updated in the same phase that changes them, not deferred to phase H — phase H is a final consistency sweep, not the first time docs are touched.

---

## 16. "Enterprise Edition" wishlist (26 categories, verbatim) — status against the actual build

A follow-on request supplied a much larger 26-category feature list ("SentinelPay – Final Feature List (Enterprise Edition)") and asked for it to be reflected here and built. It's an order of magnitude bigger than Section 15.16's 21 features, and a meaningful slice of it needs things this hackathon build cannot responsibly fabricate: real third-party credentials (Slack/Teams/Discord/Telegram/SMS/email), collection of sensitive government ID numbers (PAN, Aadhaar), a real login/authentication system this project has never had, native mobile-SDK-level device attestation, or a new LLM integration. Faking any of those — a "Slack alerts" toggle with no real webhook, an "RBAC" system with no actual users to assign roles to — would misrepresent what's actually working, which cuts against this document's own standing rule (the `// PROD: X — DEMO: Y` convention, Section 14) of never letting a stand-in pass as the real thing. So: every category below is triaged honestly — ✅ already built (with the file), 🔶 partially covered by something that already exists (explained), 🆕 newly built in this pass, or ⛔ explicitly out of scope for this build, with the concrete reason (not just "later").

Legend: ✅ built · 🔶 partially covered by something that already exists · 🆕 newly built in this pass · ⛔ out of scope for this build (reason given at the category, not repeated per item).

**1. Core Transaction Engine** — ✅ all ten: Real-time Transaction Ingestion API (`POST /transaction`) · Multi-Gateway Transaction Processing (`merchant_id`) · REST API Support · WebSocket Live Streaming · Transaction Validation (`validate.js`) · Merchant Account Registry · Business Account Management (`business_accounts`) · Transaction History (`GET /transactions`) · High Throughput Processing · Low Latency <150ms (measured, Section 11)

**2. Rule-Based Fraud Detection** — ✅ Velocity · Impossible Travel · Amount Anomaly · Device/IP Mismatch (`deviceMismatch.js` + `geoRisk.js`'s IP check) · Odd Hour Activity · Refund Without Purchase · Refund Account Mismatch · Multiple Refund Detection · Split Refund Detection · Refund Velocity Detection · Refund Abuse Detection (🔶 covered jointly by `multipleRefundDetection.js`+`refundWithoutPurchase.js`, not a separate file) · Refund Chain Detection (🔶 `splitRefundDetection.js`) · Payout to New Receiver · Outbound Ratio Anomaly · Outbound Fan-Out Burst · Dormant Account Reactivation · High-Risk Transaction Detection (🔶 the score/decision tiering itself) · **Duplicate Transaction Detection 🆕** (`server/rules/duplicateTransaction.js`) · Suspicious Merchant Behavior Detection (🔶 the outbound detector suite collectively)

**3. Anti-Money Laundering** — ✅ all 14: Structuring · Smurfing · Layering · Fan-Out · Split Transaction · Withdrawal Correlation · Mule Account Detection · Mule Account Risk Scoring · Circular Money Flow Detection · Chain Tracking · Multi-Hop Transaction Tracking · Graph-Based AML Detection · Money Flow Analysis · Suspicious Network Detection (🔶 structuring + mule + circular-flow together)

**4. Graph Intelligence** — Relationship Graph (🔶 the data model supports the query, no dedicated endpoint) · Transaction Graph (🔶 same) · Fraud Ring Detection ✅ (`structuring_alerts`) · Community Detection ⛔ · **Shared Device Graph 🆕** / **Shared IP Graph 🆕** (`server/rules/sharedIdentifierRisk.js`) · Shared Bank Account Graph ⛔ (no separate "bank account" concept distinct from `account_id` in this schema) · Hidden Relationship Discovery ⛔ · Graph Clustering ⛔ · Network Risk Scoring (🔶 mule score is network-adjacent) · Interactive Graph Visualization ⛔. *Reason for the ⛔ items: a real clustering algorithm and a graph UI library (vis.js/Cytoscape.js) are substantial, dependency-adding undertakings, not config or a query away.*

**5. Machine Learning & AI** — ✅ Logistic Regression Fraud Model · Fraud Probability Prediction · AI Fraud Prediction · ML Feature Extraction · Vertex AI Ready · Local ML Inference · AI Explainability Engine. Adaptive Risk Scoring ⛔ / Behavioral Pattern Learning ⛔ / Predictive Fraud Forecasting ⛔ — *all three need an online-learning or time-series retraining pipeline this project doesn't have; a real net-new ML system, not a config tweak.*

**6. Customer Intelligence** — 🔶 all nine covered by existing pieces, no dedicated per-customer endpoint beyond the ranked list: Customer Risk Score/Profile/Reputation Engine/Trusted Score (`GET /analytics/top-risky?dimension=customers`) · Repeat Offender Detection (`friendlyFraud.js`'s dispute-repeat count) · Friendly Fraud Detection ✅ · Chargeback Pattern Analysis (`disputes` table) · Customer Behavioral Profiling (`userProfile.js`) · Customer Transaction Timeline (`GET /transactions`, filterable client-side)

**7. Merchant Intelligence** — 🔶 all eight: Merchant Risk/Health Score (`gateway-comparison`'s `avg_fraud_score`) · Merchant Behavioral Profiling · Merchant Account Takeover Detection ✅ · Merchant Login Monitoring ✅ · Merchant Device Tracking ✅ (`merchant_login_events`) · Merchant Security Analytics · Merchant Trust Score — no separate 0-100 "health score" endpoint exists beyond what's listed

**8. Vendor Intelligence** — 🔶 Vendor Reputation Engine / Trusted Vendor Detection (`knownOutboundReceiverIds`) · New Vendor Risk Detection ✅ · Vendor Risk Dashboard ✅ (`top-risky?dimension=vendors`) · Vendor Trust Score · Vendor Payment Analysis

**9. Employee Intelligence** — ✅ all five: Employee Fraud Detection · Employee Refund Monitoring · Employee Risk Score (`top-risky?dimension=employees`) · Insider Threat Detection (`employeeFraud.js`) · Employee Activity Analytics

**10. Device Intelligence** — 🔶 Device Reputation Engine/Trusted Device Score/History/Risk Score (`deviceMismatch.js`, `top-risky?dimension=devices`) · **Shared Device Detection 🆕** (see #4) · Device Fingerprinting ⛔ / Emulator Detection ⛔ / Rooted Device Detection ⛔ — *all three need a native mobile SDK reporting device attestation, structurally impossible from a JSON HTTP API.*

**11. Identity Intelligence** — ⛔ **entirely out of scope, all seven:** Shared Phone Detection · Shared Email Detection · Shared PAN Detection · Shared Aadhaar Detection · Shared Bank Account Detection · Synthetic Identity Detection · Identity Link Analysis. *Shared phone/email would need new schema fields (plausible on their own) but shared PAN/Aadhaar means collecting and matching India's government identity-document numbers — real PII with real regulatory weight, on a public GitHub-hosted hackathon demo with no auth system protecting it. This is a "should not build this here" flag, not a "haven't gotten to it yet."*

**12. Geo Intelligence** — ✅ Geo Risk Scoring · High-Risk Country Detection · Impossible Travel Analytics · Geo Heat Map (🔶 the new fraud heatmap is hour/day, not geo — the geo visualization is the pre-existing Map tab) · Geo Fraud Analytics (🔶). High-Risk State Detection 🔶 / High-Risk City Detection ⛔ — `config.js` has `HIGH_RISK_STATES` but this schema has no `state`/`city` column to match against yet.

**13. Explainability Engine** — ✅ Fraud Score · Decision · Severity · Detector Names · Human-Readable Reasons · Risk Breakdown (all Feature 17). Confidence Score ⛔ / Investigation Notes ⛔ — see #14, both are really the Investigation Module's concepts.

**14. Fraud Investigation Module** — ⛔ **out of scope, all ten, flagged explicitly:** Case Management System · Case Creation · Case Assignment · Investigation Workflow · Analyst Notes · Evidence Attachment · Investigation Timeline · Case Status Tracking · Fraud Replay · Replay Timeline. *Case assignment implies assigning a case to a specific analyst — this requires a real user/analyst identity system, which this build has deliberately never had (Section 15.6: "no login system in this hackathon build," an accepted, documented limitation). Building "case assignment" with no real users to assign to would be UI theater. This is a legitimately large subsystem — comparable in size to everything in Section 15.16 combined — that needs a real decision about adding authentication first, not something to bolt on silently.*

**15. Dashboard** — ✅ nearly everything, built across Section 15.16's Feature 15 pass and earlier: Live Dashboard · Live Transactions · Live Alerts · Live Fraud Feed · Fraud Counters · Blocked/Step-Up Transactions · Fraud Percentage · Blocked Amount · Recovered Amount · Mule Accounts · Fraud Rings (structuring-alert panel) · Top Risky Customers/Merchants/Devices/Countries/Vendors · Gateway Comparison · Geo Map · Fraud Heat Map · Hourly/Daily/Weekly/Monthly Charts. Risk Widgets (Merchant/Customer/Vendor Health, Employee/Device Risk) 🔶 — covered by the top-risky tables, not separate gauge widgets. Interactive Transaction Graph ⛔ — see #4.

**16. Analytics** — ✅ all twelve: Fraud Trend Analysis · Gateway Comparison · Fraud Category Statistics · Average Fraud Score · Average Response Time · Blocked Amount · Recovered Amount · Customer/Merchant/Vendor/Employee/Device Statistics (`server/routes/analytics.js`, Feature 18)

**17. Notification Engine** — ⛔ **out of scope, all eight, needs the user's own credentials:** Email Alerts · SMS Alerts · Slack Alerts · Microsoft Teams Alerts · Discord Alerts · Telegram Alerts · Web Push Notifications · Critical Fraud Alerts. *Each needs a real, working destination this session cannot supply — an SMTP relay, a Twilio account, a Slack/Teams/Discord incoming webhook, a Telegram bot token, a push service. A hand-rolled integration with no real endpoint behind it is a button that does nothing, not a working feature — this is a "which service, and here are the credentials" decision only the user can make.*

**18. Reporting** — ✅ PDF Export · CSV Export · JSON Export. Excel Export ⛔ — needs a new binary-format dependency (e.g. `exceljs`), not implied by anything already here. Scheduled Reports / Daily / Weekly / Monthly Reports ⛔ — blocked on Notification Engine's email capability (#17).

**19. Automation** — **Auto Blacklisting 🆕 / Auto Whitelisting 🆕** (`fraud_lists` table + `server/routes/fraudLists.js`, wired into `scoring.js`). Auto Rule Builder ⛔ / No-Code Rule Engine ⛔ / Adaptive Rule Learning ⛔ / Auto Threshold Learning ⛔ — real product-scale subsystems (a rule-authoring UI; an online-learning retraining loop), not additions that fit in the remaining time.

**20. Security** — ✅ API Key Authentication · Rate Limiting · Security Headers · Configuration Management · Input Validation · XSS Protection · SQL Injection Protection · Secure Logging (all predate this pass, re-verified Sections 15.6/15.15). API Key Management 🔶 — a single shared key, no per-client key issuance/rotation UI. Audit Logs 🔶 — the `flags` table + Audit Trail tab serve this informally; no dedicated immutable log of admin actions (e.g. business-account/fraud-list edits). RBAC ⛔ — needs real users, see #14. CSRF Protection ⛔ — *not actually applicable: this is a header-authenticated JSON API with no cookie/session state for a forged request to ride on, so a CSRF token would be theater, not protection.*

**21. Fraud Intelligence** — **Blacklist Management 🆕 / Whitelist Management 🆕 / Watchlist Management 🆕** (same `fraud_lists` addition as #19). ✅ High-Risk Country Database (`config.js`) · Known Fraud Ring Database (`structuring_alerts`, already the canonical record of every detected ring). Fraud Signature Database 🔶 — the `flag_type` taxonomy across 18 detectors serves this role informally. Known Mule Database 🔶 — computed on demand (`computeMuleScore`), not persisted as a standing list.

**22. Simulator & Demo** — ✅ Normal Transaction Simulation · Refund Fraud Simulation · Structuring Simulation · Velocity Attack Simulation (all predate this pass) · One-Click Demo Scenarios (`scripts/demo.js`). Merchant Takeover Simulation ⛔ / Mule Account Simulation ⛔ / Fraud Ring Simulation 🔶 (structuring covers this) — the detectors themselves are fully built and were demonstrated live via direct API calls (this section's own live-verification pass, and Feature 4/13's test suites); dedicated simulator scenarios for them are a small, real remaining task, not fundamentally blocked. Fraud Replay ⛔ — ties to the Investigation Module, #14.

**23. Performance** — ✅ Low Latency Processing · Background Jobs · Optimized Queries · Database Indexing · Benchmark Tool (all predate this pass). Load Testing ⛔ — beyond `benchmark.js`'s 500-request run, no dedicated load-test suite. Health Monitoring 🔶 — `GET /health` exists, no aggregated uptime/metrics dashboard.

**24. Testing** — ✅ Unit Tests · API Tests · Integration Tests · Dashboard Tests · WebSocket Tests · ML Tests — 220 tests as of this section (up from 128 before Section 15.16). Security Tests 🔶 — covered via the review passes (Sections 15.6, 15.15), not a dedicated automated security-test file. Performance Tests 🔶 — `benchmark.js`.

**25. Documentation** — ✅ API Documentation (Section 7) · Architecture Documentation (this document) · Database Schema (Section 6) · User Manual (`user-manual.md`). Sequence Diagrams ⛔ / Flow Diagrams ⛔ / Deployment Guide ⛔ — not produced as formal diagrams; Section 5's ASCII diagram and Section 12's demo script cover the same ground informally. Developer Guide 🔶 — `CLAUDE.md` + this document serve that role.

**26. Future AI Features** — ⛔ **explicitly out of scope, per the request's own "Future" label, all six:** AI Chat Assistant · Natural Language Fraud Search · AI Fraud Investigation Assistant · AI Fraud Report Generator · Predictive Merchant Risk · AI Fraud Insights. *All six need integrating a real LLM API — a genuine new cost and architectural decision, not something to add as a side effect of a documentation pass.*

**What was actually built in this pass** (all three reuse existing tables/patterns, no new external dependencies) — see `GET /fraud-lists` in Section 7 for the full precedence rules:
- **`server/rules/duplicateTransaction.js`** (Category 2) — flags a transaction that closely duplicates one this business account sent moments ago (same receiver, same amount, within a short window) — a common accidental-double-charge or automated-replay signature distinct from every existing detector.
- **`server/rules/sharedIdentifierRisk.js`** (Category 4/10) — flags when this transaction's `device_id` or `ip_address` has recently been used by other, unrelated accounts — the "shared device/IP graph" reduced to its actual per-transaction signal, without a graph database or visualization layer.
- **`fraud_lists` table + `server/routes/fraudLists.js` + `server/fraudLists.js`** (Categories 19/21) — a blacklist/whitelist/watchlist registry (`list_type`, `account_id`, `reason`, `created_at`), the same editable-registry pattern as `business_accounts`. Checked for every transaction regardless of direction (like the structuring-alert lookup) and wired into `scoring.js`: a blacklisted sender or receiver floors the score at `BLACKLIST_FLOOR` (95, Critical severity); a whitelisted one caps the score at `WHITELIST_CEILING` (5) unless an active structuring alert or a Critical-severity rule flag says otherwise; a watchlisted one adds `WATCHLIST_WEIGHT` (15) without forcing an outcome.

`npm test`: 242 passing (up from 220 before this pass — 22 new tests across the two new detectors, `checkFraudLists`, the scoring-precedence rules, and end-to-end API coverage in the new `tests/fraudLists.test.js`).

---

*Document prepared for Digital Campus 2.0 on Google Cloud — Hack Sprint (24 July 2026). This is the team's single source of truth — keep it up to date as the project evolves.*
