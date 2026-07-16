// Task 11 (stretch): historical view of flagged transactions over time — a trend chart plus
// a filterable audit table, per architecture.md Section 4.2.
let auditChart = null;
let auditInitialized = false;

// Same validated status palette as app.js's CHART_COLORS (dataviz skill's validate_palette.js
// against this dashboard's dark surface, see style.css's file header) — duplicated per file since
// each renders to its own <canvas> and can't share CSS custom properties.
const AUDIT_CHART_COLORS = { allow: '#22ac74', stepup: '#b8891b', block: '#cc4646' };

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
    pointHoverBorderColor: '#0f1626',
    pointHoverBorderWidth: 2,
    pointHitRadius: 10,
  };
}

function initAuditChart() {
  if (typeof Chart === 'undefined') return null;
  const ctx = document.getElementById('audit-trend-chart');
  if (!ctx) return null;
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        auditLineDataset('Allow', AUDIT_CHART_COLORS.allow),
        auditLineDataset('Step-Up', AUDIT_CHART_COLORS.stepup),
        auditLineDataset('Block', AUDIT_CHART_COLORS.block),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { color: '#5b6b8c', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: {
          beginAtZero: true,
          ticks: { color: '#5b6b8c', font: { size: 11 }, precision: 0 },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
      },
      plugins: {
        legend: {
          labels: { color: '#8b9bc0', usePointStyle: true, pointStyle: 'circle', padding: 16, font: { size: 12, weight: '600' } },
        },
        tooltip: {
          backgroundColor: '#141d33',
          titleColor: '#eef2fb',
          bodyColor: '#8b9bc0',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
        },
      },
    },
  });
}

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
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No matching transactions.</td></tr>';
      return;
    }

    for (const tx of transactions) {
      const row = document.createElement('tr');
      const decisionClass = /^[a-z_]+$/.test(tx.decision || '') ? tx.decision : 'unknown';
      row.className = `decision-${decisionClass}`;
      row.innerHTML = `
        <td>${escapeHtml(new Date(tx.timestamp).toLocaleString())}</td>
        <td>${escapeHtml(tx.sender_id)}</td>
        <td>${escapeHtml(tx.receiver_id)}</td>
        <td>₹${Number(tx.amount).toFixed(2)}</td>
        <td>${Number.isFinite(tx.fraud_score) ? tx.fraud_score : '—'}</td>
        <td class="decision-cell">${escapeHtml((tx.decision || '—').replace('_', '-'))}</td>
        <td class="reasons">${escapeHtml((tx.reasons || []).join('; ') || '—')}</td>
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
