// Partial-Feature Completion Pass: ML & AI's Predictive Fraud Forecasting gap.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { predictSeries } = require('../server/forecasting');

test('predictSeries: too few points returns an empty forecast, not a wild extrapolation', () => {
  const result = predictSeries([1, 2], 5);
  assert.deepEqual(result.forecast, []);
  assert.equal(result.trend, 'flat');
});

test('predictSeries: a clearly rising series forecasts higher values and trend "rising"', () => {
  const result = predictSeries([1, 2, 3, 4, 5], 3);
  assert.equal(result.forecast.length, 3);
  assert.ok(result.forecast[0] > 5, `expected forecast to continue rising, got ${result.forecast[0]}`);
  assert.equal(result.trend, 'rising');
});

test('predictSeries: a flat series forecasts near the same value and trend "flat"', () => {
  const result = predictSeries([10, 10, 10, 10, 10], 3);
  assert.equal(result.trend, 'flat');
  for (const v of result.forecast) assert.ok(Math.abs(v - 10) < 1);
});

test('predictSeries: a falling series never forecasts a negative value', () => {
  const result = predictSeries([5, 4, 3, 2, 1], 6);
  for (const v of result.forecast) assert.ok(v >= 0);
});

// ---- endpoint smoke tests ----

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.API_KEY = 'test-key-for-automated-tests';

function freshServer() {
  delete require.cache[require.resolve('../server/index')];
  delete require.cache[require.resolve('../server/middleware/rateLimit')];
  delete require.cache[require.resolve('../server/websocket')];
  const { app, server } = require('../server/index');
  return new Promise((resolve) => {
    if (server.listening) return resolve({ app, server });
    server.once('listening', () => resolve({ app, server }));
  });
}

function request(server, method, path) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const headers = { 'X-API-Key': process.env.API_KEY };
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /analytics/forecast: returns a well-formed response even with no data yet', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/analytics/forecast?bucket=hour');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.flagged_transactions.forecast));
    assert.ok(Array.isArray(res.body.blocked_amount.forecast));
  } finally {
    server.close();
  }
});

test('GET /merchants/:id/risk-forecast: returns a well-formed response with no history', async () => {
  const { server } = await freshServer();
  try {
    const res = await request(server, 'GET', '/merchants/m_never_seen/risk-forecast');
    assert.equal(res.status, 200);
    assert.equal(res.body.history_points, 0);
    assert.deepEqual(res.body.forecast, []);
  } finally {
    server.close();
  }
});
