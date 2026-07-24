const MAX_TABLE_ROWS = 150; // cap DOM growth during a long-running demo
const MAX_ALERT_CARDS = 50;
const RECONNECT_DELAY_MS = 2000;

// The API now requires an X-API-Key header on every request (server/middleware/apiKeyAuth.js) —
// server/index.js injects it into this page's own <head> as a <meta> tag at serve time, since
// there's no login system in this hackathon build for the dashboard to authenticate through
// otherwise. Exposed on window so map.js/audit.js (loaded after this script, same global scope)
// can reuse it without each re-reading the DOM.
const API_KEY = document.querySelector('meta[name="sentinelpay-api-key"]')?.content || '';
window.SENTINELPAY_API_KEY = API_KEY;
function authFetch(url, options = {}) {
  const headers = { ...(options.headers || {}), 'X-API-Key': API_KEY };
  return fetch(url, { ...options, headers });
}
window.sentinelpayAuthFetch = authFetch;

// sender_id/receiver_id/etc. are attacker-controlled (POST /transaction validates only that
// they're non-empty strings, no character restriction) and get rendered here via innerHTML
// template strings for layout convenience — every dynamic value must be escaped or a
// malicious sender_id like "<img src=x onerror=...>" executes in the dashboard viewer's
// browser (a fraud analyst's session).
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

const counts = { total: 0, allow: 0, step_up: 0, block: 0, alerts: 0 };

const txTableBody = document.getElementById('tx-table-body');
const alertsList = document.getElementById('alerts-list');
const connDot = document.getElementById('conn-dot');
const connLabel = document.getElementById('conn-label');

// The registry of the business's own account IDs (server-persisted, editable from the strip
// above the tabs). There's no schema flag for "this ID belongs to the business" — this Set,
// loaded from GET /business-accounts, is what tells resolveCounterpartyId (below) which side of
// a transaction to hide. Shared globally with audit.js/map.js (classic <script> tags, one
// global scope), same as escapeHtml/authFetch above.
const businessAccountIds = new Set();

// Exactly one side known -> show the other (the customer). Neither (or, degenerately, both)
// known -> we can't tell which side is the customer yet, so show both rather than guessing.
function resolveCounterpartyId(tx) {
  const senderIsBusiness = businessAccountIds.has(tx.sender_id);
  const receiverIsBusiness = businessAccountIds.has(tx.receiver_id);
  if (senderIsBusiness && !receiverIsBusiness) return tx.receiver_id;
  if (receiverIsBusiness && !senderIsBusiness) return tx.sender_id;
  return `${tx.sender_id} → ${tx.receiver_id}`;
}

let decisionChart = null;

// Chart.js renders to a <canvas>, which can't read CSS custom properties directly the way the
// rest of the DOM does — but JS can, via getComputedStyle, at the moment a chart's colors are
// actually needed. Reading live here (rather than duplicating a parallel hardcoded hex per theme,
// the pattern that caused the dark-mode contrast bugs this pass fixed) means Chart.js always
// matches style.css's --allow/--stepup/--block/etc., in whichever theme is currently active, with
// nothing to keep manually in sync. Shared on window so map.js/audit.js/analytics.js/graph.js
// (same global scope, loaded after this file) can reuse it instead of re-deriving their own.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
window.sentinelpayCssVar = cssVar;

function chartPalette() {
  return {
    allow: cssVar('--allow'),
    stepup: cssVar('--stepup'),
    block: cssVar('--block'),
    struct: cssVar('--struct'),
    accent: cssVar('--accent'),
    surface: cssVar('--surface-strong'),
    text: cssVar('--text'),
    textDim: cssVar('--text-dim'),
    textFaint: cssVar('--text-faint'),
    border: cssVar('--border'),
    gridline: cssVar('--gridline'),
  };
}
window.sentinelpayChartPalette = chartPalette;

function chartTooltipOptions() {
  const p = chartPalette();
  return {
    backgroundColor: p.surface,
    titleColor: p.text,
    bodyColor: p.textDim,
    borderColor: p.border,
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
    displayColors: true,
  };
}
window.sentinelpayChartTooltip = chartTooltipOptions;

// Animates a stat-tile value counting up/down to its new total over a short, professional beat
// rather than snapping — the kind of restrained micro-interaction real ops dashboards use.
// Skips entirely under prefers-reduced-motion, and skips the very first paint (going from
// nothing to a value on page load should be instant, not an animated count from zero).
const COUNT_UP_MS = 420;
const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function animateCount(el, toValue) {
  const fromValue = Number(el.textContent) || 0;
  if (prefersReducedMotion || fromValue === toValue) {
    el.textContent = toValue;
    return;
  }
  const startTime = performance.now();
  function tick(now) {
    const progress = Math.min((now - startTime) / COUNT_UP_MS, 1);
    const eased = 1 - (1 - progress) ** 3; // easeOutCubic
    const current = Math.round(fromValue + (toValue - fromValue) * eased);
    el.textContent = current;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function initChart() {
  // Chart.js loads from a CDN; degrade gracefully (no chart, everything else still works) if
  // the demo machine is offline.
  if (typeof Chart === 'undefined') return;
  const ctx = document.getElementById('decision-chart');
  if (!ctx) return;
  const p = chartPalette();
  decisionChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Allow', 'Step-Up', 'Block'],
      datasets: [
        {
          data: [0, 0, 0],
          backgroundColor: [p.allow, p.stepup, p.block],
          // A real border (not 0) drawn in the surface color is how Chart.js implements the
          // "surface gap" between adjacent donut slices (marks-and-anatomy.md) — it isn't an
          // outline stroke added *around* each mark, it's the surface color showing through
          // between them, which is the correct mechanism for separating touching marks.
          borderColor: p.surface,
          borderWidth: 3,
          hoverOffset: 6,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false }, tooltip: chartTooltipOptions() },
      cutout: '68%',
      animation: { duration: 300, easing: 'easeOutQuart' },
    },
  });
}

// Re-applies the live theme's colors to the already-built donut chart — called on the
// sentinelpay:theme-changed event (below) rather than only at init, since Chart.js bakes colors
// into the chart instance once at creation and never re-reads CSS on its own.
function restyleChart() {
  if (!decisionChart) return;
  const p = chartPalette();
  decisionChart.data.datasets[0].backgroundColor = [p.allow, p.stepup, p.block];
  decisionChart.data.datasets[0].borderColor = p.surface;
  decisionChart.options.plugins.tooltip = chartTooltipOptions();
  decisionChart.update();
}

function updateChart() {
  if (!decisionChart) return;
  decisionChart.data.datasets[0].data = [counts.allow, counts.step_up, counts.block];
  decisionChart.update();
}

function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function updateCounters(decision, { animate = true } = {}) {
  counts.total += 1;
  if (decision in counts) counts[decision] += 1;
  const setValue = animate ? animateCount : (el, v) => (el.textContent = v);
  setValue(document.getElementById('count-total'), counts.total);
  setValue(document.getElementById('count-allow'), counts.allow);
  setValue(document.getElementById('count-step_up'), counts.step_up);
  setValue(document.getElementById('count-block'), counts.block);
  updateChart();
}

function addTransactionRow(tx, { prepend = true } = {}) {
  const row = document.createElement('tr');

  const idLabel = escapeHtml(resolveCounterpartyId(tx) || '—');
  const amountLabel = tx.amount != null ? `₹${Number(tx.amount).toFixed(2)}` : '—';
  const typeLabel = escapeHtml(tx.transaction_type || '—');
  const gatewayLabel = escapeHtml(tx.merchant_id || '—');
  const purposeLabel = escapeHtml(tx.purpose || '—');
  const reasons = escapeHtml((tx.reasons || []).join('; ') || '—');
  const decisionLabel = escapeHtml((tx.decision || '—').replace('_', '-'));
  const decisionClass = /^[a-z_]+$/.test(tx.decision || '') ? tx.decision : 'unknown';
  row.className = `decision-${decisionClass}`;

  const transactionIdAttr = escapeHtml(tx.transaction_id || '');

  row.innerHTML = `
    <td>${formatTime(tx.timestamp || new Date().toISOString())}</td>
    <td>${idLabel}</td>
    <td>${amountLabel}</td>
    <td>${typeLabel}</td>
    <td>${gatewayLabel}</td>
    <td class="reasons">${purposeLabel}</td>
    <td>${Number.isFinite(tx.fraud_score) ? tx.fraud_score : '—'}</td>
    <td class="decision-cell">${decisionLabel}</td>
    <td class="reasons">${reasons}</td>
    <td>${transactionIdAttr ? `<button type="button" class="ask-ai-btn" data-transaction-id="${transactionIdAttr}">Ask AI</button>` : '—'}</td>
  `;

  if (prepend) {
    txTableBody.prepend(row);
    while (txTableBody.rows.length > MAX_TABLE_ROWS) {
      txTableBody.deleteRow(txTableBody.rows.length - 1);
    }
  } else {
    txTableBody.appendChild(row);
  }
}

function addAlertCard(alert, { prepend = true, animate = true } = {}) {
  const emptyState = alertsList.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const card = document.createElement('div');
  card.className = 'alert-card';

  const receiverList = Array.isArray(alert.receiver_ids) ? alert.receiver_ids : [alert.receiver_ids];
  const receivers = escapeHtml(receiverList.join(', '));
  const senderLabel = escapeHtml(alert.sender_id);
  const reasonLabel = escapeHtml(alert.reason || '');
  const ratio = alert.withdrawal_ratio != null ? `${Math.round(alert.withdrawal_ratio * 100)}%` : 'n/a';

  card.innerHTML = `
    <div class="alert-chain">${senderLabel} → [${receivers}]</div>
    <div class="alert-meta">₹${Number(alert.total_amount).toFixed(2)} across ${alert.transaction_count} transactions · withdrawal ratio ${ratio}</div>
    <div class="alert-reason">${reasonLabel}</div>
  `;

  if (prepend) {
    alertsList.prepend(card);
    while (alertsList.children.length > MAX_ALERT_CARDS) {
      alertsList.removeChild(alertsList.lastElementChild);
    }
  } else {
    alertsList.appendChild(card);
  }

  counts.alerts += 1;
  const alertsCountEl = document.getElementById('count-alerts');
  if (animate) animateCount(alertsCountEl, counts.alerts);
  else alertsCountEl.textContent = counts.alerts;
}

async function reloadTransactionTable() {
  // Re-renders the live table from a fresh fetch so a business-accounts change applies
  // retroactively to already-rendered rows, not just new ones. Deliberately does not touch
  // `counts` — those stay tied to the cumulative live event stream, not to what's displayed.
  try {
    const res = await authFetch('/transactions?limit=50');
    const transactions = await res.json();
    txTableBody.innerHTML = '';
    for (const tx of [...transactions].reverse()) {
      addTransactionRow(tx, { prepend: false });
    }
  } catch (err) {
    console.error('Failed to reload transaction table:', err);
  }
}

function renderBusinessAccountsList() {
  const list = document.getElementById('business-accounts-list');
  if (!list) return;
  list.innerHTML = '';
  if (businessAccountIds.size === 0) {
    list.innerHTML = '<span class="empty-state">No business accounts registered yet.</span>';
    return;
  }
  for (const accountId of businessAccountIds) {
    const chip = document.createElement('span');
    chip.className = 'business-account-chip';
    chip.innerHTML = `${escapeHtml(accountId)} <button class="business-account-remove" data-account-id="${escapeHtml(accountId)}" aria-label="Remove ${escapeHtml(accountId)}">×</button>`;
    list.appendChild(chip);
  }
}

async function loadBusinessAccounts() {
  try {
    const res = await authFetch('/business-accounts');
    const rows = await res.json();
    businessAccountIds.clear();
    for (const row of rows) businessAccountIds.add(row.account_id);
  } catch (err) {
    console.error('Failed to load business accounts:', err);
  }
  renderBusinessAccountsList();
}

// audit.js's refreshAuditTable (loaded after this script, deferred) becomes a plain global
// function the same way this file's own top-level functions do — safe to call directly by the
// time a user can actually click Add/Remove (all deferred scripts have already run by then).
async function onBusinessAccountsChanged() {
  renderBusinessAccountsList();
  await reloadTransactionTable();
  if (typeof refreshAuditTable === 'function') refreshAuditTable();
}

async function addBusinessAccount(accountId) {
  const trimmed = accountId.trim();
  if (!trimmed) return;
  try {
    const res = await authFetch('/business-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: trimmed }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      console.error('Failed to add business account:', body && body.error);
      return;
    }
    businessAccountIds.add(trimmed);
    await onBusinessAccountsChanged();
  } catch (err) {
    console.error('Failed to add business account:', err);
  }
}

async function removeBusinessAccount(accountId) {
  try {
    await authFetch(`/business-accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    businessAccountIds.delete(accountId);
    await onBusinessAccountsChanged();
  } catch (err) {
    console.error('Failed to remove business account:', err);
  }
}

function initBusinessAccountsControl() {
  const input = document.getElementById('business-account-input');
  const addBtn = document.getElementById('business-account-add');
  const list = document.getElementById('business-accounts-list');
  if (!input || !addBtn || !list) return;

  const submit = () => {
    if (!input.value.trim()) return;
    addBusinessAccount(input.value);
    input.value = '';
  };
  addBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });

  list.addEventListener('click', (event) => {
    const btn = event.target.closest('.business-account-remove');
    if (!btn) return;
    removeBusinessAccount(btn.dataset.accountId);
  });
}

async function loadInitialData() {
  try {
    const [txRes, alertsRes] = await Promise.all([
      authFetch('/transactions?limit=50'),
      authFetch('/alerts?limit=20'),
    ]);
    const transactions = await txRes.json();
    const alerts = await alertsRes.json();

    // Oldest first, so the running counters/table read top-to-bottom like a live feed once
    // real-time events start arriving on top. animate: false on this initial batch — the
    // count-up beat is for a single live update arriving, not a rapid loop over up to 50
    // historical rows landing in the same tick.
    for (const tx of [...transactions].reverse()) {
      addTransactionRow(tx, { prepend: false });
      updateCounters(tx.decision, { animate: false });
    }
    for (const alert of [...alerts].reverse()) {
      addAlertCard(alert, { prepend: false, animate: false });
    }
  } catch (err) {
    console.error('Failed to load initial dashboard data:', err);
  }
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // The browser WebSocket API can't set custom headers on the handshake, so the API key travels
  // as a query param instead — checked server-side in websocket.js's verifyClient before the
  // upgrade completes (see that file for why the WS feed needs the same gate as the REST API).
  const ws = new WebSocket(`${protocol}//${location.host}/ws?apiKey=${encodeURIComponent(API_KEY)}`);

  ws.addEventListener('open', () => {
    connDot.classList.add('connected');
    connLabel.textContent = 'Live';
  });

  ws.addEventListener('close', () => {
    connDot.classList.remove('connected');
    connLabel.textContent = 'Reconnecting…';
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', () => ws.close());

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'transaction') {
      addTransactionRow(message.data);
      updateCounters(message.data.decision);
      // Other view modules (map.js, audit.js) hook into the same live feed via this event
      // rather than opening their own WebSocket connection.
      document.dispatchEvent(new CustomEvent('sentinelpay:transaction', { detail: message.data }));
    } else if (message.type === 'structuring_alert') {
      addAlertCard(message.data);
      document.dispatchEvent(new CustomEvent('sentinelpay:structuring_alert', { detail: message.data }));
    } else if (message.type === 'graph_cluster') {
      // graph.js (Graph tab) refreshes its cluster chip list on this event, same "hook into the
      // existing WS feed rather than opening a second connection" pattern as map.js/audit.js.
      document.dispatchEvent(new CustomEvent('sentinelpay:graph-cluster', { detail: message.data }));
    }
  });
}

// ---- Tab navigation between Live Monitor / Map / Audit Trail ----
function initTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const targetView = btn.dataset.view;
      document.querySelectorAll('.view').forEach((view) => {
        view.classList.toggle('hidden', view.id !== `view-${targetView}`);
      });

      document.dispatchEvent(new CustomEvent('sentinelpay:view-shown', { detail: { view: targetView } }));
    });
  });
}

// ---- Dark mode (Section 15.16, Feature 15) ----
// Applies site-wide via a `data-theme` attribute on <html> -- style.css's `[data-theme="dark"]`
// block overrides the same custom properties every existing component already reads (--bg,
// --surface, --text, --allow, etc.), so no component-level dark-mode logic is needed anywhere
// else for plain CSS. Preference persisted in localStorage; defaults to the OS-level
// prefers-color-scheme on first visit for a user who never touches the toggle at all (checked
// directly in initThemeToggle below, not via a CSS `@media (prefers-color-scheme)` block --
// style.css has no such block, since the toggle always needs to be able to override the OS
// setting and a `data-theme` attribute already covers both cases).
//
// Chart.js/canvas-drawn content (app.js's own donut, analytics.js/audit.js's trend charts,
// graph.js's node labels) can't pick up CSS custom property changes on their own, so this also
// fires a `sentinelpay:theme-changed` event every listener of that kind hooks into to re-read the
// live palette (chartPalette() above) and redraw.
const THEME_STORAGE_KEY = 'sentinelpay-theme';
const THEME_CHANGE_EVENT = 'sentinelpay:theme-changed';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.querySelector('.theme-toggle-icon');
  if (icon) icon.textContent = theme === 'dark' ? '◑' : '◐';
  document.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme } }));
}

document.addEventListener(THEME_CHANGE_EVENT, restyleChart);

function initThemeToggle() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(stored || (prefersDark ? 'dark' : 'light'));

  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem(THEME_STORAGE_KEY, next);
    });
  }
}

// ---- Web Push (Partial-Feature Completion Pass) ----
// Only shown/wired up when the browser supports it AND the server has VAPID keys configured
// (GET /notifications/vapid-public-key 404s otherwise) -- both real gates, not just a UI nicety,
// since pushManager.subscribe() would otherwise fail with a confusing browser-level error.
function urlBase64ToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function subscribeToPush(vapidPublicKey) {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  const json = subscription.toJSON();
  await authFetch('/notifications/push-subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
}

async function initPushNotifications() {
  const btn = document.getElementById('push-toggle');
  if (!btn || !('serviceWorker' in navigator) || !('PushManager' in window)) return;

  let vapidPublicKey = null;
  try {
    const res = await authFetch('/notifications/vapid-public-key');
    if (!res.ok) return; // Web Push not configured server-side -- keep the button hidden
    vapidPublicKey = (await res.json()).public_key;
  } catch {
    return;
  }

  try {
    await navigator.serviceWorker.register('sw.js');
  } catch (err) {
    console.error('Failed to register service worker:', err);
    return;
  }

  btn.classList.remove('hidden');

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    btn.textContent = 'Push Alerts Enabled';
    btn.disabled = true;
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        btn.disabled = false;
        return;
      }
      await subscribeToPush(vapidPublicKey);
      btn.textContent = 'Push Alerts Enabled';
    } catch (err) {
      console.error('Failed to subscribe to push notifications:', err);
      btn.disabled = false;
    }
  });
}

initTabs();
// Theme must be applied before any chart reads CSS custom properties for its initial colors --
// otherwise a page load that resolves to dark (stored preference or OS prefers-color-scheme)
// would still build the donut with light-theme colors for one frame before the next redraw.
initThemeToggle();
initChart();
initBusinessAccountsControl();
initPushNotifications();
loadBusinessAccounts().then(loadInitialData).then(connect);
