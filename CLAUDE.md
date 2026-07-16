# CLAUDE.md

## Project
SentinelPay — a real-time fraud-detection API for micro-transactions, with a structuring/money-laundering detection engine. Built for a hackathon with a 21 July 2026 deadline.

## Before doing anything
Read **`architecture.md`** in this repo fully. It is the single source of truth for:
- Project overview, problem, and feature list
- Database schema and API contract
- Repository structure
- The full day-by-day build plan (5 days, 12 tasks, each with a Definition of Done)
- Known risks and required fallbacks
- Coding conventions

Work through the tasks in `architecture.md` Section 10 in order, one at a time. Don't start a task until the previous one's Definition of Done is met. If a task is running significantly over its estimate, stop and flag it rather than pushing ahead — Section 11 has the agreed cut order for falling behind.

## Hard rules (do not deviate without asking)
- `sender_id`/`receiver_id` must be in the schema from the first migration — do not retrofit them later.
- Scoring happens synchronously within `POST /transaction` — no async/polling pattern.
- Every flag or alert needs a human-readable `reason` string, never just a score.
- Any demo/local stand-in for a production GCP service must be commented `// PROD: X — DEMO: Y`.
- Do not cut the structuring/graph engine (Task 6) if the timeline gets tight — see the cut order in `architecture.md` Section 11 instead.

## Tech stack — mutable, decided at build time
`architecture.md` Section 9 lists a proposed stack, but it is **not fixed**. The actual choice (language, framework, database, ML serving approach, etc.) is a live decision made together by Claude Code and the user at the time a task is tackled — priorities like team familiarity, time remaining, and what's actually working may reasonably change it. Do not treat Section 9 as binding just because it's written down.

**The one rule that matters here is avoiding drift:** whenever the tech stack decision changes from what's in `architecture.md`, update Section 9 in the same commit/session before moving on — don't let the doc silently fall out of sync with what the code actually does. If you're ever unsure whether the current code matches Section 9, check before adding to it, and reconcile the doc if it doesn't.

## Keeping this in sync (anti-drift)
`architecture.md` is a living document, not a frozen spec — it's expected to change as the project evolves. What's not allowed is letting it quietly go stale. Concretely:
- If an implementation decision changes anything documented in `architecture.md` (a threshold, a schema field, a tech choice, which ML path was used, a task's scope), update `architecture.md` in the same commit.
- At the start of a new session, skim `architecture.md` against the current state of the repo (schema, package.json, key files) before trusting it at face value — flag and reconcile any mismatch you find rather than building on top of it.
- This file (`CLAUDE.md`) should stay short — put substance in `architecture.md`, not here.
