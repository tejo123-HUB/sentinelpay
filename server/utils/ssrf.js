const net = require('node:net');

// Security fix (post-merge audit): POST /notifications/push-subscriptions is the only place in
// this codebase where a caller-supplied URL becomes an outbound request destination (every other
// webhook -- Slack/Discord/Teams/Telegram/Twilio/SMTP -- comes from trusted process.env config).
// Without this, an analyst-role key could register e.g. https://169.254.169.254/... or
// https://127.0.0.1:6379/... as a "push endpoint", and the next Critical-severity alert (trivially
// self-triggered via POST /transaction) would make this server issue a real VAPID-signed HTTPS
// request to that internal/loopback destination -- a classic SSRF privilege-escalation primitive.
//
// This blocks literal IP-address endpoints and `localhost` outright. It intentionally does NOT do
// live DNS resolution: real push-service endpoints (FCM/Mozilla/WNS) are ordinary DNS hostnames,
// and this project's test suite (and any offline dev environment) relies on being able to register
// non-resolving placeholder hostnames without a network round-trip. A hostname that resolves to a
// private address only at request time (DNS rebinding) is a known residual gap -- closing it fully
// needs an egress proxy or resolve-and-pin-the-IP at fetch time, which is out of scope for this
// demo's dependency-light stack. Blocking literal IPs/`localhost` covers the direct, low-effort
// attempt, which is the realistic threat for a hackathon-scoped deployment.

function isPrivateIPv4(ip) {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return true; // malformed -- fail closed
  const [a, b] = octets;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, RFC 6598
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments, incl. some cloud metadata paths
  return false;
}

function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true; // unspecified / loopback
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // link-local, fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // unique local, fc00::/7
  if (normalized.startsWith('::ffff:')) {
    const embedded = normalized.slice('::ffff:'.length);
    if (net.isIPv4(embedded)) return isPrivateIPv4(embedded);
  }
  return false;
}

// True if `hostname` (the parsed .hostname of a URL) must be rejected as a push-subscription
// endpoint host. Node's URL parser keeps the literal `[...]` brackets around an IPv6 host in
// `.hostname` (unlike `.host`, which is for authority-with-port use) -- strip them before the
// net.isIPv6 check, which expects a bare address.
function isDisallowedPushEndpointHost(hostname) {
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = unbracketed.toLowerCase();
  if (lower === 'localhost') return true;
  if (net.isIPv4(lower)) return isPrivateIPv4(lower);
  if (net.isIPv6(unbracketed)) return isPrivateIPv6(unbracketed);
  return false; // an ordinary DNS hostname, not a literal IP -- allowed
}

module.exports = { isDisallowedPushEndpointHost };
