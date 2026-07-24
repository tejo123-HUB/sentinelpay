// Task 11 (stretch): historical view of flagged transactions over time — a trend chart plus
// a filterable audit table, per architecture.md Section 4.2.
let auditChart = null;
let auditInitialized = false;

// Colors are read live from style.css's custom properties via app.js's chartPalette()/cssVar()
// helpers (window.sentinelpayChartPalette/sentinelpayCssVar) instead of a second hardcoded hex
// set — the previous hardcoded set (#898781 ticks, #52514e legend text, tuned for the light
// theme only) rendered as low-contrast dark gray on this chart's canvas once the dark theme's
// near-black background was behind it, same bug class as analytics.js's trend chart.
function auditLineDataset(label, color) {
  return {
    label,
    data: [],
    borderColor: color,
    backgroundColor: `${color}1a`, // ~10% opacity area wash, per marks-and-anatomy.md's area-fill spec
    borderWidth: 2, // 2px line, per spec
    tension: 0.3,
    pointRadius: 0, // quiet until hovered — the point only appears on interaction
    pointHoverRadius: 5,
    pointHoverBackgroundColor: color,
    pointHoverBorderColor: window.sentinelpayCssVar('--surface-strong'),
    pointHoverBorderWidth: 2,
    pointHitRadius: 10,
  };
}

function auditChartOptions() {
  const p = window.sentinelpayChartPalette();
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { ticks: { color: p.textFaint, font: { size: 11 } }, grid: { color: p.gridline } },
      y: {
        beginAtZero: true,
        ticks: { color: p.textFaint, font: { size: 11 }, precision: 0 },
        grid: { color: p.gridline },
      },
    },
    plugins: {
      legend: {
        labels: { color: p.textDim, usePointStyle: true, pointStyle: 'circle', padding: 16, font: { size: 12, weight: '600' } },
      },
      tooltip: window.sentinelpayChartTooltip(),
    },
  };
}

function initAuditChart() {
  if (typeof Chart === 'undefined') return null;
  const ctx = document.getElementById('audit-trend-chart');
  if (!ctx) return null;
  const p = window.sentinelpayChartPalette();
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        auditLineDataset('Allow', p.allow),
        auditLineDataset('Step-Up', p.stepup),
        auditLineDataset('Block', p.block),
      ],
    },
    options: auditChartOptions(),
  });
}

// Same rationale as analytics.js's restyleAnalyticsTrendChart: Chart.js never re-reads CSS on its
// own, so a theme toggle while the Audit tab is already open needs an explicit repaint.
function restyleAuditChart() {
  if (!auditChart) return;
  const p = window.sentinelpayChartPalette();
  const colors = [p.allow, p.stepup, p.block];
  auditChart.data.datasets.forEach((dataset, i) => {
    dataset.borderColor = colors[i];
    dataset.backgroundColor = `${colors[i]}1a`;
    dataset.pointHoverBackgroundColor = colors[i];
    dataset.pointHoverBorderColor = p.surface;
  });
  Object.assign(auditChart.options, auditChartOptions());
  auditChart.update();
}
document.addEventListener('sentinelpay:theme-changed', restyleAuditChart);

async function refreshAuditSummary() {
  try {
    const res = await window.sentinelpayAuthFetch('/audit/summary?hours=24&bucketMinutes=60');
    const data = await res.json();
    if (!auditChart) return;

    auditChart.data.labels = data.buckets.map((b) =>
      new Date(b.bucket_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
    auditChart.data.datasets[0].data = data.buckets.map((b) => b.allow);
    auditChart.data.datasets[1].data = data.buckets.map((b) => b.step_up);
    auditChart.data.datasets[2].data = data.buckets.map((b) => b.block);
    auditChart.update();
  } catch (err) {
    console.error('Failed to load audit summary:', err);
  }
}

async function refreshAuditTable() {
  const select = document.getElementById('audit-decision-filter');
  const tbody = document.getElementById('audit-table-body');
  if (!select || !tbody) return;

  try {
    const res = await window.sentinelpayAuthFetch(`/transactions?decision=${encodeURIComponent(select.value)}&limit=100`);
    const transactions = await res.json();

    tbody.innerHTML = '';
    if (transactions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No matching transactions.</td></tr>';
      return;
    }

    for (const tx of transactions) {
      const row = document.createElement('tr');
      const decisionClass = /^[a-z_]+$/.test(tx.decision || '') ? tx.decision : 'unknown';
      row.className = `decision-${decisionClass}`;
      const transactionIdAttr = escapeHtml(tx.transaction_id || '');
      row.innerHTML = `
        <td>${escapeHtml(new Date(tx.timestamp).toLocaleString())}</td>
        <td>${escapeHtml(resolveCounterpartyId(tx))}</td>
        <td>₹${Number(tx.amount).toFixed(2)}</td>
        <td>${escapeHtml(tx.merchant_id || '—')}</td>
        <td class="reasons">${escapeHtml(tx.purpose || '—')}</td>
        <td>${Number.isFinite(tx.fraud_score) ? tx.fraud_score : '—'}</td>
        <td class="decision-cell">${escapeHtml((tx.decision || '—').replace('_', '-'))}</td>
        <td class="reasons">${escapeHtml((tx.reasons || []).join('; ') || '—')}</td>
        <td>${transactionIdAttr ? `<button type="button" class="ask-ai-btn" data-transaction-id="${transactionIdAttr}">Ask AI</button>` : '—'}</td>
      `;
      tbody.appendChild(row);
    }
  } catch (err) {
    console.error('Failed to load audit table:', err);
  }
}

function initAuditView() {
  if (auditInitialized) return;
  auditInitialized = true;

  auditChart = initAuditChart();
  refreshAuditSummary();
  refreshAuditTable();

  const refreshBtn = document.getElementById('audit-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refreshAuditSummary();
      refreshAuditTable();
    });
  }
  const select = document.getElementById('audit-decision-filter');
  if (select) {
    select.addEventListener('change', refreshAuditTable);
  }
}

document.addEventListener('sentinelpay:view-shown', (event) => {
  if (event.detail.view === 'audit') initAuditView();
});

// Keep the trend chart/table reasonably fresh while the audit tab is open and live traffic
// keeps flowing, without needing a manual refresh click every time. Throttled — a fast demo
// traffic stream would otherwise fire a fetch() on every single transaction.
const AUDIT_LIVE_REFRESH_THROTTLE_MS = 3000;
let auditRefreshPending = false;
document.addEventListener('sentinelpay:transaction', () => {
  const auditView = document.getElementById('view-audit');
  if (!auditView || auditView.classList.contains('hidden') || !auditInitialized) return;
  if (auditRefreshPending) return;

  auditRefreshPending = true;
  setTimeout(() => {
    auditRefreshPending = false;
    refreshAuditSummary();
    refreshAuditTable();
  }, AUDIT_LIVE_REFRESH_THROTTLE_MS);
});
