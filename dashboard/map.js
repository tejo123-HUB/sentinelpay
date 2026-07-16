// Task 10 (stretch): live map view plotting transaction origins, flagged transactions in red.
// Degrades gracefully (panel shows a message, nothing else breaks) if Leaflet's CDN script
// didn't load — e.g. the demo machine is offline.
const MAP_MAX_MARKERS = 300; // cap DOM/marker growth during a long-running demo
const MAP_DEFAULT_CENTER = [20.5937, 78.9629]; // India, a reasonable default before any data arrives
const MAP_DEFAULT_ZOOM = 5;

const DECISION_COLORS = { allow: '#34d399', step_up: '#fbbf24', block: '#f87171' };

let map = null;
let markers = []; // { marker, timestamp } oldest-first, so the oldest is evicted first
let mapInitAttempted = false;
// Guards against plotting the same transaction twice: a live WebSocket event can arrive and
// get plotted while loadInitialMapData()'s fetch of "last 200 transactions" is still in
// flight (it's a real network round-trip, not instant) — by the time that fetch resolves, the
// DB already contains the just-plotted live transaction too, so it would otherwise be plotted
// a second time.
const plottedTransactionIds = new Set();

function markerColor(decision) {
  return DECISION_COLORS[decision] || '#8ba0c4';
}

function initMap() {
  if (mapInitAttempted) return;
  mapInitAttempted = true;

  const container = document.getElementById('map-container');
  if (typeof L === 'undefined' || !container) {
    if (container) {
      container.innerHTML = '<p class="empty-state">Map unavailable — Leaflet did not load (offline?). The rest of the dashboard is unaffected.</p>';
    }
    return;
  }

  map = L.map(container).setView(MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);

  // Leaflet computes its internal size from the container's dimensions at init time; since
  // this view starts hidden (display:none), that size would be wrong until the tab is shown.
  document.addEventListener('sentinelpay:view-shown', (event) => {
    if (event.detail.view === 'map') {
      map.invalidateSize();
    }
  });
}

function plotTransaction(tx) {
  if (!map || !tx.location || tx.location.lat == null || tx.location.lng == null) return;
  if (tx.transaction_id) {
    if (plottedTransactionIds.has(tx.transaction_id)) return;
    plottedTransactionIds.add(tx.transaction_id);
  }

  const marker = L.circleMarker([tx.location.lat, tx.location.lng], {
    radius: tx.decision === 'block' ? 8 : 6,
    color: markerColor(tx.decision),
    fillColor: markerColor(tx.decision),
    fillOpacity: 0.75,
    weight: tx.decision === 'block' ? 2 : 1,
  }).addTo(map);

  const senderLabel = escapeHtml(tx.sender_id || '—');
  const reasonsLabel = escapeHtml((tx.reasons || []).join('; '));
  marker.bindPopup(
    `<strong>${senderLabel}</strong><br>${escapeHtml(tx.decision || '')} · score ${tx.fraud_score ?? '—'}${
      reasonsLabel ? `<br>${reasonsLabel}` : ''
    }`
  );

  markers.push({ marker, timestamp: tx.timestamp, transactionId: tx.transaction_id });
  while (markers.length > MAP_MAX_MARKERS) {
    const oldest = markers.shift();
    map.removeLayer(oldest.marker);
    if (oldest.transactionId) plottedTransactionIds.delete(oldest.transactionId);
  }
}

async function loadInitialMapData() {
  try {
    const res = await window.sentinelpayAuthFetch('/transactions?limit=200');
    const transactions = await res.json();
    for (const tx of [...transactions].reverse()) {
      plotTransaction(tx);
    }
  } catch (err) {
    console.error('Failed to load initial map data:', err);
  }
}

document.addEventListener('sentinelpay:view-shown', (event) => {
  if (event.detail.view === 'map') {
    initMap();
  }
});

document.addEventListener('sentinelpay:transaction', (event) => {
  if (!mapInitAttempted) return; // don't force-init the map before its tab has ever been opened
  plotTransaction(event.detail);
});

// If the map tab is opened before any live transactions arrive, seed it with recent history.
document.addEventListener(
  'sentinelpay:view-shown',
  (event) => {
    if (event.detail.view === 'map') loadInitialMapData();
  },
  { once: true }
);
