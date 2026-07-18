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
| Datastore | SQLite, single file (`server/db.js`) | Cloud Spanner | Swap `node:sqlite`'s `DatabaseSync` for the Spanner Node client; the schema (Section 6) and every parameterized query pattern carry over directly — no query logic redesign needed, since this project never used SQLite-specific syntax beyond `PRAGMA`/`node:sqlite`'s API surface |
| ML inference | Local process (`ml/serve.py`, scikit-learn-trained logistic regression) over HTTP | Vertex AI edge-deployed endpoint | Set `ML_SERVING_MODE=vertex` + `VERTEX_AI_ENDPOINT_URL`/`VERTEX_AI_API_KEY` — `server/ml/mlClient.js` already branches on this env var; no application code change |
| Dashboard auth | Shared API key handed to the dashboard page at load time (`server/middleware/apiKeyAuth.js`) | Real user auth (SSO/session) behind a backend-for-frontend that holds the key server-side | Requires standing up a login system this build has never had (an explicitly declined scope item, `architecture.md` Section 16 Category 20) |
| API host | Node process directly on a VM/laptop | Cloud Run (stateless HTTP container, scales to zero) | Containerize (`Dockerfile` not yet written — see Section 4 below), point at a real Spanner instance, no code change otherwise |
| Notification credentials | Real webhooks/Twilio/SMTP, but operator-supplied via `.env` | Same, ideally via Secret Manager rather than plaintext `.env` on the host | Swap the `.env` read for a Secret Manager fetch at boot; `server/notifications.js`'s channel logic is unaffected |

## 4. Containerizing for Cloud Run (not yet built)

No `Dockerfile` exists in this repository yet — this build has only ever been run as a bare Node
process (local dev, or a demo VM). A future pass adding one would need:

- Base image: `node:22-slim` (matches this project's `engines.node >= 22.5.0` requirement for `node:sqlite`).
- `DB_PATH` pointed at a Cloud Run-mountable volume, or — if moving straight to Spanner per Section 3 above — no local file at all.
- `PORT` read from Cloud Run's injected `$PORT` (already how `server/index.js` resolves it).
- Secrets (`API_KEY`, notification credentials) injected via Cloud Run's Secret Manager integration, not baked into the image.

This is scoped out deliberately rather than half-built: a real containerization pass deserves its
own verified `Dockerfile` + `.dockerignore` + a genuine deployed test, not a guessed-at config file
nobody has run.

## 5. Health checks and observability

- `GET /health` — liveness/readiness check, exempt from rate limiting.
- `GET /audit/summary?hours=&bucketMinutes=` — time-bucketed allow/step_up/block counts, the closest thing to an operational dashboard this build has (`architecture.md` Section 16 Category 23 notes there's no separate aggregated uptime/metrics dashboard beyond this).
- `simulator/loadTest.js` (Category 23) — run against a staging deployment before a real launch to confirm the `<150ms` latency target (`architecture.md` Section 11) holds under the concurrency you actually expect, not just the sequential `benchmark.js` run.
