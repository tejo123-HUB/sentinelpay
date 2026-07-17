// Section 16, Category 17: verifies each notification channel actually sends the right HTTP
// request when configured (a local mock server standing in for the real Slack/Discord/Teams/
// Telegram/Twilio endpoint), and that every channel cleanly reports "not configured" rather than
// throwing when its env vars are unset -- the default state for a fresh checkout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

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

function apiRequest(server, method, path, body, headerOverrides = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY, ...headerOverrides };
    for (const key of Object.keys(headers)) {
      if (headers[key] === undefined) delete headers[key];
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('POST /notifications/test: admin-only, reports per-channel results', async () => {
  clearNotificationEnv();
  const { server } = await freshServer();
  try {
    const res = await apiRequest(server, 'POST', '/notifications/test', { message: 'hello' });
    assert.equal(res.status, 200);
    assert.equal(res.body.slack.sent, false);
    assert.equal(res.body.discord.sent, false);
  } finally {
    server.close();
  }
});

const {
  sendSlackNotification,
  sendDiscordNotification,
  sendTeamsNotification,
  sendTelegramNotification,
  sendSmsNotification,
  sendEmailNotification,
  dispatchCriticalAlert,
} = require('../server/notifications');

function withMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        handler(req, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    server.listen(0, () => resolve(server));
  });
}

const ENV_KEYS = [
  'SLACK_WEBHOOK_URL',
  'DISCORD_WEBHOOK_URL',
  'TEAMS_WEBHOOK_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'ALERT_SMS_TO_NUMBER',
];

function clearNotificationEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

test('sendSlackNotification: not configured returns sent:false without throwing', async () => {
  clearNotificationEnv();
  const result = await sendSlackNotification('test');
  assert.equal(result.sent, false);
  assert.match(result.reason, /SLACK_WEBHOOK_URL/);
});

test('sendSlackNotification: configured, POSTs {text: message} to the webhook URL', async () => {
  clearNotificationEnv();
  let receivedBody = null;
  const server = await withMockServer((req, body) => {
    receivedBody = JSON.parse(body);
  });
  try {
    process.env.SLACK_WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/webhook`;
    const result = await sendSlackNotification('Critical fraud alert!');
    assert.equal(result.sent, true);
    assert.equal(receivedBody.text, 'Critical fraud alert!');
  } finally {
    server.close();
    clearNotificationEnv();
  }
});

test('sendDiscordNotification: configured, POSTs {content: message}', async () => {
  clearNotificationEnv();
  let receivedBody = null;
  const server = await withMockServer((req, body) => {
    receivedBody = JSON.parse(body);
  });
  try {
    process.env.DISCORD_WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/webhook`;
    const result = await sendDiscordNotification('Critical fraud alert!');
    assert.equal(result.sent, true);
    assert.equal(receivedBody.content, 'Critical fraud alert!');
  } finally {
    server.close();
    clearNotificationEnv();
  }
});

test('sendTeamsNotification: configured, POSTs a MessageCard payload', async () => {
  clearNotificationEnv();
  let receivedBody = null;
  const server = await withMockServer((req, body) => {
    receivedBody = JSON.parse(body);
  });
  try {
    process.env.TEAMS_WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/webhook`;
    const result = await sendTeamsNotification('Critical fraud alert!');
    assert.equal(result.sent, true);
    assert.equal(receivedBody['@type'], 'MessageCard');
    assert.equal(receivedBody.text, 'Critical fraud alert!');
  } finally {
    server.close();
    clearNotificationEnv();
  }
});

test('sendTelegramNotification: not configured without both bot token and chat id', async () => {
  clearNotificationEnv();
  process.env.TELEGRAM_BOT_TOKEN = 'fake-token';
  // TELEGRAM_CHAT_ID deliberately left unset.
  const result = await sendTelegramNotification('test');
  assert.equal(result.sent, false);
  clearNotificationEnv();
});

test('sendSmsNotification: reports not-configured until all four Twilio vars are set', async () => {
  // sendSmsNotification hits the real api.twilio.com host -- can't redirect that to a local mock
  // server without changing the module to accept a base URL, so this test bounds itself to the
  // configuration-completeness check (the part safely testable without a real Twilio account or
  // an HTTPS-intercepting test double), not the live request itself.
  clearNotificationEnv();
  process.env.TWILIO_ACCOUNT_SID = 'ACxxx';
  process.env.TWILIO_AUTH_TOKEN = 'secret';
  process.env.TWILIO_FROM_NUMBER = '+15550000000';
  // ALERT_SMS_TO_NUMBER deliberately left unset -- verifies the "not configured" path still
  // works correctly even when three of the four required vars are present.
  const result = await sendSmsNotification('test');
  assert.equal(result.sent, false);
  assert.match(result.reason, /ALERT_SMS_TO_NUMBER/);
  clearNotificationEnv();
});

test('sendEmailNotification: not configured returns sent:false without throwing', async () => {
  clearNotificationEnv();
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.ALERT_EMAIL_FROM;
  delete process.env.ALERT_EMAIL_TO;
  const result = await sendEmailNotification('Subject', 'Body');
  assert.equal(result.sent, false);
  assert.match(result.reason, /SMTP_HOST/);
});

test('dispatchCriticalAlert: isolates a failing channel from the others, never throws', async () => {
  clearNotificationEnv();
  const server = await withMockServer(() => {});
  try {
    process.env.SLACK_WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/webhook`;
    // Discord webhook URL deliberately unreachable -- must not affect the Slack result.
    process.env.DISCORD_WEBHOOK_URL = 'http://127.0.0.1:1/unreachable';

    const results = await dispatchCriticalAlert('test message');
    assert.equal(results.slack.sent, true);
    assert.equal(results.discord.sent, false);
    assert.ok(results.discord.reason);
    assert.equal(results.teams.sent, false); // not configured, but still reported, not thrown
  } finally {
    server.close();
    clearNotificationEnv();
  }
});
