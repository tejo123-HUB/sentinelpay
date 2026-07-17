// Section 15.16, Feature 4: ingests merchant login/session metadata, so a takeover attempt (an
// unrecognized device/location immediately followed by a refund/payout/settlement) can be
// detected. Same trust model as POST /transaction and POST /business-accounts -- a
// backend-to-backend integration point, not something end users call directly.
const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();

const { requireApiKey } = require('../middleware/apiKeyAuth');
const { MAX_ID_LENGTH, MAX_COUNTRY_LENGTH } = require('../validate');

const MAX_META_LENGTH = 128; // browser/os strings -- generous but bounded, same reasoning as MAX_ID_LENGTH

router.post('/merchant-logins', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const { merchant_id, device_id, browser, os, ip_address, location, country, timestamp } = req.body || {};

  if (typeof merchant_id !== 'string' || merchant_id.trim() === '' || merchant_id.length > MAX_ID_LENGTH) {
    return res.status(400).json({ error: `merchant_id is required and must be a non-empty string of at most ${MAX_ID_LENGTH} characters` });
  }
  if (device_id !== undefined && device_id !== null && (typeof device_id !== 'string' || device_id.length > MAX_ID_LENGTH)) {
    return res.status(400).json({ error: `device_id must be at most ${MAX_ID_LENGTH} characters` });
  }
  if (browser !== undefined && browser !== null && (typeof browser !== 'string' || browser.length > MAX_META_LENGTH)) {
    return res.status(400).json({ error: `browser must be at most ${MAX_META_LENGTH} characters` });
  }
  if (os !== undefined && os !== null && (typeof os !== 'string' || os.length > MAX_META_LENGTH)) {
    return res.status(400).json({ error: `os must be at most ${MAX_META_LENGTH} characters` });
  }
  if (ip_address !== undefined && ip_address !== null && (typeof ip_address !== 'string' || ip_address.length > MAX_ID_LENGTH)) {
    return res.status(400).json({ error: `ip_address must be at most ${MAX_ID_LENGTH} characters` });
  }
  if (country !== undefined && country !== null && (typeof country !== 'string' || country.length > MAX_COUNTRY_LENGTH)) {
    return res.status(400).json({ error: `country must be at most ${MAX_COUNTRY_LENGTH} characters` });
  }

  let normalizedLocation = { lat: null, lng: null };
  if (location !== undefined && location !== null) {
    if (
      typeof location !== 'object' ||
      typeof location.lat !== 'number' ||
      typeof location.lng !== 'number' ||
      !Number.isFinite(location.lat) ||
      !Number.isFinite(location.lng) ||
      location.lat < -90 ||
      location.lat > 90 ||
      location.lng < -180 ||
      location.lng > 180
    ) {
      return res.status(400).json({ error: 'location, if provided, must be an object with numeric lat in [-90,90] and lng in [-180,180]' });
    }
    normalizedLocation = { lat: location.lat, lng: location.lng };
  }

  let resolvedTimestamp;
  if (timestamp !== undefined) {
    if (typeof timestamp !== 'string' || Number.isNaN(new Date(timestamp).getTime())) {
      return res.status(400).json({ error: 'timestamp, if provided, must be a valid ISO 8601 date string' });
    }
    // Same reasoning as POST /transaction: this is real login telemetry that scoring depends on
    // for a time-windowed check, so an honest caller's claim is trusted the same way the rest of
    // this endpoint's fields are -- but a demo/seed script legitimately needs to backdate login
    // history (the same reason scripts/generate_demo_data.js writes directly to the DB elsewhere
    // rather than only through the live API), so unlike POST /transaction this is not overridden
    // with server time. This endpoint is not payment-moving and not reachable from the untrusted
    // POST /transaction caller path, so the spoofing risk that motivated overriding timestamp
    // there does not apply here in the same way.
    resolvedTimestamp = new Date(timestamp).toISOString();
  } else {
    resolvedTimestamp = new Date().toISOString();
  }

  const loginId = `login_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();

  db.prepare(
    `INSERT INTO merchant_login_events
      (login_id, merchant_id, device_id, browser, os, ip_address, location_lat, location_lng, country, timestamp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    loginId,
    merchant_id,
    typeof device_id === 'string' ? device_id : null,
    typeof browser === 'string' ? browser : null,
    typeof os === 'string' ? os : null,
    typeof ip_address === 'string' ? ip_address : null,
    normalizedLocation.lat,
    normalizedLocation.lng,
    typeof country === 'string' ? country : null,
    resolvedTimestamp,
    nowIso
  );

  res.status(201).json({ login_id: loginId, merchant_id, timestamp: resolvedTimestamp });
});

// GET /merchant-logins?merchant_id=...&limit=50 — recent login events for a merchant, for the
// dashboard's takeover-alert detail view (previous vs current device/country).
router.get('/merchant-logins', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
  const merchantId = typeof req.query.merchant_id === 'string' ? req.query.merchant_id : null;

  const rows = merchantId
    ? db
        .prepare('SELECT * FROM merchant_login_events WHERE merchant_id = ? ORDER BY timestamp DESC LIMIT ?')
        .all(merchantId, limit)
    : db.prepare('SELECT * FROM merchant_login_events ORDER BY timestamp DESC LIMIT ?').all(limit);

  res.json(
    rows.map((row) => ({
      login_id: row.login_id,
      merchant_id: row.merchant_id,
      device_id: row.device_id,
      browser: row.browser,
      os: row.os,
      ip_address: row.ip_address,
      location: row.location_lat != null && row.location_lng != null ? { lat: row.location_lat, lng: row.location_lng } : null,
      country: row.country,
      timestamp: row.timestamp,
    }))
  );
});

module.exports = router;
