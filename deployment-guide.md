# Deployment Guide

Section 16, Category 25. This is the "how do I actually run this somewhere" companion to
`architecture.md` (design/schema/API reference) and `README.md` (local dev quickstart, demo
scripts, test suite). It covers two things: running the current demo build somewhere real, and
what changes when it grows into the production architecture `architecture.md` Section 5 describes.

## 1. Local development

See `README.md`'s **Requirements**/**Setup**/**Running the demo** sections for the full
step-by-step (`npm install`, `npm run seed`, `npm start`, `npm run simulate`). Summary:

```
npm install
cp .env.example .env      # then edit — see Section 2 below
npm start                 # http://127.0.0.1:3000
```

No database server, message queue, or external service is required to run this locally — SQLite
(`node:sqlite`, built into Node 22+) is a single file, created automatically on first run.

## 2. Environment variables

`.env.example` is the authoritative, fully-commented reference — copy it to `.env` and adjust.
Grouped summary:

| Concern | Variables | Notes |
|---|---|---|
| Server | `PORT`, `HOST`, `DB_PATH` | `HOST` defaults to `127.0.0.1` while the insecure default API key is in use — see below |
| Auth | `API_KEY`, `API_KEY_ANALYST`, `API_KEY_VIEWER` | **Set a real `API_KEY` before deploying anywhere beyond localhost.** Generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. The analyst/viewer keys are optional — unset means single-admin-key behavior, unchanged from before RBAC existed |
| Rate limiting | `RATE_LIMIT_MAX_PER_MINUTE` | Per-IP, sliding 60s window, every route. Lower this before exposing the server beyond a trusted network |
| ML serving | `ML_SERVING_MODE`, `ML_SERVICE_URL`, `VERTEX_AI_ENDPOINT_URL`, `VERTEX_AI_API_KEY` | `local` (default) calls `ml/serve.py` over HTTP; `vertex` calls a real Vertex AI endpoint — see Section 3 |
| Structuring job | `STRUCTURING_JOB_INTERVAL_MS` | Background graph-analysis tick interval |
| Notifications | `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, `TWILIO_*`, `SMTP_*`, `ALERT_EMAIL_*` | Each channel activates the moment its own variables are set — no code change, no redeploy. Leave a channel unset to skip it silently |

**Before deploying anywhere reachable beyond localhost:**
1. Set a real `API_KEY` (and `API_KEY_ANALYST`/`API_KEY_VIEWER` if you want tiered access — Category 20 RBAC).
2. Set `HOST=0.0.0.0` explicitly (it will not default to that while `API_KEY` is unset — see `server/middleware/apiKeyAuth.js`).
3. Put a real reverse proxy / TLS terminator in front of it (Node here serves plain HTTP; nothing in this project terminates TLS itself).
4. Review `RATE_LIMIT_MAX_PER_MINUTE` for the traffic you actually expect.

## 3. What's a demo stand-in for what (PROD/DEMO map)

Every substitution below is called out at its own definition site in code with a
`// PROD: X — DEMO: Y` comment (`CLAUDE.md`'s hard rule), so it's never silently passed off as the
real thing:

| Concern | DEMO (this build, runs today) | PROD (`architecture.md` Section 5) | What changes to get there |
|---|---|---|---|
| Datastore | SQLite, single file (`server/db.js`), still the only primary/tested data layer | Cloud Spanner | `server/spannerPoc.js` (24 July 2026) is a real, working `@google-cloud/spanner` client — schema DDL, insert, and query — proven against a real Spanner instance via `npm run spanner:poc`, but deliberately **not** wired in as the primary database: a full dialect migration across every query in this codebase was assessed as too risky this late in a 525+-test build. Treat it as a proof that the integration works, not a drop-in replacement yet |
| ML inference | Local process (`ml/serve.py`, scikit-learn-trained logistic regression) over HTTP | Vertex AI online-prediction endpoint | Genuinely implemented (24 July 2026) — set `ML_SERVING_MODE=vertex` + `VERTEX_AI_PROJECT_ID`/`VERTEX_AI_LOCATION`/`VERTEX_AI_ENDPOINT_ID` + `GOOGLE_APPLICATION_CREDENTIALS`, pointed at a model you've already deployed to a Vertex AI Endpoint (provisioning that endpoint is outside this repo's scope) — `server/ml/mlClient.js`'s `scoreViaVertexAi` makes a real `PredictionServiceClient.predict()` call, no longer a stub |
| Dashboard auth | Shared API key handed to the dashboard page at load time (`server/middleware/apiKeyAuth.js`) | Real user auth (SSO/session) behind a backend-for-frontend that holds the key server-side | Requires standing up a login system this build has never had (an explicitly declined scope item, `architecture.md` Section 16 Category 20) |
| API host | Node process directly on a VM/laptop | Cloud Run (stateless HTTP container, scales to zero) | A real, working `Dockerfile` + `.dockerignore` now ship in the repo root — see Section 4 below. Point `DB_PATH` at persistent storage (or use the Cloud Spanner proof-of-concept module, `server/spannerPoc.js`) for anything beyond a demo deploy |
| Evidence storage | Local filesystem, `data/evidence/` (`server/caseEvidence.js`) | Cloud Storage | Genuinely implemented (24 July 2026) — set `GCS_BUCKET_NAME` + `GOOGLE_APPLICATION_CREDENTIALS`; `writeEvidenceFile`/`readEvidenceFile`/`deleteEvidenceFile` transparently switch to the `@google-cloud/storage` SDK, no route/schema change |
| Notification credentials | Real webhooks/Twilio/SMTP, but operator-supplied via `.env` | Same, ideally via Secret Manager rather than plaintext `.env` on the host | Swap the `.env` read for a Secret Manager fetch at boot; `server/notifications.js`'s channel logic is unaffected |

## 4. Containerizing for Cloud Run

A real `Dockerfile` + `.dockerignore` ship in the repo root (24 July 2026) — `node:22-slim` base
(matches this project's `engines.node >= 22.5.0` requirement for `node:sqlite`), installs
production dependencies only via `npm ci --omit=dev` against the committed lockfile, copies just
`server/`, `dashboard/`, and the committed `ml/model_export/model.json` (training scripts,
`ml/.venv`, tests, and dev scripts are excluded), runs as the non-root `node` user, and listens on
`$PORT` (Cloud Run injects `8080`; `server/index.js` already resolves `PORT`/`HOST` this way — no
application code change was needed).

Build and run locally to verify before deploying:

```bash
docker build -t sentinelpay .
docker run -p 8080:8080 --env-file .env sentinelpay
```

Deploy to Cloud Run (requires the `gcloud` CLI, a GCP project with billing enabled, and the Cloud
Run + Artifact Registry APIs turned on — none of which this repository can provision for you):

```bash
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/sentinelpay
gcloud run deploy sentinelpay \
  --image gcr.io/YOUR_PROJECT_ID/sentinelpay \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars API_KEY=YOUR_REAL_KEY,GEMINI_API_KEY=YOUR_KEY \
  --set-secrets GOOGLE_APPLICATION_CREDENTIALS=sentinelpay-gcp-sa:latest
```

Notes:
- `--allow-unauthenticated` matches this project's own API-key auth model (Section 2) — Cloud Run
  IAM auth is a separate, stricter option if you don't want the service publicly reachable at all.
- Prefer `--set-secrets` (Secret Manager) over `--set-env-vars` for anything sensitive
  (`API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`'s key material, notification credentials) — the
  example above puts `API_KEY`/`GEMINI_API_KEY` inline only for brevity.
- The container's local filesystem (SQLite `DB_PATH`, evidence uploads when `GCS_BUCKET_NAME` is
  unset) is ephemeral on Cloud Run — fine for a short-lived demo, not for anything you need to
  persist. Point `GCS_BUCKET_NAME` at a real bucket for evidence, and treat `DB_PATH`'s SQLite file
  as scratch space unless/until this deployment moves to the Spanner proof-of-concept module
  (`server/spannerPoc.js`, Section 3 above) becoming the primary datastore.

## 5. Health checks and observability

- `GET /health` — liveness/readiness check, exempt from rate limiting.
- `GET /audit/summary?hours=&bucketMinutes=` — time-bucketed allow/step_up/block counts, the closest thing to an operational dashboard this build has (`architecture.md` Section 16 Category 23 notes there's no separate aggregated uptime/metrics dashboard beyond this).
- `simulator/loadTest.js` (Category 23) — run against a staging deployment before a real launch to confirm the `<150ms` latency target (`architecture.md` Section 11) holds under the concurrency you actually expect, not just the sequential `benchmark.js` run.
