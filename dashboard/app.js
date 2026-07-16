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

let decisionChart = null;

function initChart() {
  // Chart.js loads from a CDN; degrade gracefully (no chart, everything else still works) if
  // the demo machine is offline.
  if (typeof Chart === 'undefined') return;
  const ctx = document.getElementById('decision-chart');
  if (!ctx) return;
  decisionChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Allow', 'Step-Up', 'Block'],
      datasets: [
        {
          data: [0, 0, 0],
          backgroundColor: ['#34d399', '#fbbf24', '#f87171'],
          borderWidth: 0,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      cutout: '65%',
      animation: { duration: 200 },
    },
  });
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

function updateCounters(decision) {
  counts.total += 1;
  if (decision in counts) counts[decision] += 1;
  document.getElementById('count-total').textContent = counts.total;
  document.getElementById('count-allow').textContent = counts.allow;
  document.getElementById('count-step_up').textContent = counts.step_up;
  document.getElementById('count-block').textContent = counts.block;
  updateChart();
}

function addTransactionRow(tx, { prepend = true } = {}) {
  const row = document.createElement('tr');

  const senderLabel = escapeHtml(tx.sender_id || '—');
  const receiverLabel = escapeHtml(tx.receiver_id || '—');
  const amountLabel = tx.amount != null ? `₹${Number(tx.amount).toFixed(2)}` : '—';
  const typeLabel = escapeHtml(tx.transaction_type || '—');
  const reasons = escapeHtml((tx.reasons || []).join('; ') || '—');
  const decisionLabel = escapeHtml((tx.decision || '—').replace('_', '-'));
  const decisionClass = /^[a-z_]+$/.test(tx.decision || '') ? tx.decision : 'unknown';
  row.className = `decision-${decisionClass}`;

  row.innerHTML = `
    <td>${formatTime(tx.timestamp || new Date().toISOString())}</td>
    <td>${senderLabel}</td>
    <td>${receiverLabel}</td>
    <td>${amountLabel}</td>
    <td>${typeLabel}</td>
    <td>${Number.isFinite(tx.fraud_score) ? tx.fraud_score : '—'}</td>
    <td class="decision-cell">${decisionLabel}</td>
    <td class="reasons">${reasons}</td>
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

function addAlertCard(alert, { prepend = true } = {}) {
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
  document.getElementById('count-alerts').textContent = counts.alerts;
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
    // real-time events start arriving on top.
    for (const tx of [...transactions].reverse()) {
      addTransactionRow(tx, { prepend: false });
      updateCounters(tx.decision);
    }
    for (const alert of [...alerts].reverse()) {
      addAlertCard(alert, { prepend: false });
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

initTabs();
initChart();
loadInitialData().then(connect);
