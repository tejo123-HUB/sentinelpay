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

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf-8');
  const bufB = Buffer.from(String(b ?? ''), 'utf-8');
  // crypto.timingSafeEqual requires equal-length buffers; a length mismatch is itself safe to
  // branch on early (it leaks only the length of a rejection, not which bytes matched).
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireApiKey(req, res, next) {
  const provided = req.get('X-API-Key');
  if (!provided || !timingSafeStringEqual(provided, API_KEY)) {
    return res.status(401).json({ error: 'Missing or invalid X-API-Key header' });
  }
  next();
}

module.exports = { requireApiKey, timingSafeStringEqual, API_KEY, DEFAULT_DEV_API_KEY, USING_DEFAULT_API_KEY };
