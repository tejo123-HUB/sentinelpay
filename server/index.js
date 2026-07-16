require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('node:path');
const fs = require('node:fs');

// Defense-in-depth: modern Node terminates the process on an unhandled promise rejection by
// default. Every known async error path in this app is caught (see routes/transactions.js,
// mlClient.js, backgroundJob.js), but a single missed one anywhere would otherwise take the
// whole fraud-detection API down mid-demo instead of just failing that one request.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (this should not happen — an async path is missing a catch):', err);
});

const { initDb } = require('./db');
const transactionsRouter = require('./routes/transactions');
const { attachWebSocketServer } = require('./websocket');
const { startStructuringJob } = require('./structuring/backgroundJob');
const { requireApiKey, API_KEY } = require('./middleware/apiKeyAuth');
const rateLimit = require('./middleware/rateLimit');
const securityHeaders = require('./middleware/securityHeaders');

const PORT = process.env.PORT || 3000;

const db = initDb();

const app = express();
app.set('trust proxy', false); // req.ip is the direct socket address only — this app doesn't sit behind a known/trusted proxy
app.use(securityHeaders);
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

// Injects the API key into the dashboard's own HTML so the same-origin dashboard can call the
// now-protected API without a real login system (see middleware/apiKeyAuth.js for why this is an
// accepted demo-only limitation, not a hidden secret). Must run before express.static below,
// which would otherwise serve the on-disk index.html as-is with no key in it.
function serveDashboardIndex(req, res) {
  let html;
  try {
    html = fs.readFileSync(indexHtmlPath, 'utf-8');
  } catch (err) {
    return res.status(500).send('Dashboard not found');
  }
  const metaTag = `  <meta name="sentinelpay-api-key" content="${escapeHtmlAttr(API_KEY)}">\n`;
  html = html.replace('</head>', `${metaTag}</head>`);
  res.type('html').send(html);
}
app.get('/', serveDashboardIndex);
app.get('/index.html', serveDashboardIndex);

app.use('/', rateLimit, requireApiKey, transactionsRouter);
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

server.listen(PORT, () => {
  console.log(`SentinelPay listening on port ${server.address().port}`);
});

module.exports = { app, server };
