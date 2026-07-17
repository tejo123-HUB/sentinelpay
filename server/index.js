require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('node:path');
const fs = require('node:fs');

// Defense-in-depth: modern Node terminates the process on an unhandled promise rejection by
// default. Every known async error path in this app is caught (see routes/transactions.js,
// mlClient.js, backgroundJob.js), but a single missed one anywhere would otherwise take the
// whole fraud-detection API down mid-demo instead of just failing that one request.
//
// Guarded against double-registration: this module only loads once in real production use, but
// the test suite deliberately re-requires it many times per file (clearing require.cache to get
// a fresh app/server instance per test) — without this guard, each re-require added another
// listener that was never cleaned up, eventually tripping Node's MaxListenersExceededWarning as
// the test suite grew (a real leak surfaced by, not caused by, adding more tests).
if (!process.__sentinelpayUnhandledRejectionHandlerInstalled) {
  process.__sentinelpayUnhandledRejectionHandlerInstalled = true;
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled promise rejection (this should not happen — an async path is missing a catch):', err);
  });
}

const { initDb } = require('./db');
const transactionsRouter = require('./routes/transactions');
const businessAccountsRouter = require('./routes/businessAccounts');
const { attachWebSocketServer } = require('./websocket');
const { startStructuringJob } = require('./structuring/backgroundJob');
const { API_KEY, USING_DEFAULT_API_KEY } = require('./middleware/apiKeyAuth');
const rateLimit = require('./middleware/rateLimit');
const securityHeaders = require('./middleware/securityHeaders');

const PORT = process.env.PORT || 3000;

const db = initDb();

const app = express();
app.set('trust proxy', false); // req.ip is the direct socket address only — this app doesn't sit behind a known/trusted proxy
app.use(securityHeaders);
// Applied globally (before auth, before routing) — not just in front of transactionsRouter as
// originally scoped. That left GET /, GET /index.html, and every static dashboard asset (each
// doing real per-request work: a disk read for the HTML route, file serving for the rest)
// completely unthrottled, undercutting the point of adding rate limiting at all. /health is
// exempt internally (see rateLimit.js) so liveness checks stay cheap and unaffected.
app.use(rateLimit);
app.use(express.json());

app.locals.db = db;

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const dashboardDir = path.join(__dirname, '..', 'dashboard');
const indexHtmlPath = path.join(dashboardDir, 'index.html');

function escapeHtmlAttr(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Read once at startup, not per-request: index.html doesn't change while the server is running
// (same trade-off as mlClient.js's cachedModel — a restart is required to pick up on-disk edits,
// acceptable for a demo server). Avoids a synchronous disk read on every single dashboard load.
let cachedIndexHtmlTemplate = null;
function loadIndexHtmlTemplate() {
  if (cachedIndexHtmlTemplate === null) {
    cachedIndexHtmlTemplate = fs.readFileSync(indexHtmlPath, 'utf-8');
  }
  return cachedIndexHtmlTemplate;
}

// Injects the API key into the dashboard's own HTML so the same-origin dashboard can call the
// now-protected API without a real login system (see middleware/apiKeyAuth.js for why this is an
// accepted demo-only limitation, not a hidden secret). Must run before express.static below,
// which would otherwise serve the on-disk index.html as-is with no key in it.
function serveDashboardIndex(req, res) {
  let template;
  try {
    template = loadIndexHtmlTemplate();
  } catch (err) {
    return res.status(500).send('Dashboard not found');
  }
  const metaTag = `  <meta name="sentinelpay-api-key" content="${escapeHtmlAttr(API_KEY)}">\n`;
  const html = template.replace('</head>', `${metaTag}</head>`);
  res.type('html').send(html);
}
app.get('/', serveDashboardIndex);
app.get('/index.html', serveDashboardIndex);

// requireApiKey is applied per-route inside transactionsRouter itself (server/routes/
// transactions.js), not here. Mounting it here via `app.use('/', requireApiKey, ...)` would run
// it for every request that reaches this line — including ones no route in transactionsRouter
// actually matches, like /style.css, /app.js, /map.js, /audit.js — rejecting them with 401 before
// they could ever fall through to express.static below. That was a real bug (found live, in an
// actual browser, not curl): the dashboard's own stylesheet and scripts can't carry an X-API-Key
// header (browsers don't attach custom headers to <link>/<script src> loads the way authFetch()'s
// explicit fetch() calls can), so the entire dashboard rendered unstyled and inert. See the
// comment on transactionsRouter's requireApiKey import for the full explanation.
app.use('/', transactionsRouter);
app.use('/', businessAccountsRouter);
app.use(express.static(dashboardDir));

// Malformed JSON body -> 400 with a clear message, instead of falling through to the
// generic 500 handler below.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON' });
  }
  next(err);
});

// Catch-all: anything unexpected (DB errors, etc.) becomes a 500 instead of crashing the process.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);
const wss = attachWebSocketServer(server);
app.locals.wss = wss;

startStructuringJob(db, (type, data) => {
  if (wss && typeof wss.broadcast === 'function') wss.broadcast(type, data);
});

// Without an explicit HOST, Node binds to all network interfaces (0.0.0.0) by default — so a
// forgotten API_KEY didn't just mean "insecure," it meant "insecure and reachable by every other
// device on whatever network this machine is connected to" (a real scenario for a laptop demoed
// on hackathon venue WiFi). A console warning alone doesn't stop that. Concretely restricting the
// bind address to localhost whenever the published, insecure default key is still in use closes
// the actual exposure, not just the awareness of it — set HOST explicitly (with a real API_KEY)
// to opt back into listening on other interfaces.
const HOST = process.env.HOST || (USING_DEFAULT_API_KEY ? '127.0.0.1' : undefined);
if (USING_DEFAULT_API_KEY && !process.env.HOST && process.env.NODE_ENV !== 'test') {
  console.warn(
    '[security] Binding to 127.0.0.1 only (not other network interfaces) because the insecure ' +
      'default API key is in use.\n[security] Set HOST=0.0.0.0 (with a real API_KEY in .env) to ' +
      'allow connections from other devices on your network.\n'
  );
}

const listenCallback = () => {
  console.log(`SentinelPay listening on port ${server.address().port}${HOST ? ` (bound to ${HOST})` : ''}`);
};
if (HOST) {
  server.listen(PORT, HOST, listenCallback);
} else {
  server.listen(PORT, listenCallback);
}

module.exports = { app, server };
