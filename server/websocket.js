// Broadcasts every scored transaction and every new structuring alert to connected dashboard
// clients, per the WebSocket /ws contract in architecture.md Section 7.
const { WebSocketServer } = require('ws');
const { resolveRole } = require('./middleware/apiKeyAuth');
const rateLimit = require('./middleware/rateLimit');

// This server never expects meaningful data *from* a WS client (there's no `ws.on('message', ...)`
// handler anywhere — the feed is broadcast-only) — a small cap costs nothing and bounds how much
// memory `ws` will buffer per incoming frame while parsing it. Left unconfigured, `ws`'s own
// default is 100 MiB per frame, so a client that clears the API-key check could otherwise force a
// large allocation per message even though nothing downstream ever reads it.
const MAX_PAYLOAD_BYTES = 1024;

// rateLimit.js already bounds how *fast* new connections can open; this bounds how many can be
// open *at once*, so a long-running demo session can't accumulate an unbounded number of them
// (each held open, e.g., by a client that never closes cleanly). Configurable via env, same
// pattern as rateLimit.js's RATE_LIMIT_MAX_PER_MINUTE, so tests can shrink it instead of needing
// to actually open hundreds of real connections.
const DEFAULT_MAX_CONCURRENT_CONNECTIONS = 500;
function resolveMaxConcurrentConnections() {
  const raw = process.env.WS_MAX_CONCURRENT_CONNECTIONS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONCURRENT_CONNECTIONS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_CONCURRENT_CONNECTIONS;
}
const MAX_CONCURRENT_CONNECTIONS = resolveMaxConcurrentConnections();

// How often to ping clients and terminate ones that didn't pong back since the previous cycle —
// reaps connections that died without a clean close (network drop, a laptop sleeping mid-demo)
// instead of leaving them in wss.clients until the OS-level TCP timeout eventually notices, which
// can be minutes to hours. Configurable via env for the same testability reason as above.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
function resolveHeartbeatIntervalMs() {
  const raw = process.env.WS_HEARTBEAT_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_HEARTBEAT_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEARTBEAT_INTERVAL_MS;
}
const HEARTBEAT_INTERVAL_MS = resolveHeartbeatIntervalMs();

function attachWebSocketServer(server) {
  // Auth + rate-limit + connection-cap checks all happen here, before the upgrade completes, so a
  // rejected client never gets a connected socket at all. verifyClient references `wss` via
  // closure — safe because `function verifyClient` declarations are hoisted (so it already exists
  // as a value when the WebSocketServer constructor below reads it off the options object), and
  // its body only actually runs later, asynchronously, on a real connection attempt — by which
  // point `wss` (assigned immediately after construction, a few lines down) is already set.
  //
  // Rate-limited first, same as before: this handshake runs entirely outside Express's middleware
  // chain (the `ws` library intercepts the HTTP upgrade before any app.use() middleware ever sees
  // it), so server/index.js's `rateLimit` middleware never applies here on its own. Shares the
  // same per-IP counter as the HTTP API (rateLimit.checkAndRecord) rather than its own independent
  // budget, so splitting a flood across HTTP and WS doesn't effectively double an attacker's
  // allowance.
  function verifyClient(info, callback) {
    const ip = info.req.socket && info.req.socket.remoteAddress;
    if (!rateLimit.checkAndRecord(ip)) {
      return callback(false, 429, 'Too Many Requests');
    }

    if (wss.clients.size >= MAX_CONCURRENT_CONNECTIONS) {
      return callback(false, 503, 'Too Many Connections');
    }

    const url = new URL(info.req.url, 'http://localhost');
    const provided = url.searchParams.get('apiKey');
    // Any recognized key connects (viewer and above) -- the live feed is read-only broadcast,
    // same reasoning as requireApiKey's plain (non-role-gated) checks on GET routes.
    if (!provided || !resolveRole(provided)) {
      return callback(false, 401, 'Unauthorized');
    }
    callback(true);
  }

  const wss = new WebSocketServer({ server, path: '/ws', verifyClient, maxPayload: MAX_PAYLOAD_BYTES });

  // `ws` sockets and the WebSocketServer itself are EventEmitters: an 'error' event with no
  // registered listener throws synchronously at the point ws internally emits it (e.g. an
  // abrupt network drop mid-handshake, a malformed frame, a proxy reset) — completely outside
  // any of this app's own try/catch blocks, since it's ws's internal dispatch, not application
  // code. Left unhandled, that's an uncaught exception that crashes the entire process for
  // every connected dashboard client, not just the one that had the problem — the same failure
  // class already fixed for broadcast()'s client.send() below, just at the socket-error level
  // instead of the send-error level.
  wss.on('error', (err) => {
    console.error('WebSocket server error:', err.message);
  });

  wss.on('connection', (ws) => {
    // Heartbeat state: starts alive, flipped back to true on every pong, checked (and flipped to
    // false again) by the interval below.
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('error', (err) => {
      console.error('WebSocket client connection error:', err.message);
    });

    try {
      ws.send(JSON.stringify({ type: 'connected', data: { message: 'SentinelPay live feed connected' } }));
    } catch (err) {
      console.error('WebSocket welcome message failed:', err.message);
    }
  });

  // Each cycle: terminate anyone who hasn't answered a ping since the previous cycle (isAlive is
  // still false from last time — they never pong'd back), then ping everyone still alive and mark
  // them unanswered again until their next pong. A freshly-connected client always starts isAlive
  // = true, so it gets one full interval before it's ever at risk of being terminated.
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (err) {
        console.error('WebSocket heartbeat ping failed:', err.message);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  // Each client.send() is isolated in its own try/catch: broadcast() is called from the
  // synchronous tail of POST /transaction (after the DB write has already succeeded) and from
  // the background job. One flaky dashboard connection must never turn an already-successful
  // transaction into a 500 response, and must never stop the broadcast reaching other clients.
  wss.broadcast = function broadcast(type, data) {
    const payload = JSON.stringify({ type, data });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(payload);
        } catch (err) {
          console.error('WebSocket broadcast to a client failed:', err.message);
        }
      }
    }
  };

  return wss;
}

module.exports = { attachWebSocketServer, MAX_PAYLOAD_BYTES, MAX_CONCURRENT_CONNECTIONS, HEARTBEAT_INTERVAL_MS };
