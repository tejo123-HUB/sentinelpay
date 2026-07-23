// Per-IP sliding-window rate limit. Found during a full-project security review: nothing
// throttled POST /transaction (or any other route), so an unauthenticated — or, post-auth-fix,
// even a key-guessing — caller could flood the endpoint: unbounded SQLite growth, a drowned-out
// structuring background job, or a trivial DoS. Kept dependency-free (no express-rate-limit)
// to match this project's "no native build step, minimal deps" constraints (architecture.md
// Section 9) — this is a small, self-contained in-memory limiter, adequate for a single-process
// demo deployment.
//
// checkAndRecord() is exported separately from the Express middleware because the WebSocket
// upgrade path (server/websocket.js's verifyClient) runs entirely outside Express's middleware
// chain — the `ws` library intercepts the HTTP upgrade before any app.use() middleware sees it —
// so it needs the same rate-limit bookkeeping called directly, not via `rateLimit(req, res, next)`.
const WINDOW_MS = 60 * 1000; // sliding window size
// Generous on purpose: real demo traffic (simulator's continuous stream, the 500-request
// benchmark run, the scripted fraud/structuring/odd-hour scenarios) must never be throttled —
// this exists to blunt an actual flood (thousands of requests/sec), not to police normal use.
const DEFAULT_MAX_PER_WINDOW = 2000;

function resolveMaxPerWindow() {
  const raw = process.env.RATE_LIMIT_MAX_PER_MINUTE;
  // `Number(raw) || DEFAULT` would silently ignore an explicit "0" (0 is falsy), overriding an
  // operator's deliberate "block everything non-exempt" setting with the default instead. Only
  // fall back to the default when the value is genuinely absent or not a usable number.
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_PER_WINDOW;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_PER_WINDOW;
}
const MAX_PER_WINDOW = resolveMaxPerWindow();

const hitsByIp = new Map(); // ip -> timestamps[] (ms), oldest first

// Returns true if this request is allowed (and records it), false if the caller should be
// rejected. Pure bookkeeping, no res/framework dependency, so both the Express middleware below
// and websocket.js's verifyClient can share one counter per IP instead of each having their own
// independent budget (which would have let a flood split across HTTP and WS attempts double the
// effective limit).
function checkAndRecord(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  let timestamps = hitsByIp.get(key);
  if (!timestamps) {
    timestamps = [];
    hitsByIp.set(key, timestamps);
  }
  while (timestamps.length > 0 && timestamps[0] < windowStart) timestamps.shift();

  if (timestamps.length >= MAX_PER_WINDOW) return false;
  timestamps.push(now);
  return true;
}

// Factory for a second, independent per-IP sliding-window limiter with its own budget/window and
// its own state map -- for routes whose real-world cost per request is far higher than "normal"
// traffic (e.g. POST /ai/chat, a real billed LLM API call every time), where the generous global
// 2000/min budget above (tuned to never throttle normal demo traffic) isn't a meaningful cost
// guard. Found during a full-project security review: no route had a stricter budget than the
// global one, so a single valid analyst-role key could trigger up to MAX_PER_WINDOW billed calls
// per minute from one IP with zero dedicated throttle.
function createLimiter(maxPerWindow, windowMs) {
  const hits = new Map();

  function check(ip) {
    const key = ip || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = hits.get(key);
    if (!timestamps) {
      timestamps = [];
      hits.set(key, timestamps);
    }
    while (timestamps.length > 0 && timestamps[0] < windowStart) timestamps.shift();

    if (timestamps.length >= maxPerWindow) return false;
    timestamps.push(now);
    return true;
  }

  function middleware(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress);
    if (!check(ip)) {
      return res.status(429).json({ error: 'Too many requests, slow down' });
    }
    next();
  }

  const cleanup = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, timestamps] of hits) {
      while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift();
      if (timestamps.length === 0) hits.delete(ip);
    }
  }, windowMs);
  if (typeof cleanup.unref === 'function') cleanup.unref();

  middleware.checkAndRecord = check;
  middleware.MAX_PER_WINDOW = maxPerWindow;
  return middleware;
}

// /health is deliberately exempt: it's a liveness check meant to be cheap and always answerable
// (e.g. by a process monitor or load balancer polling it frequently) — throttling it would defeat
// its purpose and doesn't protect anything sensitive (it does no DB work, returns a static body).
function isExempt(req) {
  return req.path === '/health';
}

function rateLimit(req, res, next) {
  if (isExempt(req)) return next();

  const ip = req.ip || (req.socket && req.socket.remoteAddress);
  if (!checkAndRecord(ip)) {
    return res.status(429).json({ error: 'Too many requests, slow down' });
  }
  next();
}

// Without this, an attacker rotating through many distinct source IPs (or just many one-off
// callers over a long-running demo) would grow `hitsByIp` unbounded — a slow memory leak, not
// the fast DoS this middleware exists to stop, but worth closing anyway.
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, timestamps] of hitsByIp) {
    while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift();
    if (timestamps.length === 0) hitsByIp.delete(ip);
  }
}, WINDOW_MS);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

module.exports = rateLimit;
module.exports.checkAndRecord = checkAndRecord;
module.exports.MAX_PER_WINDOW = MAX_PER_WINDOW;
module.exports.WINDOW_MS = WINDOW_MS;
module.exports.createLimiter = createLimiter;
