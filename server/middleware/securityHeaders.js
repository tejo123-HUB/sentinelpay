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
  "style-src 'self' https://cdn.jsdelivr.net",
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
  next();
}

module.exports = securityHeaders;
