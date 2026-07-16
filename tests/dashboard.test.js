const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf-8');

// Regression guard: app.js/map.js/audit.js reference window.Chart and window.L, which come
// from CDN <script defer> tags declared earlier in <head>. Deferred scripts execute in strict
// document order after HTML parsing finishes; a *non*-deferred script placed later in <body>
// executes immediately when the parser reaches it, which is *before* any deferred script runs
// — so without `defer` here too, `typeof Chart === 'undefined'` is always true regardless of
// network conditions, and the chart/map silently never render. See dashboard/index.html's
// comment above these three script tags for the full explanation.
for (const script of ['app.js', 'map.js', 'audit.js']) {
  test(`dashboard/index.html: ${script} has defer (required for correct load order relative to CDN scripts)`, () => {
    const tagMatch = indexHtml.match(new RegExp(`<script[^>]*src="${script}"[^>]*>`));
    assert.ok(tagMatch, `expected to find a <script src="${script}"> tag`);
    assert.match(tagMatch[0], /\bdefer\b/, `${script}'s <script> tag must have the defer attribute`);
  });
}

test('dashboard/index.html: CDN chart/map scripts are also deferred, and declared before the app scripts', () => {
  const chartIdx = indexHtml.indexOf('chart.js');
  const leafletIdx = indexHtml.indexOf('leaflet.js"');
  const appIdx = indexHtml.indexOf('src="app.js"');

  assert.ok(chartIdx > -1 && chartIdx < appIdx, 'chart.js must be declared before app.js');
  assert.ok(leafletIdx > -1 && leafletIdx < appIdx, 'leaflet.js must be declared before app.js');
});
