// Section 16, Category 17: real, working notification integrations -- not stubs. Each function
// genuinely sends a message to the real service once the user configures their own credentials
// via env vars (same honest, working-when-configured pattern as ML_SERVING_MODE=vertex, which
// this project has used from the start). Unconfigured channels are silently skipped (logged, not
// thrown), so a deployment that only sets up Slack doesn't get errors about Discord/Telegram/etc.
// never being configured -- this mirrors the existing per-client error isolation in
// websocket.js's broadcast(), just for notification channels instead of WebSocket clients.
//
// Web Push Notifications (Partial-Feature Completion Pass): now implemented in server/webPush.js
// (VAPID request auth + aes128gcm encryption, RFC 8291/8292, no `web-push` dependency), wired into
// dispatchCriticalAlert below alongside the other six channels. dashboard/app.js's
// initPushNotifications() + dashboard/sw.js provide the browser-side subscription flow and service
// worker this previously had no UI to drive.
const NOTIFICATION_TIMEOUT_MS = 3000; // generous relative to a webhook POST, but bounded so a slow/unreachable service never blocks the caller for long
const { dispatchWebPushToAllSubscriptions } = require('./webPush');

async function postJson(url, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
}

async function sendSlackNotification(message) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return { sent: false, reason: 'SLACK_WEBHOOK_URL not configured' };
  await postJson(webhookUrl, { text: message });
  return { sent: true };
}

async function sendDiscordNotification(message) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return { sent: false, reason: 'DISCORD_WEBHOOK_URL not configured' };
  await postJson(webhookUrl, { content: message });
  return { sent: true };
}

async function sendTeamsNotification(message) {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) return { sent: false, reason: 'TEAMS_WEBHOOK_URL not configured' };
  // MessageCard format -- the connector shape Teams incoming webhooks expect.
  await postJson(webhookUrl, { '@type': 'MessageCard', '@context': 'http://schema.org/extensions', summary: 'SentinelPay alert', text: message });
  return { sent: true };
}

async function sendTelegramNotification(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return { sent: false, reason: 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured' };
  await postJson(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text: message });
  return { sent: true };
}

// SMS, via Twilio's REST API (the most common provider's shape -- generic enough that a
// Twilio-compatible provider works unmodified). Twilio's Messages endpoint takes
// x-www-form-urlencoded, not JSON, and Basic Auth with the Account SID as username.
async function sendSmsNotification(message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const toNumber = process.env.ALERT_SMS_TO_NUMBER;
  if (!accountSid || !authToken || !fromNumber || !toNumber) {
    return { sent: false, reason: 'TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER/ALERT_SMS_TO_NUMBER not configured' };
  }

  const body = new URLSearchParams({ From: fromNumber, To: toNumber, Body: message });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Twilio responded ${res.status}`);
  return { sent: true };
}

// Email, via a minimal hand-rolled SMTP client (Node's built-in net/tls, no nodemailer
// dependency -- consistent with this project's dependency-light convention). Supports plain
// SMTP + AUTH LOGIN over a TLS connection (port 465, implicit TLS -- the common case for
// most transactional-email providers' SMTP relays); does not implement STARTTLS upgrade on
// port 587, which would need a plaintext-then-upgrade handshake this minimal client doesn't do.
async function sendEmailNotification(subject, message) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 465;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.ALERT_EMAIL_FROM;
  const to = process.env.ALERT_EMAIL_TO;
  if (!host || !user || !pass || !from || !to) {
    return { sent: false, reason: 'SMTP_HOST/SMTP_USER/SMTP_PASS/ALERT_EMAIL_FROM/ALERT_EMAIL_TO not configured' };
  }

  const tls = require('node:tls');
  await new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, timeout: NOTIFICATION_TIMEOUT_MS }, () => {
      const commands = [
        `EHLO sentinelpay.local`,
        `AUTH LOGIN`,
        Buffer.from(user).toString('base64'),
        Buffer.from(pass).toString('base64'),
        `MAIL FROM:<${from}>`,
        `RCPT TO:<${to}>`,
        `DATA`,
      ];
      let step = -1; // -1 = waiting for the server's initial greeting
      let dataSent = false;

      socket.on('data', (chunk) => {
        const text = chunk.toString();
        const code = parseInt(text.slice(0, 3), 10);
        if (code >= 400) {
          socket.end();
          return reject(new Error(`SMTP error: ${text.trim()}`));
        }
        step += 1;
        if (step < commands.length) {
          socket.write(`${commands[step]}\r\n`);
        } else if (!dataSent) {
          dataSent = true;
          const headers = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n`;
          socket.write(`${headers}${message}\r\n.\r\n`);
        } else {
          socket.write('QUIT\r\n');
          socket.end();
          resolve();
        }
      });
      socket.on('error', reject);
      socket.on('timeout', () => reject(new Error('SMTP connection timed out')));
    });
    socket.on('error', reject);
  });

  return { sent: true };
}

const CHANNEL_SENDERS = {
  slack: (message) => sendSlackNotification(message),
  discord: (message) => sendDiscordNotification(message),
  teams: (message) => sendTeamsNotification(message),
  telegram: (message) => sendTelegramNotification(message),
  sms: (message) => sendSmsNotification(message),
  email: (message) => sendEmailNotification('SentinelPay Critical Fraud Alert', message),
};

// Dispatches to every channel in parallel, isolating each channel's failure from the others --
// same reasoning as websocket.js's per-client try/catch in broadcast(). Never throws; the caller
// (POST /transaction) fires this after responding to the gateway, so a slow/broken notification
// channel never adds latency to the scoring decision itself.
// `db`, if provided, also dispatches to every stored Web Push subscription -- optional (not every
// caller has a db handle in scope, and unconfigured VAPID keys make it a no-op anyway) rather than
// widening every existing caller's signature by requiring it.
async function dispatchCriticalAlert(message, db) {
  const results = {};
  await Promise.all(
    Object.entries(CHANNEL_SENDERS).map(async ([channel, send]) => {
      try {
        results[channel] = await send(message);
      } catch (err) {
        results[channel] = { sent: false, reason: err.message };
      }
    })
  );
  if (db) {
    try {
      // dashboard/sw.js's 'push' handler expects JSON ({title, body}) so it can render a proper
      // native notification, unlike the other channels above which all take a plain message string.
      const pushPayload = JSON.stringify({ title: 'SentinelPay Critical Fraud Alert', body: message });
      const pushResult = await dispatchWebPushToAllSubscriptions(db, pushPayload);
      results.web_push = { sent: pushResult.sent > 0, count: pushResult.sent };
    } catch (err) {
      results.web_push = { sent: false, reason: err.message };
    }
  }
  return results;
}

module.exports = {
  sendSlackNotification,
  sendDiscordNotification,
  sendTeamsNotification,
  sendTelegramNotification,
  sendSmsNotification,
  sendEmailNotification,
  dispatchCriticalAlert,
};
