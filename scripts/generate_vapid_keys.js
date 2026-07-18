// Partial-Feature Completion Pass: one-off CLI helper to generate a VAPID key pair for Web Push
// (RFC 8292), printed in the base64url raw-bytes form server/webPush.js expects. Run once per
// deployment, then paste the output into .env as VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY -- these are
// long-lived per-server identity keys, not per-subscription secrets, so there's no reason to
// regenerate them on every server start the way an ephemeral key would be.
const crypto = require('node:crypto');

const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();

const publicKey = ecdh.getPublicKey().toString('base64url');
const privateKey = ecdh.getPrivateKey().toString('base64url');

console.log('Add these to your .env file:\n');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com\n`);
