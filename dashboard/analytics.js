// Section 15.16, Feature 15: the Analytics tab -- overview stats, fraud trend (configurable
// bucket granularity), a fraud heatmap, top-risky lists, top fraud categories, top mule
// accounts, gateway comparison, and CSV/PDF export. Consumes the Feature 18 analytics endpoints.
// Same lazy-init-on-first-view / throttled-live-refresh pattern as audit.js.
let analyticsInitialized = false;
let analyticsTrendChart = null;

// Same validated status palette as app.js's CHART_COLORS/audit.js's AUDIT_CHART_COLORS --
// duplicated per file since each renders to its own <canvas> and can't share CSS custom
// properties directly.
const ANALYTICS_CHART_COLORS = { allow: '#0ca30c', stepup: '#e0940a', block: '#d03b3b' };
const ANALYTICS_HEATMAP_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ANALYTICS_HEATMAP_EXPORT_LIMIT = 2000; // bounds the client-side heatmap computation

function analyticsLineDataset(label, color, extra = {}) {
  return {
    label,
    data: [],
    borderColor: color,
    backgroundColor: `${color}1a`,
    borderWidth: 2,
    tension: 0.3,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHoverBackgroundColor: color,
    pointHoverBorderColor: '#fcfcfb',
    pointHoverBorderWidth: 2,
    pointHitRadius: 10,
    ...extra,
  };
}

function initAnalyticsTrendChart() {
  if (typeof Chart === 'undefined') return null;
  const ctx = document.getElementById('analytics-trend-chart');
  if (!ctx) return null;
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        analyticsLineDataset('Allow', ANALYTICS_CHART_COLORS.allow),
        analyticsLineDataset('Step-Up', ANALYTICS_CHART_COLORS.stepup),
        analyticsLineDataset('Block', ANALYTICS_CHART_COLORS.block),
        // Predictive Fraud Forecasting (Partial-Feature Completion Pass): a dashed continuation
        // of the flagged-transaction trend, from GET /analytics/forecast's linear projection --
        // visually distinct (dashed, no fill) from the three solid historical series above.
        analyticsLineDataset('Forecast (flagged)', '#7a6fd1', { borderDash: [6, 4], backgroundColor: 'transparent' }),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { color: '#898781', font: { size: 11 } }, grid: { color: '#e1e0d9' } },
        y: { beginAtZero: true, ticks: { color: '#898781', font: { size: 11 }, precision: 0 }, grid: { color: '#e1e0d9' } },
      },
      plugins: {
        legend: { labels: { color: '#52514e', usePointStyle: true, pointStyle: 'circle', padding: 16, font: { size: 12, weight: '600' } } },
        tooltip: {
          backgroundColor: '#ffffff',
          titleColor: '#0b0b0b',
          bodyColor: '#52514e',
          borderColor: 'rgba(11,11,11,0.1)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
        },
      },
    },
  });
}

function trendLabelFormatter(bucket) {
  return (isoString) => {
    const d = new Date(isoString);
    if (bucket === 'hour') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (bucket === 'week' || bucket === 'month') return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
}

async function refreshAnalyticsTrend() {
  const select = document.getElementById('analytics-trend-bucket');
  const bucket = select ? select.value : 'hour';
  try {
    const res = await window.sentinelpayAuthFetch(`/analytics/trend?bucket=${encodeURIComponent(bucket)}`);
    const data = await res.json();
    if (!analyticsTrendChart) return;

    const formatLabel = trendLabelFormatter(bucket);
    analyticsTrendChart.data.labels = data.buckets.map((b) => formatLabel(b.bucket_start));
    analyticsTrendChart.data.datasets[0].data = data.buckets.map((b) => b.allow);
    analyticsTrendChart.data.datasets[1].data = data.buckets.map((b) => b.step_up);
    analyticsTrendChart.data.datasets[2].data = data.buckets.map((b) => b.block);
    analyticsTrendChart.data.datasets[3].data = data.buckets.map(() => null); // forecast placeholder, filled in by refreshAnalyticsForecast below
    analyticsTrendChart.update();

    await refreshAnalyticsForecast(bucket, data.buckets.length, formatLabel);
  } catch (err) {
    console.error('Failed to load analytics trend:', err);
  }
}

// Predictive Fraud Forecasting (Partial-Feature Completion Pass): appends GET /analytics/
// forecast's projected buckets onto the trend chart's 4th ("Forecast") dataset and x-axis labels,
// as a visually-distinct dashed continuation of the historical flagged-transaction line.
async function refreshAnalyticsForecast(bucket, historyPointCount, formatLabel) {
  if (!analyticsTrendChart) return;
  try {
    const res = await window.sentinelpayAuthFetch(`/analytics/forecast?bucket=${encodeURIComponent(bucket)}`);
    const data = await res.json();
    const forecastValues = (data.flagged_transactions && data.flagged_transactions.forecast) || [];
    if (forecastValues.length === 0) return;

    const bucketMsByType = { hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };
    const bucketMs = bucketMsByType[bucket] || bucketMsByType.day;
    const lastLabelIndex = analyticsTrendChart.data.labels.length - 1;
    const nowMs = Date.now();
    const nowBucketStartMs = Math.floor(nowMs / bucketMs) * bucketMs;

    // Extends the x-axis with one label per forecasted bucket, and pads every historical dataset
    // with null for those new points (Chart.js draws a gap, not a misleading zero) so only the
    // dashed Forecast line actually appears there.
    forecastValues.forEach((value, i) => {
      analyticsTrendChart.data.labels.push(formatLabel(new Date(nowBucketStartMs + (i + 1) * bucketMs).toISOString()));
      for (let d = 0; d < 3; d++) analyticsTrendChart.data.datasets[d].data.push(null);
      analyticsTrendChart.data.datasets[3].data.push(value);
    });
    // The forecast line should visually connect to the last real historical point, not start
    // from a gap -- backfill index lastLabelIndex (the last historical bucket) with its own
    // already-known flagged count so Chart.js draws an unbroken dashed line from there onward.
    if (lastLabelIndex >= 0 && historyPointCount > 0) {
      const lastHistoricalFlagged = (analyticsTrendChart.data.datasets[1].data[lastLabelIndex] || 0) + (analyticsTrendChart.data.datasets[2].data[lastLabelIndex] || 0);
      analyticsTrendChart.data.datasets[3].data[lastLabelIndex] = lastHistoricalFlagged;
    }

    analyticsTrendChart.update();
  } catch (err) {
    console.error('Failed to load analytics forecast:', err);
  }
}

async function refreshAnalyticsSummary() {
  try {
    const res = await window.sentinelpayAuthFetch('/analytics/summary');
    const s = await res.json();
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    set('an-total', s.total_processed);
    set('an-allowed', s.allowed);
    set('an-stepup', s.step_up);
    set('an-blocked', s.blocked);
    set('an-fraud-pct', `${s.fraud_percent}%`);
    set('an-blocked-amount', `₹${s.blocked_amount.toFixed(2)}`);
    set('an-recovered-amount', `₹${s.recovered_amount.toFixed(2)}`);
    set('an-latency', `${s.avg_latency_ms.toFixed(1)}ms`);
  } catch (err) {
    console.error('Failed to load analytics summary:', err);
  }
}

function renderTable(tbodyId, rows, columns, emptyMessage) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${columns.length}" class="empty-state">${escapeHtml(emptyMessage)}</td></tr>`;
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = columns.map((col) => `<td>${escapeHtml(col(row))}</td>`).join('');
    tbody.appendChild(tr);
  }
}

async function refreshAnalyticsTopRisky() {
  const select = document.getElementById('analytics-risky-dimension');
  const dimension = select ? select.value : 'merchants';
  try {
    const res = await window.sentinelpayAuthFetch(`/analytics/top-risky?dimension=${encodeURIComponent(dimension)}&limit=10`);
    const rows = await res.json();
    renderTable(
      'analytics-risky-table-body',
      rows,
      [(r) => r.key, (r) => r.flagged_count, (r) => `₹${Number(r.total_amount).toFixed(2)}`],
      'No data yet.'
    );
  } catch (err) {
    console.error('Failed to load top-risky:', err);
  }
}

async function refreshAnalyticsTopFrauds() {
  try {
    const res = await window.sentinelpayAuthFetch('/analytics/top-frauds?limit=10');
    const rows = await res.json();
    renderTable(
      'analytics-frauds-table-body',
      rows,
      [(r) => r.flag_type, (r) => r.count, (r) => r.avg_weight],
      'No flagged transactions yet.'
    );
  } catch (err) {
    console.error('Failed to load top-frauds:', err);
  }
}

async function refreshAnalyticsMules() {
  try {
    const res = await window.sentinelpayAuthFetch('/analytics/mule-accounts?limit=10');
    const rows = await res.json();
    renderTable(
      'analytics-mules-table-body',
      rows,
      [(r) => r.account_id, (r) => r.qualifyingCycles, (r) => r.receiptsScanned],
      'No suspected mule accounts detected.'
    );
  } catch (err) {
    console.error('Failed to load mule accounts:', err);
  }
}

async function refreshAnalyticsGateways() {
  try {
    const res = await window.sentinelpayAuthFetch('/analytics/gateway-comparison');
    const rows = await res.json();
    renderTable(
      'analytics-gateways-table-body',
      rows,
      [(r) => r.merchant_id, (r) => r.total, (r) => `${r.fraud_rate_percent}%`, (r) => `₹${Number(r.total_amount).toFixed(2)}`, (r) => r.avg_fraud_score],
      'No gateway activity yet.'
    );
  } catch (err) {
    console.error('Failed to load gateway comparison:', err);
  }
}

// Fraud heatmap: hour-of-day x day-of-week grid, colored by flagged-transaction density.
// Sequential single-hue ramp (dataviz skill convention: sequential = one hue, light->dark),
// computed client-side from a bounded recent-transaction export rather than a dedicated
// server-side endpoint -- the aggregation is cheap enough at this project's data scale and
// avoids adding a ninth analytics route for a single dashboard widget.
async function refreshAnalyticsHeatmap() {
  const container = document.getElementById('analytics-heatmap');
  if (!container) return;

  try {
    const res = await window.sentinelpayAuthFetch(`/analytics/export?format=json&limit=${ANALYTICS_HEATMAP_EXPORT_LIMIT}`);
    const transactions = await res.json();

    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    let max = 0;
    for (const tx of transactions) {
      if (tx.decision === 'allow') continue; // heatmap tracks flagged activity, not all traffic
      const d = new Date(tx.timestamp);
      const day = d.getDay();
      const hour = d.getHours();
      grid[day][hour] += 1;
      if (grid[day][hour] > max) max = grid[day][hour];
    }

    container.innerHTML = '';
    container.style.setProperty('--heatmap-cols', '25'); // 1 label column + 24 hour columns
    // Header row: blank corner + 24 hour labels (every 3rd hour, to avoid crowding).
    const corner = document.createElement('div');
    corner.className = 'heatmap-cell heatmap-corner';
    container.appendChild(corner);
    for (let hour = 0; hour < 24; hour += 1) {
      const label = document.createElement('div');
      label.className = 'heatmap-cell heatmap-hour-label';
      label.textContent = hour % 3 === 0 ? String(hour) : '';
      container.appendChild(label);
    }

    for (let day = 0; day < 7; day += 1) {
      const dayLabel = document.createElement('div');
      dayLabel.className = 'heatmap-cell heatmap-day-label';
      dayLabel.textContent = ANALYTICS_HEATMAP_DAYS[day];
      container.appendChild(dayLabel);

      for (let hour = 0; hour < 24; hour += 1) {
        const count = grid[day][hour];
        const intensity = max > 0 ? count / max : 0;
        const cell = document.createElement('div');
        cell.className = 'heatmap-cell heatmap-value';
        cell.style.setProperty('--heatmap-intensity', intensity.toFixed(2));
        cell.title = `${ANALYTICS_HEATMAP_DAYS[day]} ${hour}:00 — ${count} flagged`;
        if (count > 0) cell.textContent = count > 99 ? '99+' : String(count);
        container.appendChild(cell);
      }
    }
  } catch (err) {
    console.error('Failed to load heatmap data:', err);
  }
}

function refreshAllAnalytics() {
  refreshAnalyticsSummary();
  refreshAnalyticsTrend();
  refreshAnalyticsHeatmap();
  refreshAnalyticsTopRisky();
  refreshAnalyticsTopFrauds();
  refreshAnalyticsMules();
  refreshAnalyticsGateways();
  refreshAiInsights();
}

// ---- AI Fraud Insights / AI Assistant (Partial-Feature Completion Pass, Section 26) ----

async function refreshAiInsights() {
  const list = document.getElementById('ai-insights-list');
  if (!list) return;
  try {
    const res = await window.sentinelpayAuthFetch('/ai/insights');
    const data = await res.json();
    list.innerHTML = (data.insights || []).map((insight) => `<li>${escapeHtml(insight)}</li>`).join('') || '<li class="empty-state">No insights yet.</li>';
  } catch (err) {
    console.error('Failed to load AI insights:', err);
    list.innerHTML = '<li class="empty-state">Failed to load insights.</li>';
  }
}

// The interactive chat assistant itself now lives in dashboard/aiAssistant.js as a persistent,
// dashboard-wide floating widget (previously buried here as a small panel only reachable from
// this one tab) -- this file keeps only the read-only insights list, which is genuinely
// Analytics-specific (a snapshot of this period's own numbers, not a conversation).
function initAiInsightsPanel() {
  const refreshBtn = document.getElementById('ai-insights-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshAiInsights);

  const openAssistantBtn = document.getElementById('ai-insights-open-assistant');
  if (openAssistantBtn) {
    openAssistantBtn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('sentinelpay:open-ai-assistant'));
    });
  }
}

async function downloadCsvExport() {
  try {
    const res = await window.sentinelpayAuthFetch('/analytics/export?format=csv&limit=1000');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sentinelpay-export.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('CSV export failed:', err);
  }
}

// PDF export: no server-side PDF library (this project's dependency-light convention -- Chart.js
// and Leaflet are the only two frontend dependencies) -- instead, a print-only stylesheet
// (style.css's @media print rules) isolates the Analytics panel, and the browser's native
// print-to-PDF handles rendering. Verified to work in Chrome/Edge's "Save as PDF" print target.
function triggerPdfExport() {
  document.body.classList.add('printing-analytics');
  window.print();
  document.body.classList.remove('printing-analytics');
}

function initAnalyticsView() {
  if (analyticsInitialized) return;
  analyticsInitialized = true;

  analyticsTrendChart = initAnalyticsTrendChart();
  refreshAllAnalytics();

  const bucketSelect = document.getElementById('analytics-trend-bucket');
  if (bucketSelect) bucketSelect.addEventListener('change', refreshAnalyticsTrend);

  const dimensionSelect = document.getElementById('analytics-risky-dimension');
  if (dimensionSelect) dimensionSelect.addEventListener('change', refreshAnalyticsTopRisky);

  const csvBtn = document.getElementById('analytics-export-csv');
  if (csvBtn) csvBtn.addEventListener('click', downloadCsvExport);

  const pdfBtn = document.getElementById('analytics-export-pdf');
  if (pdfBtn) pdfBtn.addEventListener('click', triggerPdfExport);

  initAiInsightsPanel();
}

document.addEventListener('sentinelpay:view-shown', (event) => {
  if (event.detail.view === 'analytics') initAnalyticsView();
});

// Keep the Analytics tab reasonably fresh while open and live traffic keeps flowing, same
// throttled-refresh pattern as audit.js.
const ANALYTICS_LIVE_REFRESH_THROTTLE_MS = 5000;
let analyticsRefreshPending = false;
document.addEventListener('sentinelpay:transaction', () => {
  const view = document.getElementById('view-analytics');
  if (!view || view.classList.contains('hidden') || !analyticsInitialized) return;
  if (analyticsRefreshPending) return;

  analyticsRefreshPending = true;
  setTimeout(() => {
    analyticsRefreshPending = false;
    refreshAllAnalytics();
  }, ANALYTICS_LIVE_REFRESH_THROTTLE_MS);
});
