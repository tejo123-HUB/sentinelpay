// Task 11 (stretch): historical view of flagged transactions over time — a trend chart plus
// a filterable audit table, per architecture.md Section 4.2.
let auditChart = null;
let auditInitialized = false;

function initAuditChart() {
  if (typeof Chart === 'undefined') return null;
  const ctx = document.getElementById('audit-trend-chart');
  if (!ctx) return null;
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Allow', data: [], borderColor: '#34d399', backgroundColor: '#34d39933', tension: 0.25 },
        { label: 'Step-Up', data: [], borderColor: '#fbbf24', backgroundColor: '#fbbf2433', tension: 0.25 },
        { label: 'Block', data: [], borderColor: '#f87171', backgroundColor: '#f8717133', tension: 0.25 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#8ba0c4' }, grid: { color: '#22314f' } },
        y: { beginAtZero: true, ticks: { color: '#8ba0c4', precision: 0 }, grid: { color: '#22314f' } },
      },
      plugins: { legend: { labels: { color: '#e6ecf5' } } },
    },
  });
}

async function refreshAuditSummary() {
  try {
    const res = await fetch('/audit/summary?hours=24&bucketMinutes=60');
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
    const res = await fetch(`/transactions?decision=${encodeURIComponent(select.value)}&limit=100`);
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
