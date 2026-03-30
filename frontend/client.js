/* ═══════════════════════════════════════════════════════════
   APP AUDITOR — client.js
   Single-page SPA logic: scan, render, tabs, category groups
════════════════════════════════════════════════════════════ */
 
'use strict';
 
/* ──────────────────────────────────────────────────────────
   METRIC HELPERS
────────────────────────────────────────────────────────── */
const parseMetricValue = (s) => {
  if (typeof s !== 'string') return 0;
  return parseFloat(s.replace(/[^0-9.]/g, '')) || 0;
};
 
const rateMetric = (val, good, avg) => val <= good ? 'good' : val <= avg ? 'warn' : 'poor';
 
const rateScore = (s) => s >= 90 ? 'good' : s >= 50 ? 'warn' : 'poor';
 
const CATEGORY_EMOJI = {
  'Analytics':           '📊',
  'Email & Marketing':   '📧',
  'Reviews':             '⭐',
  'Customer Service':    '💬',
  'Upsell & Cross-sell': '🛒',
  'Page Builder':        '🔧',
  'Subscriptions':       '🔄',
  'Loyalty & Rewards':   '🎁',
  'Shipping & Fulfillment': '📦',
  'Payments':            '💳',
  'SEO & Image Optimization': '🔍',
  'CDN & Hosting':       '☁️',
  'Compliance':          '📋',
  'Security':            '🔒',
  'Pop-ups & Notifications': '🔔',
  'Social Media':        '📱',
  'Navigation & UI':     '🗂️',
  'Translation':         '🌐',
  'Inventory & Alerts':  '📋',
  'Product Options':     '🎨',
  'B2B & Wholesale':     '🏢',
  'Digital Products':    '💾',
  'Dropshipping':        '📫',
  'Accessibility':       '♿',
  'Utilities':           '⚙️',
  'Store Management':    '🏪',
  'Services & Bookings': '📅',
  'Mobile':              '📲',
  'Trust & Security':    '🛡️',
  'Returns & Exchanges': '↩️',
};
 
/* ──────────────────────────────────────────────────────────
   STATE
────────────────────────────────────────────────────────── */
let scanState = {
  runPerfScan: false,
  runAppScan:  false,
  appReport:   null,
  perfReport:  null,
  hasError:    false,
};
let currentSort   = 'size';
let currentCatFilter = 'all';
let hasFinalized  = false;
let eventSource   = null;
 
/* ──────────────────────────────────────────────────────────
   DOM REFS (assigned on DOMContentLoaded)
────────────────────────────────────────────────────────── */
let elLog, elLoadingMsg, elSpinnerContainer, elLoading, elError, elErrorMsg, elAppShell;
 
/* ──────────────────────────────────────────────────────────
   TAB ROUTING
────────────────────────────────────────────────────────── */
function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
 
      // Lazy-render history when switching to it
      if (btn.dataset.tab === 'history') renderHistory();
    });
  });
}
 
/* ──────────────────────────────────────────────────────────
   STORE TYPE TOGGLE
────────────────────────────────────────────────────────── */
function initStoreTypeToggle() {
  const pg = document.getElementById('passwordGroup');
  const live = document.getElementById('liveStore');
  const prot = document.getElementById('protectedStore');
  const updatePG = () => {
    pg.classList.toggle('disabled', !prot.checked);
  };
  live.addEventListener('change', updatePG);
  prot.addEventListener('change', updatePG);
  updatePG();
}
 
/* ──────────────────────────────────────────────────────────
   SORT BUTTONS
────────────────────────────────────────────────────────── */
function initSort() {
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      if (scanState.appReport) reRenderCatBlocks(scanState.appReport);
    });
  });
}
 
/* ──────────────────────────────────────────────────────────
   SCAN BUTTON
────────────────────────────────────────────────────────── */
function initScanButton() {
  const btn = document.getElementById('scanButton');
  const urlInput = document.getElementById('storeUrl');
 
  btn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) { alert('Please enter a store URL.'); return; }
 
    const runApps  = document.getElementById('toggleApps').checked;
    const runPerf  = document.getElementById('togglePerformance').checked;
    const password = document.getElementById('protectedStore').checked
      ? document.getElementById('storePassword').value : '';
 
    if (!runApps && !runPerf) {
      alert('Please enable at least one scan type.'); return;
    }
 
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scanning...';
    startScan(url, password, runApps, runPerf);
  });
}
 
/* ──────────────────────────────────────────────────────────
   START SCAN (SSE)
────────────────────────────────────────────────────────── */
function startScan(storeUrl, storePassword, runAppScan, runPerfScan) {
  showLoading();
  hasFinalized = false;
 
  scanState = { runPerfScan, runAppScan, appReport: null, perfReport: null, hasError: false };
 
  const params = new URLSearchParams({ storeUrl, runAppScan, runPerfScan });
  if (storePassword) params.append('storePassword', storePassword);
 
  eventSource = new EventSource(`/scan-all?${params}`);
 
  eventSource.onopen = () => logMsg('Connection established. Starting scan…', 'info');
 
  eventSource.addEventListener('log', e => {
    const d = JSON.parse(e.data);
    logMsg(d.message, d.type || 'info');
  });
 
  eventSource.addEventListener('scanResult', e => {
    scanState.appReport = JSON.parse(e.data);
    logMsg('[System] App report received.', 'success');
  });
 
  eventSource.addEventListener('perfResult', e => {
    scanState.perfReport = JSON.parse(e.data);
    logMsg('[System] Performance report received.', 'success');
  });
 
  eventSource.addEventListener('scanComplete', () => {
    if (hasFinalized) return;
    eventSource.close();
    finalizeScan();
  });
 
  eventSource.addEventListener('scanError', e => {
    if (hasFinalized) return;
    const d = JSON.parse(e.data);
    logMsg(`[ERROR] ${d.details}`, 'error');
    scanState.hasError = true;
    eventSource.close();
    finalizeScan();
  });
 
  eventSource.onerror = () => {
    if (hasFinalized || eventSource.readyState === EventSource.CLOSED) return;
    logMsg('Connection error.', 'error');
    scanState.hasError = true;
    eventSource.close();
    finalizeScan();
  };
}
 
/* ──────────────────────────────────────────────────────────
   FINALIZE SCAN
────────────────────────────────────────────────────────── */
function finalizeScan() {
  if (hasFinalized) return;
  hasFinalized = true;
 
  const scanBtn = document.getElementById('scanButton');
  scanBtn.disabled = false;
  scanBtn.innerHTML = '<i class="fas fa-search"></i> Scan';
 
  if (scanState.hasError) {
    hideLoading();
    showError('Scan failed. Check the terminal log above for details.');
    return;
  }
 
  // Persist to session + history
  sessionStorage.setItem('lastScanData', JSON.stringify({
    appReport:  scanState.appReport,
    perfReport: scanState.perfReport,
  }));
 
  if (scanState.runPerfScan && scanState.perfReport?.metrics) {
    saveToHistory(scanState.perfReport);
  }
 
  // Switch to overview tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('.tab[data-tab="overview"]').classList.add('active');
  document.getElementById('tab-overview').classList.add('active');
 
  elLoadingMsg.textContent = 'Rendering results…';
  document.querySelector('#spinner-container .spinner').style.display = 'none';
 
  setTimeout(() => {
    hideLoading();
    elAppShell.style.display = 'block';
    renderOverview();
    if (scanState.runPerfScan) renderPerformance();
  }, 600);
}
 
/* ──────────────────────────────────────────────────────────
   RENDER OVERVIEW TAB
────────────────────────────────────────────────────────── */
function renderOverview() {
  const { appReport, perfReport } = scanState;
 
  document.getElementById('overview-empty').style.display = 'none';
  document.getElementById('overview-results').style.display = 'block';
 
  // Store URL label
  const urlInput = document.getElementById('storeUrl');
  document.getElementById('results-store-url').textContent = urlInput.value;
 
  // Score ring
  if (perfReport?.metrics?.performanceScore) {
    const score = parseInt(perfReport.metrics.performanceScore, 10);
    updateScoreRing(score);
  }
 
  // Vitals
  if (perfReport?.metrics) renderVitals(perfReport.metrics);
 
  // Summary meta
  if (appReport?.executiveSummary) {
    const e = appReport.executiveSummary;
    document.getElementById('results-meta').textContent =
      `${e.totalAppsDetected || 0} apps · ${e.totalAppSizeMb || 0} MB · ${e.totalRequests || 0} requests`;
 
    // Insight banner
    const banner = document.getElementById('insight-banner');
    const insights = [];
    if (e.highImpactApps > 0) insights.push(`🚨 ${e.highImpactApps} high-impact app${e.highImpactApps > 1 ? 's' : ''} slowing your store`);
    if (e.totalRequests > 80)  insights.push(`⚠️ ${e.totalRequests} requests (high)`);
    if (e.totalAppSizeMb > 1)  insights.push(`⚠️ ${e.totalAppSizeMb} MB app footprint`);
    if (perfReport?.metrics?.performanceScore < 50) insights.push('🚨 Poor performance score — action needed');
    if (insights.length) {
      banner.style.display = 'flex';
      banner.innerHTML = insights.map(i => `<span>${i}</span>`).join('');
    }
  }
 
  // Category blocks
  if (appReport?.appBreakdown) reRenderCatBlocks(appReport);
 
  // Unidentified
  renderUnidentified(appReport?.unidentifiedDomains);
 
  // Heavy hitters
  renderHeavyHitters(appReport?.heavyHitters);
}
 
/* ──────────────────────────────────────────────────────────
   SCORE RING ANIMATION
────────────────────────────────────────────────────────── */
function updateScoreRing(score) {
  const circle = document.getElementById('score-ring-circle');
  const valEl  = document.getElementById('score-val');
  const circumference = 2 * Math.PI * 34; // r=34
  const offset = circumference - (score / 100) * circumference;
 
  const rating = rateScore(score);
  const colorMap = { good: '#4ade80', warn: '#f59e0b', poor: '#f43f5e' };
  circle.setAttribute('stroke', colorMap[rating]);
  circle.setAttribute('stroke-dashoffset', String(offset));
 
  valEl.textContent = String(score);
  valEl.style.color = colorMap[rating];
}
 
/* ──────────────────────────────────────────────────────────
   VITALS SIDEBAR
────────────────────────────────────────────────────────── */
function renderVitals(metrics) {
  const el = document.getElementById('vitals-list');
  const defs = [
    { key: 'lcp',        label: 'LCP',     good: 2.5,  avg: 4.0  },
    { key: 'tbt',        label: 'TBT',     good: 200,  avg: 600  },
    { key: 'cls',        label: 'CLS',     good: 0.1,  avg: 0.25 },
    { key: 'fcp',        label: 'FCP',     good: 1.8,  avg: 3.0  },
    { key: 'speedIndex', label: 'Speed',   good: 3.4,  avg: 5.8  },
  ];
  el.innerHTML = defs.map(d => {
    const raw   = metrics[d.key] || 'N/A';
    const val   = parseMetricValue(raw);
    const cls   = raw === 'N/A' ? 'na' : rateMetric(val, d.good, d.avg);
    return `<div class="vital-row">
      <span class="vital-key">${d.label}</span>
      <span class="vital-val ${cls}">${raw}</span>
    </div>`;
  }).join('');
}
 
/* ──────────────────────────────────────────────────────────
   CATEGORY NAV SIDEBAR
────────────────────────────────────────────────────────── */
function renderCatNav(grouped) {
  const nav = document.getElementById('cat-nav');
  document.getElementById('cat-count-all').textContent =
    Object.values(grouped).reduce((s, a) => s + a.length, 0);
 
  // Remove old dynamic items
  nav.querySelectorAll('[data-cat]:not([data-cat="all"])').forEach(el => el.remove());
 
  Object.entries(grouped)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([cat, apps]) => {
      const btn = document.createElement('button');
      btn.className = 'cat-nav-item';
      btn.dataset.cat = cat;
      btn.innerHTML = `
        <span class="cat-left"><span class="cat-dot"></span>${cat}</span>
        <span class="cat-count">${apps.length}</span>
      `;
      btn.addEventListener('click', () => filterByCategory(cat, btn));
      nav.appendChild(btn);
    });
 
  // All button
  nav.querySelector('[data-cat="all"]').addEventListener('click', () => {
    filterByCategory('all', nav.querySelector('[data-cat="all"]'));
  });
}
 
function filterByCategory(cat, clickedBtn) {
  document.querySelectorAll('.cat-nav-item').forEach(b => b.classList.remove('active'));
  clickedBtn.classList.add('active');
  currentCatFilter = cat;
 
  document.querySelectorAll('.cat-block').forEach(block => {
    block.style.display = (cat === 'all' || block.dataset.cat === cat) ? '' : 'none';
  });
}
 
/* ──────────────────────────────────────────────────────────
   SORT APPS
────────────────────────────────────────────────────────── */
function sortApps(apps) {
  const impactOrder = { High: 3, Medium: 2, Low: 1 };
  return [...apps].sort((a, b) => {
    if (currentSort === 'size')   return b.totalSizeKb - a.totalSizeKb;
    if (currentSort === 'time')   return b.totalDurationMs - a.totalDurationMs;
    if (currentSort === 'impact') return (impactOrder[b.impact] || 0) - (impactOrder[a.impact] || 0);
    return 0;
  });
}
 
/* ──────────────────────────────────────────────────────────
   GROUP APPS BY CATEGORY
────────────────────────────────────────────────────────── */
function groupByCategory(appBreakdown) {
  const grouped = {};
  appBreakdown.forEach(app => {
    const cat = app.category || 'Uncategorized';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(app);
  });
  return grouped;
}
 
/* ──────────────────────────────────────────────────────────
   RENDER / RE-RENDER CATEGORY BLOCKS
────────────────────────────────────────────────────────── */
function reRenderCatBlocks(appReport) {
  const container = document.getElementById('cat-blocks-container');
  const grouped   = groupByCategory(appReport.appBreakdown);
 
  // Update sidebar nav
  renderCatNav(grouped);
 
  // Highest-impact category first
  const catOrder = Object.entries(grouped).sort((a, b) => {
    const score = apps => apps.filter(a => a.impact === 'High').length * 3 +
                          apps.filter(a => a.impact === 'Medium').length;
    return score(b[1]) - score(a[1]);
  });
 
  container.innerHTML = '';
 
  catOrder.forEach(([cat, apps]) => {
    const sortedApps = sortApps(apps);
    const totalSize  = apps.reduce((s, a) => s + a.totalSizeKb, 0).toFixed(0);
    const highCount  = apps.filter(a => a.impact === 'High').length;
    const medCount   = apps.filter(a => a.impact === 'Medium').length;
 
    // Category-level impact
    let catImpactLabel, catImpactColor, barPct;
    if (highCount > 0) {
      catImpactLabel = 'HIGH impact'; catImpactColor = 'var(--danger)';
      barPct = Math.min(100, 60 + highCount * 20);
    } else if (medCount > 0) {
      catImpactLabel = 'MED impact'; catImpactColor = 'var(--warn)';
      barPct = Math.min(60, 30 + medCount * 15);
    } else {
      catImpactLabel = 'LOW impact'; catImpactColor = 'var(--green)';
      barPct = 12;
    }
 
    const emoji = CATEGORY_EMOJI[cat] || '📦';
 
    const block = document.createElement('div');
    block.className = 'cat-block';
    block.dataset.cat = cat;
 
    block.innerHTML = `
      <div class="cat-header">
        <div class="cat-header-left">
          <span class="cat-emoji">${emoji}</span>
          <span class="cat-name">${cat}</span>
          <span class="cat-badge">${apps.length} app${apps.length > 1 ? 's' : ''}</span>
        </div>
        <span class="cat-stat" style="color:${catImpactColor}">${catImpactLabel}</span>
        <div class="cat-impact-col">
          <div class="cat-bar-wrap">
            <div class="cat-bar-fill" style="width:${barPct}%;background:${catImpactColor}"></div>
          </div>
          <div class="cat-bar-label">${totalSize} KB</div>
        </div>
        <span class="cat-chevron open">▶</span>
      </div>
      <div class="app-list" data-list>
        ${sortedApps.map(app => buildAppRow(app)).join('')}
      </div>
    `;
 
    // Cat header toggle
    block.querySelector('.cat-header').addEventListener('click', () => {
      const list    = block.querySelector('[data-list]');
      const chevron = block.querySelector('.cat-chevron');
      const isOpen  = chevron.classList.contains('open');
      list.style.display  = isOpen ? 'none' : '';
      chevron.classList.toggle('open', !isOpen);
    });
 
    // App row toggles
    block.querySelectorAll('.app-row').forEach(row => {
      row.addEventListener('click', () => toggleAppRow(row, block));
    });
 
    container.appendChild(block);
  });
 
  // Re-apply current filter
  if (currentCatFilter !== 'all') {
    filterByCategory(currentCatFilter, document.querySelector(`.cat-nav-item[data-cat="${currentCatFilter}"]`));
  }
}
 
/* ──────────────────────────────────────────────────────────
   BUILD SINGLE APP ROW HTML
────────────────────────────────────────────────────────── */
function buildAppRow(app) {
  const initials = app.name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
 
  const sizeClass = app.totalSizeKb > 400 ? 'red' : app.totalSizeKb > 150 ? 'warn' : 'good';
  const timeClass = app.totalDurationMs > 1200 ? 'red' : app.totalDurationMs > 500 ? 'warn' : 'good';
 
  const impactPill = app.impact === 'High'
    ? '<span class="impact-pill high">HIGH</span>'
    : app.impact === 'Medium'
    ? '<span class="impact-pill medium">MED</span>'
    : '<span class="impact-pill low">LOW</span>';
 
  // TBT contribution from perf culprits
  const culprits = scanState.perfReport?.culprits?.identified || [];
  const tbtItem  = culprits.find(c => c.appName === app.name);
  const tbtMs    = tbtItem?.duration || 0;
 
  // Asset rows
  const assetRows = (app.assets || []).map(asset => {
    const fname   = (asset.url || '').split('/').pop().split('?')[0] || asset.url;
    const flagged = asset.sizeKb > 50 || asset.durationMs > 500;
    return `<tr>
      <td title="${asset.url}">${fname.length > 50 ? fname.slice(0, 50) + '…' : fname}</td>
      <td>${asset.type || '—'}</td>
      <td class="${flagged ? 'flagged' : ''}">${asset.sizeKb} KB</td>
      <td class="${flagged ? 'flagged' : ''}">${Math.round(asset.durationMs)} ms</td>
    </tr>`;
  }).join('');
 
  const tbtLine = tbtMs > 0
    ? `<div class="tbt-savings">✂ Removing this app could save ~${Math.round(tbtMs)} ms of TBT</div>`
    : '';
 
  const tipBox = app.recommendation
    ? `<div class="tip-box"><span class="tip-icon">💡</span>${app.recommendation}</div>`
    : '';
 
  const assetTable = assetRows
    ? `<table class="asset-table">
        <thead><tr><th>File</th><th>Type</th><th>Size</th><th>Load time</th></tr></thead>
        <tbody>${assetRows}</tbody>
      </table>`
    : '<p style="font-size:12px;color:var(--muted);">No asset details available.</p>';
 
  return `
    <div class="app-row" data-app="${escHtml(app.name)}">
      ${app.icon
        ? `<img class="app-icon" src="${escHtml(app.icon)}" alt="${escHtml(app.name)}"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <span class="app-icon-fb" style="${app.icon ? 'display:none' : ''}">${initials}</span>
      <span class="app-name">${escHtml(app.name)}</span>
      <span class="app-mono ${sizeClass}">${app.totalSizeKb} KB</span>
      <span class="app-mono ${timeClass}">${app.totalDurationMs} ms</span>
      ${impactPill}
      <span class="expand-arrow">▶</span>
    </div>
    <div class="detail-panel">
      ${tipBox}
      ${assetTable}
      ${tbtLine}
    </div>
  `;
}
 
function toggleAppRow(row, block) {
  const panel  = row.nextElementSibling;
  const isOpen = row.classList.contains('is-open');
 
  // Close all other rows in this block
  block.querySelectorAll('.app-row.is-open').forEach(r => {
    if (r !== row) {
      r.classList.remove('is-open');
      r.nextElementSibling.classList.remove('open');
    }
  });
 
  row.classList.toggle('is-open', !isOpen);
  panel.classList.toggle('open', !isOpen);
}
 
/* ──────────────────────────────────────────────────────────
   UNIDENTIFIED DOMAINS
────────────────────────────────────────────────────────── */
function renderUnidentified(domains) {
  const el = document.getElementById('unidentified-section');
  if (!domains || !domains.length) { el.innerHTML = ''; return; }
 
  el.innerHTML = `
    <div class="info-card" style="margin-top:14px">
      <h3>⚠️ Unidentified Domains <span style="color:var(--warn);font-family:var(--mono)">(${domains.length})</span></h3>
      <p style="font-size:12px;color:var(--muted);margin-bottom:10px">
        These hostnames didn't match any known app. They may be new apps — add them to fingerprintDatabase.json.
      </p>
      <ul class="info-card-list">
        ${domains.map(d => `
          <li>
            <span>${escHtml(d)}</span>
            <button class="copy-btn" onclick="copyText('${escHtml(d)}')">Copy</button>
          </li>`).join('')}
      </ul>
    </div>`;
}
 
/* ──────────────────────────────────────────────────────────
   HEAVY HITTERS
────────────────────────────────────────────────────────── */
function renderHeavyHitters(hitters) {
  const el = document.getElementById('heavy-hitters-section');
  if (!hitters || !hitters.length) { el.innerHTML = ''; return; }
 
  const sorted = [...hitters].sort((a, b) => b.sizeKb - a.sizeKb);
  el.innerHTML = `
    <div class="info-card" style="margin-top:10px">
      <h3>🔴 Heavy Unidentified Scripts <span style="color:var(--danger);font-family:var(--mono)">(${sorted.length})</span></h3>
      <p style="font-size:12px;color:var(--muted);margin-bottom:10px">Scripts over 150 KB not matched to any known app — prime candidates for optimisation.</p>
      <ul class="info-card-list">
        ${sorted.map(s => {
          const short = s.url.length > 70 ? '…' + s.url.slice(-70) : s.url;
          return `<li>
            <span title="${escHtml(s.url)}">${escHtml(short)}</span>
            <span style="color:var(--danger);font-family:var(--mono);flex-shrink:0;margin-left:8px">${s.sizeKb} KB</span>
          </li>`;
        }).join('')}
      </ul>
    </div>`;
}
 
/* ──────────────────────────────────────────────────────────
   PERFORMANCE TAB
────────────────────────────────────────────────────────── */
function renderPerformance() {
  const { perfReport } = scanState;
  const emptyEl   = document.getElementById('perf-empty');
  const contentEl = document.getElementById('perf-content');
 
  if (!perfReport || !perfReport.metrics) {
    emptyEl.style.display = 'flex'; contentEl.style.display = 'none'; return;
  }
  emptyEl.style.display = 'none'; contentEl.style.display = 'block';
 
  const m = perfReport.metrics;
  const cats = perfReport.categories;
 
  const metricDefs = [
    { key: 'lcp',        label: 'LCP',        good: 2.5,  avg: 4.0,  unit: 's' },
    { key: 'tbt',        label: 'TBT',        good: 200,  avg: 600,  unit: 'ms' },
    { key: 'cls',        label: 'CLS',        good: 0.1,  avg: 0.25, unit: '' },
    { key: 'fcp',        label: 'FCP',        good: 1.8,  avg: 3.0,  unit: 's' },
    { key: 'speedIndex', label: 'Speed Index', good: 3.4,  avg: 5.8,  unit: 's' },
  ];
 
  const catCards = cats ? Object.entries(cats).map(([id, cat]) => {
    if (!cat) return '';
    const score = Math.round(cat.score * 100);
    const cls   = rateScore(score);
    return `<div class="metric-card">
      <div class="m-label">${cat.title}</div>
      <div class="m-val ${cls}">${score}</div>
    </div>`;
  }).join('') : '';
 
  contentEl.innerHTML = `
    <p class="perf-section-title">Category Scores</p>
    <div class="perf-grid">${catCards}</div>
 
    <p class="perf-section-title">Core Web Vitals</p>
    <div class="perf-grid">
      ${metricDefs.map(d => {
        const raw = m[d.key] || 'N/A';
        const val = parseMetricValue(raw);
        const cls = raw === 'N/A' ? 'na' : rateMetric(val, d.good, d.avg);
        const descs = {
          lcp: 'Time for the largest content element to appear.',
          tbt: 'Total time the main thread was blocked.',
          cls: 'How much the layout shifts unexpectedly.',
          fcp: 'Time for the first content to paint.',
          speedIndex: 'How quickly content is visually populated.',
        };
        return `<div class="metric-card">
          <div class="m-label">${d.label}</div>
          <div class="m-val ${cls}">${raw}</div>
          <div class="m-desc">${descs[d.key] || ''}</div>
        </div>`;
      }).join('')}
    </div>
 
    ${perfReport.culprits ? buildCulpritsSection(perfReport.culprits) : ''}
    ${perfReport.audits   ? buildAuditSection(perfReport.audits, cats)  : ''}
  `;
}
 
function buildCulpritsSection(culprits) {
  if (!culprits.identified?.length && !culprits.unidentified?.length) return '';
  const rows = [
    ...culprits.identified.map(c => `
      <div class="audit-block">
        <div class="audit-head">
          <div class="audit-dot poor"></div>
          <span class="audit-head-title">${escHtml(c.appName)}</span>
          <span class="audit-head-val">${c.duration.toFixed(0)} ms CPU</span>
        </div>
      </div>`),
    ...culprits.unidentified.map(c => {
      let label = c.url;
      try { label = new URL(c.url).hostname; } catch {}
      return `
      <div class="audit-block">
        <div class="audit-head">
          <div class="audit-dot warn"></div>
          <span class="audit-head-title" title="${escHtml(c.url)}">${escHtml(label)}</span>
          <span class="audit-head-val">${c.duration.toFixed(0)} ms CPU</span>
        </div>
      </div>`;
    }),
  ].join('');
  return `<p class="perf-section-title">Main-Thread Culprits</p>${rows}`;
}
 
function buildAuditSection(audits, cats) {
  if (!cats) return '';
  const allRefs = Object.values(cats).flatMap(c => c?.auditRefs || []);
  const failed  = [];
 
  allRefs.forEach(ref => {
    if (ref.group === 'metrics') return;
    const audit = audits[ref.id];
    if (!audit || audit.score === 1 || audit.scoreDisplayMode === 'notApplicable') return;
    if (audit.details?.items?.length === 0) return;
    failed.push(audit);
  });
 
  if (!failed.length) return '';
 
  const rows = failed.map(audit => {
    const score  = audit.score ?? 0;
    const dotCls = score >= 0.9 ? 'good' : score >= 0.5 ? 'warn' : 'poor';
    const cleanDesc = (audit.description || '').replace(/\[.*?\]\(.*?\)/g, '').trim();
    return `
      <div class="audit-block">
        <div class="audit-head" onclick="toggleAudit(this)">
          <div class="audit-dot ${dotCls}"></div>
          <span class="audit-head-title">${escHtml(audit.title)}</span>
          <span class="audit-head-val">${audit.displayValue || ''}</span>
          <span class="audit-chevron">▶</span>
        </div>
        <div class="audit-body">
          <p>${escHtml(cleanDesc)}</p>
        </div>
      </div>`;
  }).join('');
 
  return `<p class="perf-section-title">Failed Audits</p>${rows}`;
}
 
function toggleAudit(head) {
  const body    = head.nextElementSibling;
  const chevron = head.querySelector('.audit-chevron');
  const isOpen  = chevron.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  chevron.classList.toggle('open', !isOpen);
}
 
/* ──────────────────────────────────────────────────────────
   HISTORY TAB
────────────────────────────────────────────────────────── */
function renderHistory() {
  const history = JSON.parse(localStorage.getItem('appAuditorHistory') || '[]');
  const emptyEl  = document.getElementById('history-empty');
  const contentEl = document.getElementById('history-content');
 
  if (!history.length) {
    emptyEl.style.display = 'flex'; contentEl.style.display = 'none'; return;
  }
  emptyEl.style.display = 'none'; contentEl.style.display = 'block';
 
  const labels    = history.map(e => new Date(e.date).toLocaleDateString());
  const perfScores = history.map(e => e.performanceScore);
  const lcpData   = history.map(e => e.lcp);
  const tbtData   = history.map(e => e.tbt);
  const clsData   = history.map(e => e.cls);
 
  const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length);
 
  const avgPerf = avg(perfScores).toFixed(0);
  const avgLcp  = avg(lcpData).toFixed(2);
  const avgTbt  = avg(tbtData).toFixed(0);
 
  document.getElementById('kpi-grid').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Scans run</div><div class="kpi-val">${history.length}</div></div>
    <div class="kpi-card"><div class="kpi-label">Avg performance</div><div class="kpi-val ${rateScore(avgPerf)}">${avgPerf}</div></div>
    <div class="kpi-card"><div class="kpi-label">Avg LCP</div><div class="kpi-val">${avgLcp}s</div></div>
    <div class="kpi-card"><div class="kpi-label">Avg TBT</div><div class="kpi-val">${avgTbt}ms</div></div>
  `;
 
  // Charts (destroy if already exists)
  ['scoresChart','vitalsChart'].forEach(id => {
    const existing = Chart.getChart(id);
    if (existing) existing.destroy();
  });
 
  Chart.defaults.color = '#8892a4';
  Chart.defaults.borderColor = '#2a2f45';
 
  new Chart(document.getElementById('scoresChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Performance Score',
        data: perfScores,
        borderColor: '#6d7cff',
        backgroundColor: 'rgba(109,124,255,.1)',
        fill: true,
        tension: 0.3,
        pointBackgroundColor: '#6d7cff',
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#8892a4' } } },
      scales: { y: { min: 0, max: 100, ticks: { color: '#8892a4' } }, x: { ticks: { color: '#8892a4' } } },
    },
  });
 
  new Chart(document.getElementById('vitalsChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'LCP (s)',  data: lcpData, borderColor: '#4ade80', tension: 0.3, yAxisID: 'yS', pointBackgroundColor: '#4ade80' },
        { label: 'TBT (ms)', data: tbtData, borderColor: '#f43f5e', tension: 0.3, yAxisID: 'yMs', pointBackgroundColor: '#f43f5e' },
        { label: 'CLS',      data: clsData, borderColor: '#f59e0b', tension: 0.3, yAxisID: 'yS', pointBackgroundColor: '#f59e0b' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#8892a4' } } },
      scales: {
        yS:  { type: 'linear', position: 'left',  beginAtZero: true, ticks: { color: '#8892a4' } },
        yMs: { type: 'linear', position: 'right', beginAtZero: true, ticks: { color: '#8892a4' }, grid: { display: false } },
        x:   { ticks: { color: '#8892a4' }, grid: { display: false } },
      },
    },
  });
 
  document.getElementById('clearHistoryBtn').onclick = () => {
    if (!confirm('Delete all scan history?')) return;
    localStorage.removeItem('appAuditorHistory');
    renderHistory();
  };
}
 
/* ──────────────────────────────────────────────────────────
   GHOST CODE SCAN
────────────────────────────────────────────────────────── */
function initGhostScan() {
  const btn     = document.getElementById('scan-ghost-code-btn');
  const log     = document.getElementById('ghost-log');
  const loading = document.getElementById('ghost-loading');
  if (!btn) return;
 
  btn.addEventListener('click', () => {
    log.textContent = '';
    log.style.display = 'block';
    loading.style.display = 'flex';
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scanning…';
 
    const es = new EventSource('/scan-ghost-code');
 
    es.addEventListener('log', e => {
      const d = JSON.parse(e.data);
      log.textContent += d.message + '\n';
      log.scrollTop = log.scrollHeight;
    });
 
    es.addEventListener('scanComplete', e => {
      const d = JSON.parse(e.data);
      log.textContent += `\n✓ ${d.message}`;
      es.close(); done();
    });
 
    es.addEventListener('scanError', e => {
      const d = JSON.parse(e.data);
      log.textContent += `\n✗ ERROR: ${d.details}`;
      es.close(); done();
    });
 
    function done() {
      loading.style.display = 'none';
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-ghost"></i> Scan Theme Files';
    }
  });
}
 
/* ──────────────────────────────────────────────────────────
   HISTORY PERSISTENCE
────────────────────────────────────────────────────────── */
function saveToHistory(perfReport) {
  try {
    const entry = {
      date: new Date().toISOString(),
      performanceScore: parseInt(perfReport.metrics.performanceScore, 10),
      accessibilityScore: Math.round((perfReport.categories?.accessibility?.score || 0) * 100),
      bestPracticesScore: Math.round((perfReport.categories?.['best-practices']?.score || 0) * 100),
      seoScore: Math.round((perfReport.categories?.seo?.score || 0) * 100),
      lcp: parseMetricValue(perfReport.metrics.lcp),
      tbt: parseMetricValue(perfReport.metrics.tbt),
      cls: parseMetricValue(perfReport.metrics.cls),
    };
    const hist = JSON.parse(localStorage.getItem('appAuditorHistory') || '[]');
    hist.push(entry);
    localStorage.setItem('appAuditorHistory', JSON.stringify(hist));
  } catch (e) {
    console.error('History save failed:', e);
  }
}
 
/* ──────────────────────────────────────────────────────────
   UI STATE
────────────────────────────────────────────────────────── */
function showLoading() {
  // Switch to overview tab for the terminal
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('.tab[data-tab="overview"]').classList.add('active');
  document.getElementById('tab-overview').classList.add('active');
 
  elLog.innerHTML = '';
  elLoadingMsg.textContent = 'Connecting to server…';
  elSpinnerContainer.querySelector('.spinner').style.display = '';
  elLoading.style.display = 'flex';
  elAppShell.style.display = 'none';
  elError.style.display = 'none';
}
 
function hideLoading() {
  elLoading.style.display = 'none';
}
 
function showError(msg) {
  elError.style.display = 'flex';
  elErrorMsg.textContent = msg;
}
 
function logMsg(message, type = 'info') {
  const line = document.createElement('span');
  line.className = `log-line log-${type}`;
  line.textContent = message;
  elLog.appendChild(line);
  elLog.parentElement.scrollTop = elLog.parentElement.scrollHeight;
 
  // Mirror to loading message
  if (message.startsWith('[+]') || message.startsWith('[System]')) {
    elLoadingMsg.textContent = message.replace(/^\[.*?\]\s*/, '').slice(0, 60);
  }
}
 
/* ──────────────────────────────────────────────────────────
   UTILITIES
────────────────────────────────────────────────────────── */
function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
 
let toastTimer;
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    let toast = document.getElementById('copy-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'copy-toast';
      toast.className = 'copy-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = 'Copied!';
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
  });
}
 
// Expose for inline onclick in audit section
window.toggleAudit = toggleAudit;
window.copyText    = copyText;
 
/* ──────────────────────────────────────────────────────────
   BOOT — restore last scan if exists
────────────────────────────────────────────────────────── */
function tryRestoreLastScan() {
  const saved = sessionStorage.getItem('lastScanData');
  if (!saved) return;
  try {
    const { appReport, perfReport } = JSON.parse(saved);
    if (!appReport && !perfReport) return;
    scanState.appReport  = appReport;
    scanState.perfReport = perfReport;
    scanState.runAppScan  = !!appReport;
    scanState.runPerfScan = !!perfReport;
    elAppShell.style.display = 'block';
    if (appReport)  renderOverview();
    if (perfReport) renderPerformance();
  } catch {}
}
 
/* ──────────────────────────────────────────────────────────
   INIT
────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  elLog              = document.getElementById('log-output');
  elLoadingMsg       = document.getElementById('loading-message');
  elSpinnerContainer = document.getElementById('spinner-container');
  elLoading          = document.getElementById('loading-placeholder');
  elError            = document.getElementById('error-placeholder');
  elErrorMsg         = document.getElementById('error-msg');
  elAppShell         = document.getElementById('app-shell');
 
  initTabs();
  initStoreTypeToggle();
  initSort();
  initScanButton();
  initGhostScan();
  tryRestoreLastScan();
});
 
