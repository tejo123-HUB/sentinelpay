// Partial-Feature Completion Pass: Web Push (RFC 8291/8292), implemented from scratch on top of
// node:crypto with no `web-push` dependency to check the work against. This test independently
// re-implements the *receiver* side of RFC 8291 decryption (the same computation a real browser's
// push service worker performs) and confirms it recovers the exact plaintext -- a genuine
// correctness check of the crypto, not just a "does it throw" smoke test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { encryptWebPushPayload, buildVapidAuthorizationHeader, vapidKeysConfigured } = require('../server/webPush');

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Independent reference decryption of one aes128gcm Web Push record (RFC 8188 + RFC 8291). */
function decryptWebPushPayload(encoded, receiverPrivateKeyBuffer, receiverPublicKeyBuffer, authSecretBuffer) {
  const salt = encoded.subarray(0, 16);
  const idlen = encoded.readUInt8(20);
  const senderPublicKey = encoded.subarray(21, 21 + idlen);
  const encryptedRecord = encoded.subarray(21 + idlen);

  const receiverEcdh = crypto.createECDH('prime256v1');
  receiverEcdh.setPrivateKey(receiverPrivateKeyBuffer);
  const ecdhSecret = receiverEcdh.computeSecret(senderPublicKey);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf-8'), receiverPublicKeyBuffer, senderPublicKey]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecretBuffer, keyInfo, 32));

  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf-8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf-8'), 12));

  const ciphertext = encryptedRecord.subarray(0, encryptedRecord.length - 16);
  const tag = encryptedRecord.subarray(encryptedRecord.length - 16);

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const recordPlaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Strip the RFC 8188 terminal-record delimiter (0x02) appended during encryption.
  assert.equal(recordPlaintext[recordPlaintext.length - 1], 2);
  return recordPlaintext.subarray(0, -1).toString('utf-8');
}

test('encryptWebPushPayload: round-trips through an independent RFC 8291 decryption', () => {
  const receiverEcdh = crypto.createECDH('prime256v1');
  receiverEcdh.generateKeys();
  const receiverPublicKey = receiverEcdh.getPublicKey();
  const receiverPrivateKey = receiverEcdh.getPrivateKey();
  const authSecret = crypto.randomBytes(16);

  const subscription = { p256dh: base64url(receiverPublicKey), auth: base64url(authSecret) };
  const plaintext = JSON.stringify({ title: 'SentinelPay Critical Fraud Alert', body: 'Transaction t_abc123 blocked at score 95.' });

  const encoded = encryptWebPushPayload(subscription, plaintext);
  const decrypted = decryptWebPushPayload(encoded, receiverPrivateKey, receiverPublicKey, authSecret);

  assert.equal(decrypted, plaintext);
});

test('encryptWebPushPayload: two calls for the same subscription produce different ciphertexts (fresh ephemeral key + salt each time)', () => {
  const receiverEcdh = crypto.createECDH('prime256v1');
  receiverEcdh.generateKeys();
  const subscription = { p256dh: base64url(receiverEcdh.getPublicKey()), auth: base64url(crypto.randomBytes(16)) };

  const first = encryptWebPushPayload(subscription, 'hello');
  const second = encryptWebPushPayload(subscription, 'hello');
  assert.notEqual(first.toString('hex'), second.toString('hex'));
});

test('encryptWebPushPayload: header carries a 65-byte uncompressed ephemeral public key', () => {
  const receiverEcdh = crypto.createECDH('prime256v1');
  receiverEcdh.generateKeys();
  const subscription = { p256dh: base64url(receiverEcdh.getPublicKey()), auth: base64url(crypto.randomBytes(16)) };

  const encoded = encryptWebPushPayload(subscription, 'x');
  assert.equal(encoded.readUInt8(20), 65);
  assert.equal(encoded.subarray(21, 22)[0], 0x04); // uncompressed EC point marker
});

test('vapidKeysConfigured: false when unset', () => {
  const savedPub = process.env.VAPID_PUBLIC_KEY;
  const savedPriv = process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  try {
    assert.equal(vapidKeysConfigured(), false);
  } finally {
    if (savedPub !== undefined) process.env.VAPID_PUBLIC_KEY = savedPub;
    if (savedPriv !== undefined) process.env.VAPID_PRIVATE_KEY = savedPriv;
  }
});

test('buildVapidAuthorizationHeader: produces a well-formed, verifiable ES256 JWT', () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey();
  const privateKey = ecdh.getPrivateKey();

  const savedPub = process.env.VAPID_PUBLIC_KEY;
  const savedPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = base64url(publicKey);
  process.env.VAPID_PRIVATE_KEY = base64url(privateKey);
  try {
    const header = buildVapidAuthorizationHeader('https://push.example.com/some/endpoint/id');
    const match = header.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.ok(match, `header did not match expected shape: ${header}`);
    const [, jwt, k] = match;
    assert.equal(k, process.env.VAPID_PUBLIC_KEY);

    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
    assert.equal(payload.aud, 'https://push.example.com');

    // Independently verify the ES256 signature using only the public key -- confirms
    // buildVapidAuthorizationHeader is signing with the matching private key, in the correct
    // (IEEE P1363, not DER) encoding a JWT requires.
    const verifyKey = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: base64url(publicKey.subarray(1, 33)), y: base64url(publicKey.subarray(33, 65)) },
      format: 'jwk',
    });
    const signingInput = `${headerB64}.${payloadB64}`;
    const isValid = crypto.verify('sha256', Buffer.from(signingInput), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64, 'base64url'));
    assert.equal(isValid, true);
  } finally {
    if (savedPub !== undefined) process.env.VAPID_PUBLIC_KEY = savedPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (savedPriv !== undefined) process.env.VAPID_PRIVATE_KEY = savedPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
  }
});
