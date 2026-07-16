// Per-IP sliding-window rate limit. Found during a full-project security review: nothing
// throttled POST /transaction (or any other route), so an unauthenticated — or, post-auth-fix,
// even a key-guessing — caller could flood the endpoint: unbounded SQLite growth, a drowned-out
// structuring background job, or a trivial DoS. Kept dependency-free (no express-rate-limit)
// to match this project's "no native build step, minimal deps" constraints (architecture.md
// Section 9) — this is a small, self-contained in-memory limiter, adequate for a single-process
// demo deployment.
const WINDOW_MS = 60 * 1000; // sliding window size
// Generous on purpose: real demo traffic (simulator's continuous stream, the 500-request
// benchmark run, the scripted fraud/structuring/odd-hour scenarios) must never be throttled —
// this exists to blunt an actual flood (thousands of requests/sec), not to police normal use.
const DEFAULT_MAX_PER_WINDOW = 2000;
const MAX_PER_WINDOW = Number(process.env.RATE_LIMIT_MAX_PER_MINUTE) || DEFAULT_MAX_PER_WINDOW;

const hitsByIp = new Map(); // ip -> timestamps[] (ms), oldest first

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  let timestamps = hitsByIp.get(ip);
  if (!timestamps) {
    timestamps = [];
    hitsByIp.set(ip, timestamps);
  }
  while (timestamps.length > 0 && timestamps[0] < windowStart) timestamps.shift();

  if (timestamps.length >= MAX_PER_WINDOW) {
    return res.status(429).json({ error: 'Too many requests, slow down' });
  }

  timestamps.push(now);
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
module.exports.MAX_PER_WINDOW = MAX_PER_WINDOW;
module.exports.WINDOW_MS = WINDOW_MS;
module.exports._hitsByIp = hitsByIp; // test-only escape hatch
