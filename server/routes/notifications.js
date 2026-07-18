// Section 16, Category 17: a manual trigger to verify notification configuration without
// waiting for a real Critical-severity transaction. admin-only -- this both reveals which
// channels are configured (a mild information-disclosure surface) and actually sends real
// outbound messages, so it's gated the same as other operationally-consequential admin actions.
const express = require('express');
const router = express.Router();

const { requireApiKey, requireRole } = require('../middleware/apiKeyAuth');
const { dispatchCriticalAlert } = require('../notifications');

const MAX_MESSAGE_LENGTH = 1000;

// POST /notifications/test { message? } — sends a real test message to every configured
// channel and reports per-channel success/failure, so misconfiguration is visible immediately
// rather than silently discovered the next time a real Critical alert fires.
router.post('/notifications/test', requireApiKey, requireRole('admin'), async (req, res) => {
  const { message } = req.body || {};
  if (message !== undefined && (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH)) {
    return res.status(400).json({ error: `message must be at most ${MAX_MESSAGE_LENGTH} characters` });
  }

  const results = await dispatchCriticalAlert(
    message || '[SentinelPay] Test notification -- if you see this, your webhook/credentials are configured correctly.',
    req.app.locals.db
  );
  res.json(results);
});

const { vapidKeysConfigured } = require('../webPush');
const { MAX_ID_LENGTH } = require('../validate');

// GET /notifications/vapid-public-key -- the dashboard's subscribe flow (dashboard/app.js's
// initPushNotifications) needs this to call pushManager.subscribe({applicationServerKey}). Public
// by design (it's a public key, not a secret) but still behind requireApiKey for consistency with
// every other endpoint in this app -- an unauthenticated caller has no dashboard session to act on
// this from anyway.
router.get('/notifications/vapid-public-key', requireApiKey, (req, res) => {
  if (!vapidKeysConfigured()) {
    return res.status(404).json({ error: 'Web Push is not configured on this server (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY unset)' });
  }
  res.json({ public_key: process.env.VAPID_PUBLIC_KEY });
});

// POST /notifications/push-subscriptions { endpoint, keys: { p256dh, auth } } -- registers a
// browser's PushSubscription (from pushManager.subscribe()'s own toJSON() shape). Upsert on
// endpoint (a browser re-subscribing after clearing storage gets the same endpoint back from most
// push services, and should just replace the old keys rather than erroring).
router.post('/notifications/push-subscriptions', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const { endpoint, keys } = req.body || {};
  if (typeof endpoint !== 'string' || endpoint.trim() === '' || endpoint.length > 1024) {
    return res.status(400).json({ error: 'endpoint is required and must be a non-empty string of at most 1024 characters' });
  }
  let parsedOrigin;
  try {
    parsedOrigin = new URL(endpoint);
  } catch {
    return res.status(400).json({ error: 'endpoint must be a valid URL' });
  }
  if (parsedOrigin.protocol !== 'https:') {
    return res.status(400).json({ error: 'endpoint must be an https:// URL' });
  }
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > MAX_ID_LENGTH || keys.auth.length > MAX_ID_LENGTH) {
    return res.status(400).json({ error: 'keys.p256dh and keys.auth are required strings' });
  }

  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(endpoint, keys.p256dh, keys.auth, new Date().toISOString());

  res.status(201).json({ subscribed: true });
});

// DELETE /notifications/push-subscriptions { endpoint } -- unsubscribe, idempotent like every
// other DELETE route in this app (business_accounts, fraud_lists).
router.delete('/notifications/push-subscriptions', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const { endpoint } = req.body || {};
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    return res.status(400).json({ error: 'endpoint is required' });
  }
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.status(204).end();
});

module.exports = router;
