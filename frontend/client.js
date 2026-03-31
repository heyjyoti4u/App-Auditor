 'use strict';

/* ── HELPERS ──────────────────────────────────────────── */
const parseMetricValue = s => typeof s === 'string' ? parseFloat(s.replace(/[^0-9.]/g, '')) || 0 : 0;
const rateMetric = (v, g, a) => v <= g ? 'good' : v <= a ? 'warn' : 'poor';
const rateScore  = s => +s >= 90 ? 'good' : +s >= 50 ? 'warn' : 'poor';
const escHtml    = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const CATEGORY_EMOJI = {
  'Analytics':'📊','Email & Marketing':'📧','Reviews':'⭐','Customer Service':'💬',
  'Upsell & Cross-sell':'🛒','Page Builder':'🔧','Subscriptions':'🔄','Loyalty & Rewards':'🎁',
  'Shipping & Fulfillment':'📦','Payments':'💳','SEO & Image Optimization':'🔍','CDN & Hosting':'☁️',
  'Compliance':'📋','Security':'🔒','Pop-ups & Notifications':'🔔','Social Media':'📱',
  'Navigation & UI':'🗂️','Translation':'🌐','Inventory & Alerts':'📋','Product Options':'🎨',
  'B2B & Wholesale':'🏢','Digital Products':'💾','Dropshipping':'📫','Accessibility':'♿',
  'Utilities':'⚙️','Store Management':'🏪','Services & Bookings':'📅','Mobile':'📲',
  'Trust & Security':'🛡️','Returns & Exchanges':'↩️',
};

/* ── STATE ────────────────────────────────────────────── */
let scanState = { runPerfScan:false, runAppScan:false, appReport:null, perfReport:null, hasError:false };
let currentSort = 'impact', currentCatFilter = 'all', hasFinalized = false, eventSource = null;
let elLog, elLoadingMsg, elSpinnerContainer, elLoading, elError, elErrorMsg, elAppShell;
let allImageData = [];

/* ══════════════════════════════════════════════════════
   TAB ROUTING
══════════════════════════════════════════════════════ */
function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
      if (btn.dataset.tab === 'history') renderHistory();
    });
  });
}

/* ══════════════════════════════════════════════════════
   STORE TYPE TOGGLE
══════════════════════════════════════════════════════ */
function initStoreTypeToggle() {
  const pg = document.getElementById('passwordGroup');
  const updatePG = () => pg.classList.toggle('disabled', !document.getElementById('protectedStore').checked);
  document.getElementById('liveStore').addEventListener('change', updatePG);
  document.getElementById('protectedStore').addEventListener('change', updatePG);
  updatePG();
}

/* ══════════════════════════════════════════════════════
   SORT BUTTONS
══════════════════════════════════════════════════════ */
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

/* ══════════════════════════════════════════════════════
   MAIN SCAN BUTTON
══════════════════════════════════════════════════════ */
function initScanButton() {
  const btn = document.getElementById('scanButton');
  btn.addEventListener('click', () => {
    const url = document.getElementById('storeUrl').value.trim();
    if (!url) { alert('Please enter a store URL.'); return; }

    const adminTokenEl = document.getElementById('adminToken');
    const adminToken   = adminTokenEl ? adminTokenEl.value.trim() : '';

    const runApps = document.getElementById('toggleApps').checked;
    const runPerf = document.getElementById('togglePerformance').checked;
    const pwd     = document.getElementById('protectedStore').checked ? document.getElementById('storePassword').value : '';
    if (!runApps && !runPerf) { alert('Please enable at least one scan type.'); return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scanning...';

    // ── KEY DECISION: use Admin API for apps if token provided ──
    if (runApps && adminToken) {
      startScanWithApiApps(url, pwd, runApps, runPerf, 'desktop', adminToken);
    } else {
      startScan(url, pwd, runApps, runPerf, 'desktop', adminToken);
    }
  });
}

/* ══════════════════════════════════════════════════════
   START SCAN — Admin API for apps + optional Lighthouse
   Called when adminToken is present
══════════════════════════════════════════════════════ */
function startScanWithApiApps(storeUrl, storePassword, runAppScan, runPerfScan, device = 'desktop', adminToken = '') {
  showLoading();
  hasFinalized = false;
  scanState = { runPerfScan, runAppScan, appReport: null, perfReport: null, hasError: false };

  logMsg('[System] Using Shopify Admin API for accurate app detection...', 'success');

  let appDone  = !runAppScan;
  let perfDone = !runPerfScan;

  // ── Step 1: App scan via Admin API ──────────────────
  if (runAppScan) {
    const params = new URLSearchParams({ storeUrl, adminToken });
    const es = new EventSource(`/scan-apps-api?${params}`);

    es.addEventListener('log',        e => { const d = JSON.parse(e.data); logMsg(d.message, d.type || 'info'); });
    es.addEventListener('scanResult', e => {
      scanState.appReport = JSON.parse(e.data);
      logMsg('[System] ✅ App data received from Shopify Admin API (100% accurate).', 'success');
    });
    es.addEventListener('scanComplete', () => {
      es.close();
      appDone = true;
      checkBothDone();
    });
    es.addEventListener('scanError', e => {
      logMsg(`[ERROR] App API scan failed: ${JSON.parse(e.data).details}`, 'error');
      scanState.hasError = true;
      es.close();
      appDone = true;
      checkBothDone();
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      logMsg('App API connection error.', 'error');
      scanState.hasError = true;
      es.close();
      appDone = true;
      checkBothDone();
    };
  }

  // ── Step 2: Performance scan via Lighthouse ──────────
  if (runPerfScan) {
    logMsg('[System] Starting Lighthouse performance scan in parallel...', 'info');
    const params = new URLSearchParams({ storeUrl, device });
    if (storePassword) params.append('storePassword', storePassword);

    const es2 = new EventSource(`/scan-speed?${params}`);

    es2.addEventListener('log',         e => { const d = JSON.parse(e.data); logMsg(d.message, d.type || 'info'); });
    es2.addEventListener('speedResult', e => {
      scanState.perfReport = JSON.parse(e.data);
      logMsg('[System] ✅ Performance report received.', 'success');
    });
    es2.addEventListener('scanComplete', () => {
      es2.close();
      perfDone = true;
      checkBothDone();
    });
    es2.addEventListener('scanError', e => {
      logMsg(`[ERROR] Perf scan failed: ${JSON.parse(e.data).details}`, 'error');
      es2.close();
      perfDone = true;
      checkBothDone();
    });
    es2.onerror = () => {
      if (es2.readyState === EventSource.CLOSED) return;
      es2.close();
      perfDone = true;
      checkBothDone();
    };
  }

  function checkBothDone() {
    if (appDone && perfDone && !hasFinalized) {
      finalizeScan();
    }
  }
}

/* ══════════════════════════════════════════════════════
   START SCAN — SSE (puppeteer-based fallback)
══════════════════════════════════════════════════════ */
function startScan(storeUrl, storePassword, runAppScan, runPerfScan, device = 'desktop', adminToken = '') {
  showLoading();
  hasFinalized = false;
  scanState = { runPerfScan, runAppScan, appReport:null, perfReport:null, hasError:false };

  logMsg('[System] Using Puppeteer-based scan (for accurate app data, add your Shopify Admin Token above).', 'info');

  const params = new URLSearchParams({ storeUrl, runAppScan, runPerfScan, device });
  if (storePassword) params.append('storePassword', storePassword);
  if (adminToken) params.append('adminToken', adminToken);

  eventSource = new EventSource(`/scan-all?${params}`);

  eventSource.onopen = () => logMsg('Connection established. Starting scan...', 'info');
  eventSource.addEventListener('log',        e => { const d = JSON.parse(e.data); logMsg(d.message, d.type || 'info'); });
  eventSource.addEventListener('scanResult', e => { scanState.appReport  = JSON.parse(e.data); logMsg('[System] App report received.', 'success'); });
  eventSource.addEventListener('perfResult', e => { scanState.perfReport = JSON.parse(e.data); logMsg('[System] Performance report received.', 'success'); });
  eventSource.addEventListener('scanComplete', () => { if (!hasFinalized) { eventSource.close(); finalizeScan(); } });
  eventSource.addEventListener('scanError',  e => {
    if (hasFinalized) return;
    logMsg(`[ERROR] ${JSON.parse(e.data).details}`, 'error');
    scanState.hasError = true; eventSource.close(); finalizeScan();
  });
  eventSource.onerror = () => {
    if (hasFinalized || eventSource.readyState === EventSource.CLOSED) return;
    logMsg('Connection error.', 'error'); scanState.hasError = true; eventSource.close(); finalizeScan();
  };
}

/* ══════════════════════════════════════════════════════
   FINALIZE SCAN
══════════════════════════════════════════════════════ */
function finalizeScan() {
  if (hasFinalized) return;
  hasFinalized = true;

  const scanBtn = document.getElementById('scanButton');
  scanBtn.disabled = false;
  scanBtn.innerHTML = '<i class="fas fa-search"></i> Scan';

  if (scanState.hasError && !scanState.appReport && !scanState.perfReport) {
    hideLoading(); showError('Scan failed. Check the log for details.'); return;
  }

  sessionStorage.setItem('lastScanData', JSON.stringify({ appReport: scanState.appReport, perfReport: scanState.perfReport }));
  if (scanState.runPerfScan && scanState.perfReport?.metrics) saveToHistory(scanState.perfReport);

  // Switch to overview tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('.tab[data-tab="overview"]').classList.add('active');
  document.getElementById('tab-overview').classList.add('active');

  elLoadingMsg.textContent = 'Rendering results...';
  elSpinnerContainer.querySelector('.spinner').style.display = 'none';

  setTimeout(() => {
    hideLoading();
    elAppShell.style.display = 'block';
    if (scanState.runAppScan)  renderOverview();
    if (scanState.runPerfScan) renderPerformance();
    renderSpeedHistory();
  }, 500);
}

/* ══════════════════════════════════════════════════════
   OVERVIEW TAB
══════════════════════════════════════════════════════ */
function renderOverview() {
  const { appReport, perfReport } = scanState;
  if (!appReport) return;

  document.getElementById('overview-empty').style.display = 'none';
  document.getElementById('overview-results').style.display = 'block';
  document.getElementById('results-store-url').textContent = document.getElementById('storeUrl').value;

  if (perfReport?.metrics?.performanceScore) updateScoreRing(parseInt(perfReport.metrics.performanceScore, 10));
  if (perfReport?.metrics) renderVitals(perfReport.metrics);

  const e = appReport.executiveSummary || {};
  const sourceTag = appReport.source === 'shopify_admin_api'
    ? ' <span style="font-size:10px;background:rgba(74,222,128,.15);color:var(--green);border:1px solid rgba(74,222,128,.3);padding:1px 6px;border-radius:4px;font-family:var(--mono)">✓ Admin API</span>'
    : '';

  document.getElementById('results-meta').innerHTML =
    `${e.totalAppsDetected || 0} apps · ${e.totalAppSizeMb || 0} MB${sourceTag}`;

  const banner = document.getElementById('insight-banner');
  const insights = [];
  if (e.highImpactApps > 0) insights.push(`🚨 ${e.highImpactApps} high-impact app${e.highImpactApps > 1 ? 's' : ''}`);
  if (e.totalRequests > 80)  insights.push(`⚠️ ${e.totalRequests} requests (high)`);
  if (e.totalAppSizeMb > 1)  insights.push(`⚠️ ${e.totalAppSizeMb} MB footprint`);
  if (perfReport?.metrics?.performanceScore < 50) insights.push('🚨 Poor performance score');
  if (appReport.source === 'shopify_admin_api') insights.push('✅ App list sourced from Shopify Admin API — 100% accurate');
  if (insights.length) { banner.style.display = 'flex'; banner.innerHTML = insights.map(i => `<span>${i}</span>`).join(''); }

  if (appReport.appBreakdown) reRenderCatBlocks(appReport);
  renderUnidentified(appReport.unidentifiedDomains);
  renderHeavyHitters(appReport.heavyHitters);
}

function updateScoreRing(score) {
  const circle = document.getElementById('score-ring-circle');
  const valEl  = document.getElementById('score-val');
  const offset = 213.6 - (score / 100) * 213.6;
  const color  = { good:'#4ade80', warn:'#f59e0b', poor:'#f43f5e' }[rateScore(score)];
  circle.setAttribute('stroke', color);
  circle.setAttribute('stroke-dashoffset', String(offset));
  valEl.textContent = String(score);
  valEl.style.color = color;
}

function renderVitals(metrics) {
  const el = document.getElementById('vitals-list');
  const defs = [
    { key:'lcp', label:'LCP', good:2.5, avg:4.0 },
    { key:'tbt', label:'TBT', good:200, avg:600 },
    { key:'cls', label:'CLS', good:0.1, avg:0.25 },
    { key:'fcp', label:'FCP', good:1.8, avg:3.0 },
    { key:'speedIndex', label:'Speed', good:3.4, avg:5.8 },
  ];
  el.innerHTML = defs.map(d => {
    const raw = metrics[d.key] || 'N/A';
    const cls = raw === 'N/A' ? 'na' : rateMetric(parseMetricValue(raw), d.good, d.avg);
    return `<div class="vital-row"><span class="vital-key">${d.label}</span><span class="vital-val ${cls}">${raw}</span></div>`;
  }).join('');
}

function renderCatNav(grouped) {
  const nav = document.getElementById('cat-nav');
  document.getElementById('cat-count-all').textContent = Object.values(grouped).reduce((s, a) => s + a.length, 0);
  nav.querySelectorAll('[data-cat]:not([data-cat="all"])').forEach(el => el.remove());
  Object.entries(grouped).sort((a,b) => b[1].length - a[1].length).forEach(([cat, apps]) => {
    const btn = document.createElement('button');
    btn.className = 'cat-nav-item'; btn.dataset.cat = cat;
    btn.innerHTML = `<span class="cat-left"><span class="cat-dot"></span>${cat}</span><span class="cat-count">${apps.length}</span>`;
    btn.addEventListener('click', () => filterByCategory(cat, btn));
    nav.appendChild(btn);
  });
  nav.querySelector('[data-cat="all"]').onclick = () => filterByCategory('all', nav.querySelector('[data-cat="all"]'));
}

function filterByCategory(cat, clickedBtn) {
  document.querySelectorAll('.cat-nav-item').forEach(b => b.classList.remove('active'));
  clickedBtn.classList.add('active');
  currentCatFilter = cat;
  document.querySelectorAll('.cat-block').forEach(block => {
    block.style.display = (cat === 'all' || block.dataset.cat === cat) ? '' : 'none';
  });
}

function sortApps(apps) {
  const order = { High:3, Medium:2, Low:1 };
  return [...apps].sort((a, b) =>
    currentSort === 'size'   ? b.totalSizeKb - a.totalSizeKb :
    currentSort === 'time'   ? b.totalDurationMs - a.totalDurationMs :
    currentSort === 'impact' ? (order[b.impact]||0) - (order[a.impact]||0) : 0
  );
}

function groupByCategory(appBreakdown) {
  const grouped = {};
  appBreakdown.forEach(app => {
    const cat = app.category || 'Uncategorized';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(app);
  });
  return grouped;
}

function reRenderCatBlocks(appReport) {
  const container = document.getElementById('cat-blocks-container');
  const grouped   = groupByCategory(appReport.appBreakdown);
  renderCatNav(grouped);

  const catOrder = Object.entries(grouped).sort((a, b) => {
    const score = apps => apps.filter(a => a.impact==='High').length*3 + apps.filter(a => a.impact==='Medium').length;
    return score(b[1]) - score(a[1]);
  });

  container.innerHTML = '';
  catOrder.forEach(([cat, apps]) => {
    const sorted    = sortApps(apps);
    const totalKb   = apps.reduce((s,a) => s + (a.totalSizeKb || 0), 0).toFixed(0);
    const highCount = apps.filter(a => a.impact==='High').length;
    const medCount  = apps.filter(a => a.impact==='Medium').length;
    const [label, color, pct] = highCount > 0
      ? ['HIGH impact','var(--danger)', Math.min(100,60+highCount*20)]
      : medCount > 0
      ? ['MED impact','var(--warn)', Math.min(60,30+medCount*15)]
      : ['LOW impact','var(--green)', 12];

    // For API scans, show app count instead of KB when no size data
    const isApiScan = appReport.source === 'shopify_admin_api';
    const sizeLabel = isApiScan ? `${apps.length} app${apps.length>1?'s':''}` : `${totalKb} KB`;

    const block = document.createElement('div');
    block.className = 'cat-block'; block.dataset.cat = cat;
    block.innerHTML = `
      <div class="cat-header">
        <div class="cat-header-left">
          <span class="cat-emoji">${CATEGORY_EMOJI[cat]||'📦'}</span>
          <span class="cat-name">${cat}</span>
          <span class="cat-badge">${apps.length} app${apps.length>1?'s':''}</span>
        </div>
        <span class="cat-stat" style="color:${color}">${label}</span>
        <div class="cat-impact-col">
          <div class="cat-bar-wrap"><div class="cat-bar-fill" style="width:${pct}%;background:${color}"></div></div>
          <div class="cat-bar-label">${sizeLabel}</div>
        </div>
        <span class="cat-chevron open">▶</span>
      </div>
      <div class="app-list" data-list>
        ${sorted.map(app => buildAppRow(app, isApiScan)).join('')}
      </div>`;

    block.querySelector('.cat-header').addEventListener('click', () => {
      const list = block.querySelector('[data-list]');
      const chev = block.querySelector('.cat-chevron');
      const open = chev.classList.contains('open');
      list.style.display = open ? 'none' : '';
      chev.classList.toggle('open', !open);
    });
    block.querySelectorAll('.app-row').forEach(row => row.addEventListener('click', () => toggleAppRow(row, block)));
    container.appendChild(block);
  });

  if (currentCatFilter !== 'all') {
    const btn = document.querySelector(`.cat-nav-item[data-cat="${currentCatFilter}"]`);
    if (btn) filterByCategory(currentCatFilter, btn);
  }
}

function buildAppRow(app, isApiScan = false) {
  const initials  = app.name.split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase();
  const pill = app.impact === 'High' ? '<span class="impact-pill high">HIGH</span>'
    : app.impact === 'Medium' ? '<span class="impact-pill medium">MED</span>'
    : '<span class="impact-pill low">LOW</span>';

  // For API scans: show developer name instead of size/time columns
  let metricsHtml = '';
  if (isApiScan) {
    metricsHtml = `<span class="app-mono" style="font-size:11px;color:var(--muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(app.developer || '')}</span>`;
  } else {
    const sizeClass = app.totalSizeKb > 400 ? 'red' : app.totalSizeKb > 150 ? 'warn' : 'good';
    const timeClass = app.totalDurationMs > 1200 ? 'red' : app.totalDurationMs > 500 ? 'warn' : 'good';
    metricsHtml = `<span class="app-mono ${sizeClass}">${app.totalSizeKb} KB</span>
      <span class="app-mono ${timeClass}">${app.totalDurationMs} ms</span>`;
  }

  const tbtMs = (scanState.perfReport?.culprits?.identified || []).find(c=>c.appName===app.name)?.duration || 0;
  const assetRows = (app.assets||[]).map(a => {
    const fname = (a.url||'').split('/').pop().split('?')[0] || a.url;
    const fl = a.sizeKb > 50 || a.durationMs > 500;
    return `<tr><td title="${a.url}">${fname.length>50?fname.slice(0,50)+'…':fname}</td><td>${a.type||'—'}</td><td class="${fl?'flagged':''}">${a.sizeKb} KB</td><td class="${fl?'flagged':''}">${Math.round(a.durationMs)} ms</td></tr>`;
  }).join('');

  // Extra info for API-sourced apps
  const apiInfoHtml = isApiScan ? `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      ${app.pricingSummary ? `<span style="font-size:11px;background:var(--surface2);border:1px solid var(--border);padding:2px 8px;border-radius:4px;font-family:var(--mono);color:var(--muted)">${escHtml(app.pricingSummary)}</span>` : ''}
      ${app.appStoreUrl ? `<a href="${escHtml(app.appStoreUrl)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent);text-decoration:none;font-family:var(--mono)">View on App Store ↗</a>` : ''}
    </div>` : '';

  return `
    <div class="app-row" data-app="${escHtml(app.name)}">
      ${app.icon ? `<img class="app-icon" src="${escHtml(app.icon)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
      <span class="app-icon-fb" style="${app.icon?'display:none':''}">${initials}</span>
      <span class="app-name">${escHtml(app.name)}</span>
      ${metricsHtml}
      ${pill}
      <span class="expand-arrow">▶</span>
    </div>
    <div class="detail-panel">
      ${apiInfoHtml}
      ${app.recommendation ? `<div class="tip-box"><span>💡</span>${app.recommendation}</div>` : ''}
      ${assetRows ? `<table class="asset-table"><thead><tr><th>File</th><th>Type</th><th>Size</th><th>Load time</th></tr></thead><tbody>${assetRows}</tbody></table>` : (isApiScan ? '<p style="font-size:12px;color:var(--muted)">Asset-level data not available — sourced from Shopify Admin API.</p>' : '<p style="font-size:12px;color:var(--muted)">No asset details.</p>')}
      ${tbtMs > 0 ? `<div class="tbt-savings">✂ Removing this app could save ~${Math.round(tbtMs)} ms of TBT</div>` : ''}
    </div>`;
}

function toggleAppRow(row, block) {
  const panel  = row.nextElementSibling;
  const isOpen = row.classList.contains('is-open');
  block.querySelectorAll('.app-row.is-open').forEach(r => { if(r!==row){r.classList.remove('is-open');r.nextElementSibling.classList.remove('open');} });
  row.classList.toggle('is-open', !isOpen);
  panel.classList.toggle('open', !isOpen);
}

function renderUnidentified(domains) {
  const el = document.getElementById('unidentified-section');
  if (!domains?.length) { el.innerHTML=''; return; }
  el.innerHTML = `<div class="info-card" style="margin-top:12px">
    <h3>⚠️ Unidentified Domains <span style="color:var(--warn);font-family:var(--mono)">(${domains.length})</span></h3>
    <p style="font-size:12px;color:var(--muted);margin-bottom:9px">These didn't match any known app — add to fingerprintDatabase.json.</p>
    <ul class="info-card-list">${domains.map(d=>`<li><span>${escHtml(d)}</span><button class="copy-btn" onclick="copyText('${escHtml(d)}')">Copy</button></li>`).join('')}</ul>
  </div>`;
}

function renderHeavyHitters(hitters) {
  const el = document.getElementById('heavy-hitters-section');
  if (!hitters?.length) { el.innerHTML=''; return; }
  const sorted = [...hitters].sort((a,b)=>b.sizeKb-a.sizeKb);
  el.innerHTML = `<div class="info-card" style="margin-top:10px">
    <h3>🔴 Heavy Unidentified Scripts <span style="color:var(--danger);font-family:var(--mono)">(${sorted.length})</span></h3>
    <ul class="info-card-list">${sorted.map(s=>{const short=s.url.length>70?'…'+s.url.slice(-70):s.url;return`<li><span title="${escHtml(s.url)}">${escHtml(short)}</span><span style="color:var(--danger);font-family:var(--mono);flex-shrink:0;margin-left:8px">${s.sizeKb} KB</span></li>`;}).join('')}</ul>
  </div>`;
}

/* ══════════════════════════════════════════════════════
   PERFORMANCE TAB
══════════════════════════════════════════════════════ */
function renderPerformance() {
  const { perfReport } = scanState;
  const emptyEl   = document.getElementById('perf-empty');
  const contentEl = document.getElementById('perf-content');
  if (!perfReport?.metrics) { emptyEl.style.display='flex'; contentEl.style.display='none'; return; }
  emptyEl.style.display='none'; contentEl.style.display='block';

  const m = perfReport.metrics, cats = perfReport.categories;
  const metricDefs = [
    {key:'lcp',label:'LCP',good:2.5,avg:4.0,desc:'Largest Contentful Paint'},
    {key:'tbt',label:'TBT',good:200,avg:600,desc:'Total Blocking Time'},
    {key:'cls',label:'CLS',good:0.1,avg:0.25,desc:'Cumulative Layout Shift'},
    {key:'fcp',label:'FCP',good:1.8,avg:3.0,desc:'First Contentful Paint'},
    {key:'speedIndex',label:'Speed Index',good:3.4,avg:5.8,desc:'Visual population speed'},
  ];

  const catCards = cats ? Object.entries(cats).map(([,cat]) => {
    if (!cat) return '';
    const score = Math.round(cat.score * 100);
    return `<div class="metric-card"><div class="m-label">${cat.title}</div><div class="m-val ${rateScore(score)}">${score}</div></div>`;
  }).join('') : '';

  contentEl.innerHTML = `
    <p class="perf-section-title">Category Scores</p>
    <div class="perf-grid">${catCards}</div>
    <p class="perf-section-title">Core Web Vitals</p>
    <div class="perf-grid">${metricDefs.map(d=>{
      const raw=m[d.key]||'N/A', val=parseMetricValue(raw), cls=raw==='N/A'?'na':rateMetric(val,d.good,d.avg);
      return `<div class="metric-card"><div class="m-label">${d.label}</div><div class="m-val ${cls}">${raw}</div><div class="m-desc">${d.desc}</div></div>`;
    }).join('')}</div>
    ${perfReport.culprits ? buildCulpritsSection(perfReport.culprits) : ''}
    ${perfReport.audits && cats ? buildAuditSection(perfReport.audits, cats) : ''}`;
}

function buildCulpritsSection(c) {
  if (!c.identified?.length && !c.unidentified?.length) return '';
  const rows = [
    ...c.identified.map(x=>`<div class="audit-block"><div class="audit-head"><div class="audit-dot poor"></div><span class="audit-head-title">${escHtml(x.appName)}</span><span class="audit-head-val">${x.duration.toFixed(0)} ms CPU</span></div></div>`),
    ...c.unidentified.map(x=>{let l=x.url;try{l=new URL(x.url).hostname;}catch{}return`<div class="audit-block"><div class="audit-head"><div class="audit-dot warn"></div><span class="audit-head-title" title="${escHtml(x.url)}">${escHtml(l)}</span><span class="audit-head-val">${x.duration.toFixed(0)} ms CPU</span></div></div>`;}),
  ].join('');
  return `<p class="perf-section-title">Main-Thread Culprits</p>${rows}`;
}

function buildAuditSection(audits, cats) {
  const allRefs = Object.values(cats).flatMap(c => c?.auditRefs || []);
  const failed  = [];
  allRefs.forEach(ref => {
    if (ref.group==='metrics') return;
    const audit = audits[ref.id];
    if (!audit||audit.score===1||audit.scoreDisplayMode==='notApplicable') return;
    if (audit.details?.items?.length===0) return;
    failed.push(audit);
  });
  if (!failed.length) return '';
  const rows = failed.map(audit => {
    const dot = audit.score>=0.9?'good':audit.score>=0.5?'warn':'poor';
    const desc = (audit.description||'').replace(/\[.*?\]\(.*?\)/g,'').trim();
    return `<div class="audit-block"><div class="audit-head" onclick="toggleAudit(this)"><div class="audit-dot ${dot}"></div><span class="audit-head-title">${escHtml(audit.title)}</span><span class="audit-head-val">${audit.displayValue||''}</span><span class="audit-chevron">▶</span></div><div class="audit-body"><p>${escHtml(desc)}</p></div></div>`;
  }).join('');
  return `<p class="perf-section-title">Failed Audits</p>${rows}`;
}
function toggleAudit(head) {
  const body=head.nextElementSibling, chev=head.querySelector('.audit-chevron'), open=chev.classList.contains('open');
  body.classList.toggle('open',!open); chev.classList.toggle('open',!open);
}

/* ══════════════════════════════════════════════════════
   SPEED AUDIT TAB
══════════════════════════════════════════════════════ */
function initSpeedAudit() {
  const btn = document.getElementById('runSpeedTest');
  if (!btn) return;

  document.querySelectorAll('.device-btn').forEach(b => {
    b.addEventListener('click', function() {
      document.querySelectorAll('.device-btn').forEach(x => x.classList.remove('active'));
      this.classList.add('active');
    });
  });

  btn.addEventListener('click', () => {
    const url = document.getElementById('storeUrl').value.trim();
    if (!url) { alert('Enter a store URL at the top first.'); return; }
    const pwd    = document.getElementById('protectedStore').checked ? document.getElementById('storePassword').value : '';
    const device = document.querySelector('.device-btn.active')?.dataset.device || 'mobile';

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Running...';

    const loadingEl = document.getElementById('speed-test-loading');
    const logEl     = document.getElementById('speed-test-log');
    loadingEl.style.display = 'block';
    logEl.textContent = '';

    const params = new URLSearchParams({ storeUrl: url, device });
    if (pwd) params.append('storePassword', pwd);

    const es = new EventSource(`/scan-speed?${params}`);

    es.addEventListener('log', e => {
      const d = JSON.parse(e.data);
      logEl.textContent += d.message + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    });

    es.addEventListener('speedResult', e => {
      const perfReport = JSON.parse(e.data);
      if (perfReport?.metrics) {
        const histEntry = {
          url,
          device,
          date: new Date().toISOString(),
          performanceScore: parseInt(perfReport.metrics.performanceScore, 10),
          accessibilityScore: Math.round((perfReport.categories?.accessibility?.score||0)*100),
          bestPracticesScore: Math.round((perfReport.categories?.['best-practices']?.score||0)*100),
          seoScore: Math.round((perfReport.categories?.seo?.score||0)*100),
          lcp: parseMetricValue(perfReport.metrics.lcp),
          tbt: parseMetricValue(perfReport.metrics.tbt),
          cls: parseMetricValue(perfReport.metrics.cls),
        };
        const hist = JSON.parse(localStorage.getItem('appAuditorHistory') || '[]');
        hist.push(histEntry);
        localStorage.setItem('appAuditorHistory', JSON.stringify(hist));
      }
      renderSpeedResult(perfReport);
    });

    es.addEventListener('scanComplete', () => { es.close(); done(); });
    es.addEventListener('scanError',   e => {
      const d = JSON.parse(e.data);
      logEl.textContent += `\nERROR: ${d.details}`;
      es.close(); done();
    });

    function done() {
      loadingEl.style.display = 'none';
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-play"></i> Run Test';
      renderSpeedHistory();
    }
  });

  renderSpeedHistory();
}

function renderSpeedResult(perfReport) {
  const card = document.getElementById('speed-result-card');
  const content = document.getElementById('speed-result-content');
  if (!perfReport?.metrics) return;
  card.style.display = 'block';

  const m = perfReport.metrics;
  const score = m.performanceScore;
  const color = score >= 90 ? 'var(--green)' : score >= 50 ? 'var(--warn)' : 'var(--danger)';
  const metricDefs = [
    {key:'lcp',label:'LCP',good:2.5,avg:4.0},
    {key:'tbt',label:'TBT',good:200,avg:600},
    {key:'cls',label:'CLS',good:0.1,avg:0.25},
    {key:'fcp',label:'FCP',good:1.8,avg:3.0},
    {key:'speedIndex',label:'Speed Index',good:3.4,avg:5.8},
  ];

  content.innerHTML = `
    <div style="display:flex;align-items:center;gap:20px;margin-bottom:16px;flex-wrap:wrap">
      <div style="text-align:center">
        <div style="font-family:var(--mono);font-size:40px;font-weight:600;color:${color}">${score}</div>
        <div style="font-size:11px;color:var(--muted)">Performance Score</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;flex:1">
        ${metricDefs.map(d=>{
          const raw=m[d.key]||'N/A', val=parseMetricValue(raw), cls=raw==='N/A'?'na':rateMetric(val,d.good,d.avg);
          return `<div class="metric-card" style="padding:10px"><div class="m-label">${d.label}</div><div class="m-val ${cls}" style="font-size:16px">${raw}</div></div>`;
        }).join('')}
      </div>
    </div>
    <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">Device: ${m.device} · Scanned: ${new Date().toLocaleTimeString()}</div>`;
}

function renderSpeedHistory() {
  const tbody = document.getElementById('speedHistoryBody');
  if (!tbody) return;
  const history = JSON.parse(localStorage.getItem('appAuditorHistory') || '[]');
  if (!history.length) { tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No tests run yet.</td></tr>'; return; }
  tbody.innerHTML = [...history].reverse().slice(0, 15).map(e => {
    const color = e.performanceScore>=90?'var(--green)':e.performanceScore>=50?'var(--warn)':'var(--danger)';
    const device = e.device || 'desktop';
    return `<tr>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(e.url||'—')}</td>
      <td style="font-weight:600;color:${color};font-family:var(--mono);font-size:16px">${e.performanceScore}</td>
      <td style="font-family:var(--mono)">${e.lcp}s</td>
      <td style="font-family:var(--mono)">${e.tbt}ms</td>
      <td style="font-family:var(--mono)">${e.cls}</td>
      <td><span style="font-size:10px;background:var(--surface2);padding:2px 7px;border-radius:4px;font-family:var(--mono);text-transform:uppercase">${device}</span></td>
      <td style="color:var(--muted)">${new Date(e.date).toLocaleDateString()}</td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════
   IMAGE OPTIMIZER TAB
══════════════════════════════════════════════════════ */
function initImageScan() {
  const btn = document.getElementById('runImageScan');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const url = document.getElementById('storeUrl').value.trim();
    if (!url) { alert('Enter a store URL at the top first.'); return; }
    const pwd = document.getElementById('protectedStore').checked ? document.getElementById('storePassword').value : '';

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scanning...';
    document.getElementById('image-scan-loading').style.display = 'block';
    document.getElementById('image-empty').style.display = 'none';
    document.getElementById('image-results').style.display = 'none';

    const logEl = document.getElementById('image-scan-log');
    const params = new URLSearchParams({ storeUrl: url });
    if (pwd) params.append('storePassword', pwd);
    const es = new EventSource(`/scan-images?${params}`);

    es.addEventListener('log', e => {
      const d = JSON.parse(e.data);
      logEl.textContent += d.message + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    });

    es.addEventListener('imageResult', e => {
      const data = JSON.parse(e.data);
      es.close(); done();
      renderImageResults(data);
    });

    es.addEventListener('scanError', e => {
      const d = JSON.parse(e.data);
      logEl.textContent += `\nERROR: ${d.details}`;
      es.close(); done();
    });

    function done() {
      document.getElementById('image-scan-loading').style.display = 'none';
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-rotate"></i> Re-scan';
    }
  });

  document.getElementById('img-filter-pills')?.addEventListener('click', e => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    renderImageTable(allImageData, pill.dataset.filter);
  });
}

function renderImageResults(data) {
  allImageData = data.images || [];
  document.getElementById('image-results').style.display = 'block';
  document.getElementById('image-empty').style.display = 'none';

  const grade = data.scoreGrade || 'D';
  const gradeEl = document.getElementById('img-grade-circle');
  gradeEl.className = `img-grade-circle grade-${grade.toLowerCase()}`;
  document.getElementById('img-grade-letter').textContent = grade;
  document.getElementById('img-score-number').textContent = data.score;

  document.getElementById('istat-total-val').textContent     = data.totalImages;
  document.getElementById('istat-alt-val').textContent       = data.missingAlt;
  document.getElementById('istat-oversized-val').textContent = data.oversized;
  document.getElementById('istat-large-val').textContent     = data.largeFiles;
  document.getElementById('istat-format-val').textContent    = data.nonModern;

  const savingsKb = data.potentialSavingsKb;
  document.getElementById('img-savings-val').textContent  = savingsKb >= 1000 ? `${(savingsKb/1024).toFixed(1)} MB` : `${savingsKb} KB`;
  document.getElementById('img-current-size').textContent  = `${data.totalSizeMb} MB`;
  document.getElementById('img-after-size').textContent    = `~${data.afterOptimizationMb} MB`;
  const pct = data.totalSizeMb > 0 ? Math.min(100, Math.round((savingsKb/1024) / data.totalSizeMb * 100)) : 0;
  document.getElementById('img-savings-bar').style.width  = `${100 - pct}%`;

  const issues = [
    { label:'Missing alt text', count: data.missingAlt, color:'var(--danger)' },
    { label:'Oversized images', count: data.oversized,  color:'var(--warn)'   },
    { label:'Large files (>500KB)', count: data.largeFiles, color:'var(--warn)' },
    { label:'Non-modern format', count: data.nonModern, color:'var(--muted)'  },
  ];
  document.getElementById('img-issue-breakdown').innerHTML = issues.map(i => `
    <div class="img-issue-row">
      <span>${i.label}</span>
      <span class="img-issue-count" style="color:${i.color}">${i.count}</span>
    </div>`).join('');

  renderImageTable(allImageData, 'all');
}

function renderImageTable(images, filter) {
  const tbody = document.getElementById('img-audit-tbody');
  const filtered = filter === 'all' ? images : images.filter(img => img.issues.includes(filter));

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty">No images match this filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(img => {
    const fname    = img.src.split('/').pop().split('?')[0] || img.src;
    const short    = fname.length > 35 ? fname.slice(0,35)+'…' : fname;
    const dimStr   = img.naturalWidth && img.naturalHeight ? `${img.naturalWidth}×${img.naturalHeight}px` : '—';
    const dispStr  = img.displayWidth ? `display: ${img.displayWidth}px` : '';
    const sizeStr  = img.sizeKb > 0 ? `${img.sizeKb} KB` : '—';
    const fmtStr   = img.isModern ? '<span style="color:var(--green)">WebP/AVIF</span>' : '<span style="color:var(--muted)">JPEG/PNG</span>';
    const issueTags = img.issues.map(i => `<span class="issue-tag ${i}">${i.replace('-',' ')}</span>`).join('');
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:9px">
        <img class="img-thumb" src="${escHtml(img.src)}" alt="" onerror="this.style.display='none'">
        <div><div title="${escHtml(img.src)}">${escHtml(short)}</div><div style="font-size:11px;color:var(--muted);font-family:var(--mono)">${escHtml(img.alt||'no alt')}</div></div>
      </div></td>
      <td style="font-family:var(--mono);font-size:12px"><div>${dimStr}</div><div style="font-size:10px;color:var(--muted)">${dispStr}</div></td>
      <td style="font-family:var(--mono);font-size:12px;color:${img.sizeKb>500?'var(--danger)':img.sizeKb>200?'var(--warn)':'var(--muted)'}">${sizeStr}</td>
      <td>${fmtStr}</td>
      <td>${issueTags||'<span style="color:var(--muted);font-size:12px">—</span>'}</td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════
   GHOST SCRIPTS TAB
══════════════════════════════════════════════════════ */
function initGhostScan() {
  const btn = document.getElementById('scan-ghost-code-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const loading = document.getElementById('ghost-loading');
    const logEl   = document.getElementById('ghost-log-mini');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scanning...';
    loading.style.display = 'block';
    logEl.textContent = '';
    document.getElementById('ghost-empty').style.display = 'none';
    document.getElementById('ghost-results').style.display = 'none';

    const es = new EventSource('/scan-ghost-code');

    es.addEventListener('log', e => {
      const d = JSON.parse(e.data);
      logEl.textContent += d.message + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    });

    es.addEventListener('ghostResult', e => {
      const data = JSON.parse(e.data);
      renderGhostResults(data);
    });

    es.addEventListener('scanComplete', () => { es.close(); done(); });
    es.addEventListener('scanError',   e => {
      const d = JSON.parse(e.data);
      logEl.textContent += `\nERROR: ${d.details}`;
      es.close(); done();
    });

    function done() {
      loading.style.display = 'none';
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-magnifying-glass"></i> Scan Now';
    }
  });
}

function renderGhostResults(data) {
  const { apps, ghostCount, totalWastedKb, theme } = data;
  const okCount = apps.length - ghostCount;

  document.getElementById('ghost-results').style.display = 'block';
  document.getElementById('ghost-count').textContent = ghostCount;
  document.getElementById('ghost-ok').textContent    = okCount;
  document.getElementById('ghost-wasted').textContent = totalWastedKb > 0 ? `${totalWastedKb} KB` : '0 KB';
  document.getElementById('ghost-theme').textContent = theme || '—';

  const alert = document.getElementById('ghost-alert');
  if (ghostCount > 0) {
    alert.style.display = 'flex';
    alert.innerHTML = `<i class="fas fa-triangle-exclamation"></i> <span>${ghostCount} ghost script${ghostCount>1?'s are':' is'} loading on your store from uninstalled apps — they slow your store for no benefit.</span>`;
  } else {
    alert.style.display = 'none';
  }

  const list = document.getElementById('ghost-list');
  if (!apps.length) {
    list.innerHTML = '<div class="empty-state" style="min-height:160px"><p class="empty-title">No scripts detected</p><p class="empty-sub">Your theme looks clean!</p></div>';
    return;
  }

  list.innerHTML = apps.map(app => {
    const isGhost = !app.isInstalled;
    const initials = app.name.split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase();
    const confidenceColor = isGhost ? 'var(--danger)' : 'var(--green)';
    const filesHtml = (app.files||[]).map(f=>`<span style="display:inline-block;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;margin:2px;font-size:10px;font-family:var(--mono);color:var(--muted)">${escHtml(f)}</span>`).join('');
    const wastedHtml = isGhost && app.wastedKb > 0 ? `<span style="font-size:10px;font-family:var(--mono);color:var(--danger);margin-left:8px">~${app.wastedKb} KB wasted</span>` : '';
    return `
    <div class="ghost-card ${isGhost?'is-ghost':'is-ok'}">
      <div class="ghost-card-header">
        ${app.icon ? `<img class="ghost-card-icon" src="${escHtml(app.icon)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
        <div class="ghost-card-icon-fb" style="${app.icon?'display:none':''}">${isGhost?'👻':'✓'}</div>
        <div class="ghost-card-body">
          <div class="ghost-card-name">${escHtml(app.name)} ${wastedHtml}</div>
          <div class="ghost-card-cat">${escHtml(app.category||'Unknown')} · Found in ${app.fileCount||1} file${(app.fileCount||1)>1?'s':''}</div>
          <div class="ghost-card-files" style="margin-top:4px">${filesHtml}</div>
          <div class="confidence-bar" style="margin-top:8px" title="${app.confidence}% ${isGhost?'ghost':'installed'} confidence">
            <div class="confidence-fill" style="width:${app.confidence}%;background:${confidenceColor}"></div>
          </div>
          <div style="font-size:10px;color:var(--muted);font-family:var(--mono);margin-top:3px">${app.confidence}% ${isGhost?'ghost':'installed'} confidence</div>
        </div>
        <div class="ghost-card-actions">
          <span class="ghost-badge ${isGhost?'active':'ok'}">${isGhost?'GHOST':'OK'}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════
   FONT OPTIMIZER TAB
══════════════════════════════════════════════════════ */
function initFontScan() {
  const btn = document.getElementById('runFontScan');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const url = document.getElementById('storeUrl').value.trim();
    if (!url) { alert('Enter a store URL at the top first.'); return; }
    const pwd = document.getElementById('protectedStore').checked ? document.getElementById('storePassword').value : '';

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scanning...';
    document.getElementById('font-scan-loading').style.display = 'block';
    document.getElementById('font-empty').style.display = 'none';
    document.getElementById('font-results').style.display = 'none';

    const logEl = document.getElementById('font-scan-log');
    const params = new URLSearchParams({ storeUrl: url });
    if (pwd) params.append('storePassword', pwd);
    const es = new EventSource(`/scan-fonts?${params}`);

    es.addEventListener('log', e => {
      logEl.textContent += JSON.parse(e.data).message + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    });

    es.addEventListener('fontResult', e => { renderFontResults(JSON.parse(e.data)); });
    es.addEventListener('scanComplete', () => { es.close(); done(); });
    es.addEventListener('scanError', e => {
      logEl.textContent += '\nERROR: ' + JSON.parse(e.data).details;
      es.close(); done();
    });

    function done() {
      document.getElementById('font-scan-loading').style.display = 'none';
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-rotate"></i> Re-scan';
    }
  });
}

function renderFontResults(data) {
  document.getElementById('font-results').style.display = 'block';
  document.getElementById('font-empty').style.display = 'none';

  const grade = data.grade || 'D';
  const gradeEl = document.getElementById('font-grade-circle');
  gradeEl.className = `img-grade-circle grade-${grade.toLowerCase()}`;
  document.getElementById('font-grade-letter').textContent = grade;
  document.getElementById('font-score-number').textContent = data.score;

  document.getElementById('fstat-total').textContent  = data.totalFonts;
  document.getElementById('fstat-google').textContent = data.googleFonts;
  document.getElementById('fstat-self').textContent   = data.selfHosted;
  document.getElementById('fstat-issues').textContent = data.issues;
  document.getElementById('fstat-size').textContent   = `${data.totalSizeKb}`;

  const issueEl = document.getElementById('font-issues-list');
  if (data.issueList?.length) {
    const severityIcon = { error:'🔴', warn:'🟡', info:'🔵' };
    issueEl.innerHTML = data.issueList.map(issue => `
      <div class="img-issue-row" style="align-items:flex-start;gap:8px">
        <span>${severityIcon[issue.severity]||'⚪'} ${escHtml(issue.message)}</span>
      </div>`).join('');
  } else {
    issueEl.innerHTML = '<div style="color:var(--green);font-size:13px;padding:8px 0">✅ No issues found!</div>';
  }

  const recEl = document.getElementById('font-recommendations');
  if (data.recommendations?.length) {
    recEl.innerHTML = data.recommendations.map((r,i) => `
      <div class="tip-box" style="margin-bottom:8px"><span>💡</span><span>${escHtml(r)}</span></div>`).join('');
  } else {
    recEl.innerHTML = '<div style="color:var(--green);font-size:13px;padding:8px 0">✅ Fonts are well optimised!</div>';
  }

  const fTbody = document.getElementById('font-files-tbody');
  if (data.fontFiles?.length) {
    fTbody.innerHTML = data.fontFiles.map(f => {
      const shortUrl = f.url.length > 55 ? '…' + f.url.slice(-55) : f.url;
      const fmtColor = f.format === 'woff2' ? 'var(--green)' : 'var(--warn)';
      const src = f.isGoogleFont
        ? '<span style="color:var(--warn);font-family:var(--mono);font-size:11px">Google CDN</span>'
        : '<span style="color:var(--green);font-family:var(--mono);font-size:11px">Self-hosted</span>';
      return `<tr>
        <td style="font-family:var(--mono);font-size:11px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(f.url)}">${escHtml(shortUrl)}</td>
        <td style="font-family:var(--mono);font-size:12px;color:${fmtColor}">${f.format?.toUpperCase()||'—'}</td>
        <td style="font-family:var(--mono);font-size:12px;color:${f.sizeKb>60?'var(--warn)':'var(--muted)'}">${f.sizeKb > 0 ? f.sizeKb + ' KB' : '—'}</td>
        <td>${src}</td>
        <td style="font-family:var(--mono);font-size:11px;color:${f.status===200?'var(--green)':'var(--danger)'}">${f.status}</td>
      </tr>`;
    }).join('');
  } else {
    fTbody.innerHTML = '<tr><td colspan="5" class="table-empty">No font files detected.</td></tr>';
  }

  const ffTbody = document.getElementById('font-faces-tbody');
  if (data.fonts?.length) {
    ffTbody.innerHTML = data.fonts.map(f => `<tr>
      <td style="font-family:'${escHtml(f.family)}',sans-serif">${escHtml(f.family)}</td>
      <td style="font-family:var(--mono);font-size:12px">${escHtml(f.weight||'—')}</td>
      <td style="font-family:var(--mono);font-size:12px">${escHtml(f.style||'normal')}</td>
      <td><span style="font-size:10px;font-family:var(--mono);padding:2px 7px;border-radius:4px;background:${f.status==='loaded'?'var(--green-bg)':'var(--warn-bg)'};color:${f.status==='loaded'?'var(--green)':'var(--warn)'}">${f.status}</span></td>
    </tr>`).join('');
  } else {
    ffTbody.innerHTML = '<tr><td colspan="4" class="table-empty">No font faces detected.</td></tr>';
  }
}

/* ══════════════════════════════════════════════════════
   CSS ANALYSIS TAB
══════════════════════════════════════════════════════ */
function initCssScan() {
  const btn = document.getElementById('runCssScan');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const url = document.getElementById('storeUrl').value.trim();
    if (!url) { alert('Enter a store URL at the top first.'); return; }
    const pwd = document.getElementById('protectedStore').checked ? document.getElementById('storePassword').value : '';

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Analysing...';
    document.getElementById('css-scan-loading').style.display = 'block';
    document.getElementById('css-empty').style.display = 'none';
    document.getElementById('css-results').style.display = 'none';
    document.getElementById('css-topbar-metrics').style.display = 'none';

    const logEl = document.getElementById('css-scan-log');
    const params = new URLSearchParams({ storeUrl: url });
    if (pwd) params.append('storePassword', pwd);
    const es = new EventSource(`/scan-css?${params}`);

    es.addEventListener('log', e => {
      logEl.textContent += JSON.parse(e.data).message + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    });
    es.addEventListener('cssResult', e => { renderCssResults(JSON.parse(e.data)); });
    es.addEventListener('scanComplete', () => { es.close(); done(); });
    es.addEventListener('scanError', e => {
      logEl.textContent += '\nERROR: ' + JSON.parse(e.data).details;
      es.close(); done();
    });

    function done() {
      document.getElementById('css-scan-loading').style.display = 'none';
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-rotate"></i> Re-analyse';
    }
  });
}

function renderCssResults(data) {
  document.getElementById('css-results').style.display = 'block';
  document.getElementById('css-empty').style.display = 'none';

  document.getElementById('css-topbar-metrics').style.display = 'block';
  document.getElementById('css-bar-size').textContent   = `${data.totalSizeKb} KB`;
  document.getElementById('css-bar-rules').textContent  = data.totalRules.toLocaleString();
  document.getElementById('css-bar-unused').textContent = `${data.unusedPct}%`;
  document.getElementById('css-bar-savings').textContent = `${data.potentialSaveKb} KB`;

  const grade = data.grade || 'D';
  const gradeEl = document.getElementById('css-grade-circle');
  gradeEl.className = `img-grade-circle grade-${grade.toLowerCase()}`;
  document.getElementById('css-grade-letter').textContent = grade;
  document.getElementById('css-score-number').textContent = data.score;

  document.getElementById('css-stat-size').textContent    = `${data.totalSizeKb} KB`;
  document.getElementById('css-stat-rules').textContent   = data.totalRules.toLocaleString();
  const unusedEl = document.getElementById('css-stat-unused');
  unusedEl.textContent = `${data.unusedPct}%`;
  unusedEl.className = data.unusedPct > 50 ? 'poor' : data.unusedPct > 30 ? 'warn' : 'good';
  unusedEl.style.fontFamily = 'var(--mono)'; unusedEl.style.fontSize = '26px'; unusedEl.style.fontWeight = '500'; unusedEl.style.marginTop = '8px';
  document.getElementById('css-stat-savings').textContent = `${data.potentialSaveKb} KB`;

  const usedPct = data.totalSizeKb > 0 ? Math.round((data.afterOptKb / data.totalSizeKb) * 100) : 100;
  document.getElementById('css-savings-bar').style.width = `${usedPct}%`;
  document.getElementById('css-current-size').textContent  = `${data.totalSizeKb} KB`;
  document.getElementById('css-after-size').textContent    = `~${data.afterOptKb} KB`;

  document.getElementById('css-blocking').textContent   = data.blockingSheets;
  document.getElementById('css-inline').textContent     = data.inlineStyles;
  document.getElementById('css-inline-size').textContent = `${data.inlineStyleSizeKb} KB`;

  const recEl = document.getElementById('css-recommendations');
  if (data.recommendations?.length) {
    recEl.innerHTML = data.recommendations.map(r => `
      <div class="tip-box" style="margin-bottom:8px"><span>💡</span><span>${escHtml(r)}</span></div>`).join('');
  } else {
    recEl.innerHTML = '<div style="color:var(--green);font-size:13px;padding:8px 0">✅ CSS looks well optimised!</div>';
  }

  const tbody = document.getElementById('css-files-tbody');
  if (data.files?.length) {
    tbody.innerHTML = data.files.map(f => {
      const unusedColor = f.unusedPct > 60 ? 'var(--danger)' : f.unusedPct > 30 ? 'var(--warn)' : 'var(--green)';
      return `<tr>
        <td style="font-family:var(--mono);font-size:11px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(f.url)}">${escHtml(f.fileName)}</td>
        <td style="font-family:var(--mono);font-size:12px">${f.sizeKb} KB</td>
        <td style="font-family:var(--mono);font-size:12px;color:var(--muted)">${f.rules}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:60px;height:5px;background:var(--border);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${f.unusedPct}%;background:${unusedColor};border-radius:3px"></div>
            </div>
            <span style="font-family:var(--mono);font-size:12px;color:${unusedColor}">${f.unusedPct}%</span>
          </div>
        </td>
        <td style="font-family:var(--mono);font-size:12px;color:var(--green)">${f.savingsKb} KB</td>
      </tr>`;
    }).join('');
  } else {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No CSS files detected.</td></tr>';
  }
}

/* ══════════════════════════════════════════════════════
   HISTORY TAB
══════════════════════════════════════════════════════ */
function renderHistory() {
  const history = JSON.parse(localStorage.getItem('appAuditorHistory') || '[]');
  const emptyEl  = document.getElementById('history-empty');
  const contentEl = document.getElementById('history-content');
  if (!history.length) { emptyEl.style.display='flex'; contentEl.style.display='none'; return; }
  emptyEl.style.display = 'none'; contentEl.style.display = 'block';

  const labels     = history.map(e => new Date(e.date).toLocaleDateString());
  const perfScores = history.map(e => e.performanceScore);
  const lcpData    = history.map(e => e.lcp);
  const tbtData    = history.map(e => e.tbt);
  const clsData    = history.map(e => e.cls);
  const avg        = arr => arr.reduce((a,b)=>a+b,0)/arr.length;

  const avgPerf = avg(perfScores).toFixed(0);
  document.getElementById('kpi-grid').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Scans run</div><div class="kpi-val">${history.length}</div></div>
    <div class="kpi-card"><div class="kpi-label">Avg performance</div><div class="kpi-val ${rateScore(avgPerf)}">${avgPerf}</div></div>
    <div class="kpi-card"><div class="kpi-label">Avg LCP</div><div class="kpi-val">${avg(lcpData).toFixed(2)}s</div></div>
    <div class="kpi-card"><div class="kpi-label">Avg TBT</div><div class="kpi-val">${avg(tbtData).toFixed(0)}ms</div></div>`;

  ['scoresChart','vitalsChart'].forEach(id => { const c=Chart.getChart(id); if(c) c.destroy(); });
  Chart.defaults.color = '#8892a4';
  Chart.defaults.borderColor = '#2a2f45';

  new Chart(document.getElementById('scoresChart'), {
    type:'line',
    data:{ labels, datasets:[{ label:'Performance Score', data:perfScores, borderColor:'#6d7cff', backgroundColor:'rgba(109,124,255,.1)', fill:true, tension:0.3, pointBackgroundColor:'#6d7cff' }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ labels:{ color:'#8892a4' } } }, scales:{ y:{ min:0, max:100, ticks:{ color:'#8892a4' } }, x:{ ticks:{ color:'#8892a4' } } } },
  });

  new Chart(document.getElementById('vitalsChart'), {
    type:'line',
    data:{ labels, datasets:[
      { label:'LCP (s)',  data:lcpData, borderColor:'#4ade80', tension:0.3, yAxisID:'yS',  pointBackgroundColor:'#4ade80' },
      { label:'TBT (ms)', data:tbtData, borderColor:'#f43f5e', tension:0.3, yAxisID:'yMs', pointBackgroundColor:'#f43f5e' },
      { label:'CLS',      data:clsData, borderColor:'#f59e0b', tension:0.3, yAxisID:'yS',  pointBackgroundColor:'#f59e0b' },
    ]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ labels:{ color:'#8892a4' } } },
      scales:{
        yS:  { type:'linear', position:'left',  beginAtZero:true, ticks:{ color:'#8892a4' } },
        yMs: { type:'linear', position:'right', beginAtZero:true, ticks:{ color:'#8892a4' }, grid:{ display:false } },
        x:   { ticks:{ color:'#8892a4' }, grid:{ display:false } },
      }},
  });

  document.getElementById('clearHistoryBtn').onclick = () => {
    if (!confirm('Delete all scan history?')) return;
    localStorage.removeItem('appAuditorHistory');
    renderHistory();
    renderSpeedHistory();
  };
}

/* ══════════════════════════════════════════════════════
   HISTORY PERSISTENCE
══════════════════════════════════════════════════════ */
function saveToHistory(perfReport) {
  try {
    const url    = document.getElementById('storeUrl').value.trim();
    const device = document.querySelector('.device-btn.active')?.dataset.device || 'desktop';
    const entry  = {
      url, device,
      date: new Date().toISOString(),
      performanceScore: parseInt(perfReport.metrics.performanceScore, 10),
      accessibilityScore: Math.round((perfReport.categories?.accessibility?.score||0)*100),
      bestPracticesScore: Math.round((perfReport.categories?.['best-practices']?.score||0)*100),
      seoScore: Math.round((perfReport.categories?.seo?.score||0)*100),
      lcp: parseMetricValue(perfReport.metrics.lcp),
      tbt: parseMetricValue(perfReport.metrics.tbt),
      cls: parseMetricValue(perfReport.metrics.cls),
    };
    const hist = JSON.parse(localStorage.getItem('appAuditorHistory') || '[]');
    hist.push(entry);
    localStorage.setItem('appAuditorHistory', JSON.stringify(hist));
  } catch (e) { console.error('History save failed:', e); }
}

/* ══════════════════════════════════════════════════════
   UI STATE
══════════════════════════════════════════════════════ */
function showLoading() {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('.tab[data-tab="overview"]').classList.add('active');
  document.getElementById('tab-overview').classList.add('active');
  elLog.innerHTML = '';
  elLoadingMsg.textContent = 'Connecting to server...';
  elSpinnerContainer.querySelector('.spinner').style.display = '';
  elLoading.style.display = 'flex';
  elAppShell.style.display = 'none';
  elError.style.display   = 'none';
}
function hideLoading() { elLoading.style.display = 'none'; }
function showError(msg) { elError.style.display = 'flex'; elErrorMsg.textContent = msg; }
function logMsg(message, type = 'info') {
  const line = document.createElement('span');
  line.className = `log-line log-${type}`;
  line.textContent = message;
  elLog.appendChild(line);
  elLog.parentElement.scrollTop = elLog.parentElement.scrollHeight;
  if (message.startsWith('[+]')||message.startsWith('[System]'))
    elLoadingMsg.textContent = message.replace(/^\[.*?\]\s*/,'').slice(0,60);
}

/* ══════════════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════════════ */
let toastTimer;
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    let toast = document.getElementById('copy-toast');
    if (!toast) { toast=document.createElement('div'); toast.id='copy-toast'; toast.className='copy-toast'; document.body.appendChild(toast); }
    toast.textContent = 'Copied!'; toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
  });
}
window.toggleAudit = toggleAudit;
window.copyText    = copyText;

/* ══════════════════════════════════════════════════════
   RESTORE LAST SCAN
══════════════════════════════════════════════════════ */
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
    renderSpeedHistory();
  } catch {}
}

/* ══════════════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════════════ */
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
  initSpeedAudit();
  initImageScan();
  initGhostScan();
  initFontScan();
  initCssScan();
  tryRestoreLastScan();
});
