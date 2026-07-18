// Partial-Feature Completion Pass: Notification Engine's one previously-undone item -- Web Push
// Notifications. server/notifications.js's header comment explained this was skipped because it
// "needs a browser-side service worker, a real subscribed browser, and per-subscription VAPID/
// ECDH encryption -- a fundamentally different kind of feature ... and this project has no
// dashboard-side push subscription UI to drive it." Both halves are now real: dashboard/app.js's
// initPushNotifications() drives a subscription flow against dashboard/sw.js (the service
// worker), and this module implements the actual Web Push protocol -- VAPID request
// authentication (RFC 8292) and aes128gcm message encryption (RFC 8291) -- using only Node's
// built-in crypto module, no `web-push` npm dependency, consistent with this project's
// dependency-light convention.
//
// PROD: same protocol, same code -- Web Push doesn't have a "real" vs "demo" split the way
// Vertex AI/Cloud Spanner do. DEMO note instead: this requires the operator to generate and set
// VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY (see scripts/generate_vapid_keys.js) -- unconfigured, push is
// silently skipped, same graceful-degradation convention as every other notification channel in
// notifications.js.
const crypto = require('node:crypto');
const { isDisallowedPushEndpointHost } = require('./utils/ssrf');

const VAPID_JWT_TTL_SECONDS = 12 * 60 * 60; // RFC 8292 recommends no more than 24h; well under it

function base64UrlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url');
}

function vapidKeysConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

/**
 * Builds a Node KeyObject for the VAPID private key from its raw 32-byte scalar (`d`) plus the
 * raw 65-byte uncompressed public point (x||y), via the JWK import path -- avoids hand-rolling a
 * DER/PKCS8 envelope for a raw EC key, which Node's crypto has no direct raw-bytes constructor for.
 */
function vapidPrivateKeyObject() {
  const publicKeyBytes = base64UrlDecode(process.env.VAPID_PUBLIC_KEY);
  const privateKeyBytes = base64UrlDecode(process.env.VAPID_PRIVATE_KEY);
  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be a base64url-encoded uncompressed P-256 point (65 bytes, starting with 0x04)');
  }
  if (privateKeyBytes.length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY must be a base64url-encoded 32-byte P-256 scalar');
  }
  const x = publicKeyBytes.subarray(1, 33);
  const y = publicKeyBytes.subarray(33, 65);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: base64UrlEncode(x), y: base64UrlEncode(y), d: base64UrlEncode(privateKeyBytes) },
    format: 'jwk',
  });
}

/**
 * Builds the `Authorization: vapid t=<jwt>, k=<publicKey>` header value for one push endpoint,
 * per RFC 8292. The JWT's `aud` is the push service's own origin (not the full endpoint URL) --
 * every push service (FCM, Mozilla autopush, etc.) requires this exact scoping.
 * @param {string} endpoint - the subscription's push service endpoint URL
 * @returns {string}
 */
function buildVapidAuthorizationHeader(endpoint) {
  const audience = new URL(endpoint).origin;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: nowSeconds + VAPID_JWT_TTL_SECONDS,
    sub: process.env.VAPID_SUBJECT || 'mailto:admin@sentinelpay.local',
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  // ECDSA over a JWT must be the raw fixed-length r||s (IEEE P1363) encoding, not the ASN.1 DER
  // encoding crypto.sign() produces by default -- `dsaEncoding: 'ieee-p1363'` selects that
  // directly rather than requiring a manual DER-to-JOSE conversion step.
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: vapidPrivateKeyObject(), dsaEncoding: 'ieee-p1363' });
  const jwt = `${signingInput}.${base64UrlEncode(signature)}`;
  return `vapid t=${jwt}, k=${process.env.VAPID_PUBLIC_KEY}`;
}

const AES128GCM_TAG_LENGTH = 16;
const AES128GCM_RECORD_HEADER_KEYID_LENGTH = 65; // our ephemeral P-256 uncompressed public key

/**
 * Encrypts `plaintext` for delivery to one push subscription, per RFC 8291 (Message Encryption
 * for Web Push, the `aes128gcm` content-coding from RFC 8188). Generates a fresh ephemeral P-256
 * key pair per call -- reusing one across subscriptions/messages would let a passive observer
 * correlate otherwise-unlinkable pushes, which the spec is explicitly designed to prevent.
 * @param {{ p256dh: string, auth: string }} subscription - base64url-encoded, from PushSubscription.toJSON().keys
 * @param {string} plaintext
 * @returns {Buffer} the aes128gcm-encoded request body
 */
function encryptWebPushPayload(subscription, plaintext) {
  const receiverPublicKey = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const senderPublicKey = ecdh.getPublicKey(); // uncompressed, 65 bytes, Node's default ECDH output format
  const ecdhSecret = ecdh.computeSecret(receiverPublicKey);

  // Step 1 (RFC 8291 section 3.3): derive a 32-byte IKM from the ECDH shared secret, salted by
  // the subscription's own auth secret, bound to both parties' public keys via `info` so a key
  // reused against a different subscription can't be replayed here.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf-8'), receiverPublicKey, senderPublicKey]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));

  // Step 2 (RFC 8188 section 2.1): derive the actual content-encryption key + nonce from that
  // IKM, salted by a fresh random 16-byte per-message salt (part of the aes128gcm header, so the
  // receiver can re-derive the same values).
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf-8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf-8'), 12));

  // RFC 8188 record framing: content || delimiter(0x02, this is always the sole/last record for
  // a push message) -- no additional zero-padding, this project has no length-hiding requirement.
  const recordPlaintext = Buffer.concat([Buffer.from(plaintext, 'utf-8'), Buffer.from([2])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(recordPlaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encryptedRecord = Buffer.concat([ciphertext, authTag]);

  // aes128gcm header (RFC 8188 section 2.1): salt(16) || record_size(4, BE uint32) || idlen(1) ||
  // keyid(idlen) -- keyid here carries our ephemeral public key, which the receiver needs for its
  // own ECDH computation and has no other channel to learn it through.
  const recordSizeBuf = Buffer.alloc(4);
  recordSizeBuf.writeUInt32BE(encryptedRecord.length, 0);
  const header = Buffer.concat([salt, recordSizeBuf, Buffer.from([AES128GCM_RECORD_HEADER_KEYID_LENGTH]), senderPublicKey]);

  return Buffer.concat([header, encryptedRecord]);
}

const WEB_PUSH_TIMEOUT_MS = 3000; // same bound as notifications.js's other webhook channels

/**
 * Sends one Web Push notification to one stored subscription. Never throws -- errors (including
 * a 404/410 from the push service, which means the subscription is gone and should be pruned by
 * the caller) are returned, not thrown, same convention as every sendXNotification in
 * notifications.js.
 * @param {{ endpoint: string, p256dh: string, auth: string }} subscription
 * @param {string} message
 */
async function sendWebPushNotification(subscription, message) {
  if (!vapidKeysConfigured()) {
    return { sent: false, reason: 'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not configured' };
  }
  // Security fix (post-merge audit): re-check at dispatch time, not just at registration -- a
  // defense-in-depth backstop for any subscription row already in the database from before this
  // check existed, rather than assuming the write-side validation is the only guard (same
  // reasoning as e.g. cases.js's timeline route capping the IN(...) clause regardless of the
  // write-side cap). See server/utils/ssrf.js for the full rationale.
  let endpointHost;
  try {
    endpointHost = new URL(subscription.endpoint).hostname;
  } catch {
    return { sent: false, reason: 'endpoint is not a valid URL' };
  }
  if (isDisallowedPushEndpointHost(endpointHost)) {
    return { sent: false, reason: 'endpoint host is not allowed' };
  }
  try {
    const body = encryptWebPushPayload(subscription, message);
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: '86400',
        Authorization: buildVapidAuthorizationHeader(subscription.endpoint),
      },
      body,
      signal: AbortSignal.timeout(WEB_PUSH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { sent: false, reason: `Push service responded ${res.status}`, expired: res.status === 404 || res.status === 410 };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

/**
 * Sends to every stored subscription in parallel, isolating each one's failure -- same pattern as
 * notifications.js's dispatchCriticalAlert. Returns the endpoints that came back expired (404/410)
 * so the caller can prune them from push_subscriptions.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} message
 */
async function dispatchWebPushToAllSubscriptions(db, message) {
  if (!vapidKeysConfigured()) return { sent: 0, expiredEndpoints: [] };
  const subscriptions = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all();
  const expiredEndpoints = [];
  let sentCount = 0;
  await Promise.all(
    subscriptions.map(async (sub) => {
      const result = await sendWebPushNotification(sub, message);
      if (result.sent) sentCount += 1;
      else if (result.expired) expiredEndpoints.push(sub.endpoint);
    })
  );
  if (expiredEndpoints.length > 0) {
    const del = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
    for (const endpoint of expiredEndpoints) del.run(endpoint);
  }
  return { sent: sentCount, expiredEndpoints };
}

module.exports = {
  vapidKeysConfigured,
  buildVapidAuthorizationHeader,
  encryptWebPushPayload,
  sendWebPushNotification,
  dispatchWebPushToAllSubscriptions,
};
