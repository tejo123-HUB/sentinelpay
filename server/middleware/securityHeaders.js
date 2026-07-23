// Minimal hand-rolled security headers (no helmet dependency, matching this project's
// dependency-light conventions). Found during a full-project security review: the Express app
// sent none of the standard defensive headers, and the dashboard's CDN <script>/<link> tags had
// no Subresource Integrity hashes — if jsdelivr were ever compromised, there was nothing to stop
// a swapped-out chart.js/leaflet.js from running arbitrary JS in a fraud analyst's browser. SRI
// hashes were added directly in dashboard/index.html (pinned to exact versions); this middleware
// covers the response-header side.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  // dashboard/index.html loads its Plus Jakarta Sans/JetBrains Mono stylesheet directly from
  // fonts.googleapis.com (the actual, currently-used typography), so style-src/font-src must
  // allow it and its font-file host -- without these, the CSP silently blocked both, causing an
  // invisible fallback to system-ui/monospace with no console error tying it back to this policy.
  "style-src 'self' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://*.tile.openstreetmap.org https://cdn.jsdelivr.net",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  // PROD: fronted by GCP load balancer/Cloud Run TLS termination -- DEMO: Express serves plain
  // HTTP on localhost by default (server/index.js), so this header is inert until deployed behind
  // TLS, exactly like every other host that sends HSTS unconditionally (the header is a no-op
  // over plain HTTP). Without it, a real deployment behind TLS would otherwise ship with no
  // downgrade protection at all, letting a network attacker strip HTTPS on a client's first visit.
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
}

module.exports = securityHeaders;
