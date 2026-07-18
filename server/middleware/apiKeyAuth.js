// Shared-secret API key auth. Every route under transactionsRouter (POST /transaction,
// GET /transactions, GET /alerts, GET /audit/summary) and the /ws WebSocket upgrade require it —
// found during a full-project security review: none of these had any authentication at all, so
// anyone who could reach the server could read every user's transaction history (sender_id,
// receiver_id, exact GPS location, amount, device_id) and inject arbitrary transactions.
//
// PROD: the dashboard would sit behind real user auth (SSO/session), with a backend-for-frontend
// holding this key server-side so the browser never sees it. DEMO: there is no login system in
// this hackathon build, so server/index.js hands the key to the dashboard page itself at load
// time (see serveDashboardIndex) so the same-origin dashboard can call the API without one. That
// means anyone who loads the dashboard page can read the key from its own source — an accepted
// limitation of a login-free demo UI, not a secret being kept from that page's own viewer. What
// this *does* stop is anonymous traffic that never engages with this application's UI/API at
// all: internet scanners, drive-by bots hitting well-known endpoints blindly, and casual scraping
// of the transaction-history endpoints.
// Section 16, Category 20 (RBAC): real, working role-based access control without a full user/
// login system. Instead of one shared secret, up to three named keys are recognized -- API_KEY
// (admin, the pre-existing variable, so every existing deployment/test/script that only ever
// set API_KEY keeps working unmodified with full access), API_KEY_ANALYST, and API_KEY_VIEWER
// (both new, optional). Each key genuinely restricts what it can do (checked server-side on
// every request, not just a claimed header) -- this is real access control, not a role label a
// caller could just assert, which is the difference between this and doing nothing at all.
const crypto = require('node:crypto');

// Insecure by design (a fixed, published-in-source-control value) and intentionally so: it exists
// only so the server and the standalone CLI tools (simulator, benchmark) that talk to it over HTTP
// can agree on a key without any shared runtime state, for pure localhost demo use where nothing
// sensitive is actually at stake. Anything reachable beyond localhost MUST set a real API_KEY in
// .env — this module warns loudly on every startup if it's still in use.
const DEFAULT_DEV_API_KEY = 'sentinelpay-local-demo-insecure-default-change-me';

function resolveApiKey() {
  const configured = process.env.API_KEY && process.env.API_KEY.trim();
  if (configured) return { key: configured, isDefault: false };
  return { key: DEFAULT_DEV_API_KEY, isDefault: true };
}

const { key: API_KEY, isDefault: USING_DEFAULT_API_KEY } = resolveApiKey();

if (USING_DEFAULT_API_KEY && process.env.NODE_ENV !== 'test') {
  console.warn(
    '\n[security] No API_KEY set in the environment — using the built-in insecure development ' +
      'default.\n[security] This is fine for a local-only demo, but do NOT expose this server ' +
      'beyond localhost without\n[security] setting a real API_KEY in .env first (see ' +
      '.env.example for how to generate one).\n'
  );
}

// Role rank, low to high -- a caller's role must rank at or above a route's minimum to pass.
const ROLE_RANK = { viewer: 1, analyst: 2, admin: 3 };

// Analyst/viewer keys are optional and additive: unset by default, so a deployment that only
// ever configured API_KEY (the pre-existing, only variable) behaves exactly as before -- that
// one key is admin, full access, nothing else recognized. Configuring the new variables is what
// actually turns on multi-role access, not a behavior change forced on existing setups.
const ANALYST_KEY = (process.env.API_KEY_ANALYST || '').trim() || null;
const VIEWER_KEY = (process.env.API_KEY_VIEWER || '').trim() || null;

const KEY_ROLES = [
  { key: API_KEY, role: 'admin' },
  ...(ANALYST_KEY ? [{ key: ANALYST_KEY, role: 'analyst' }] : []),
  ...(VIEWER_KEY ? [{ key: VIEWER_KEY, role: 'viewer' }] : []),
];

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf-8');
  const bufB = Buffer.from(String(b ?? ''), 'utf-8');
  // crypto.timingSafeEqual requires equal-length buffers; a length mismatch is itself safe to
  // branch on early (it leaks only the length of a rejection, not which bytes matched).
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Checks the provided key against every configured key (not just the admin one) and returns the
// matched role, or null. Every comparison runs (no early-exit on first non-match) so the total
// time taken doesn't leak which configured key, if any, came close to matching.
function resolveRole(providedKey) {
  let matchedRole = null;
  for (const { key, role } of KEY_ROLES) {
    if (timingSafeStringEqual(providedKey, key)) matchedRole = role;
  }
  return matchedRole;
}

// Unchanged name/behavior for backward compatibility with every existing route/test: passes for
// any recognized key regardless of role (the old "one shared secret" behavior generalizes
// exactly to "any valid key, viewer or above" once roles exist at all).
function requireApiKey(req, res, next) {
  const provided = req.get('X-API-Key');
  const role = provided ? resolveRole(provided) : null;
  if (!role) {
    return res.status(401).json({ error: 'Missing or invalid X-API-Key header' });
  }
  req.apiKeyRole = role;
  next();
}

// requireRole('analyst') etc. -- stack this AFTER requireApiKey on a route (requireApiKey
// establishes req.apiKeyRole; this checks it meets the route's minimum). Kept as a separate
// middleware rather than folded into requireApiKey so routes that don't need elevated access
// keep using the simpler, unchanged requireApiKey alone.
function requireRole(minRole) {
  const minRank = ROLE_RANK[minRole];
  return (req, res, next) => {
    const rank = ROLE_RANK[req.apiKeyRole] || 0;
    if (rank < minRank) {
      return res.status(403).json({ error: `This action requires the '${minRole}' role or higher` });
    }
    next();
  };
}

module.exports = {
  requireApiKey,
  requireRole,
  resolveRole,
  timingSafeStringEqual,
  API_KEY,
  DEFAULT_DEV_API_KEY,
  USING_DEFAULT_API_KEY,
  ANALYST_KEY,
  VIEWER_KEY,
};
