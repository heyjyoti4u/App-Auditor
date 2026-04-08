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

/* ── GLOBAL STATE ─────────────────────────────────────── */
let scanState = { runPerfScan:false, runAppScan:false, appReport:null, perfReport:null, hasError:false };
let currentSort = 'impact', currentCatFilter = 'all', hasFinalized = false;
let elLog, elLoadingMsg, elSpinnerContainer, elLoading, elError, elErrorMsg, elAppShell;
let allImageData = [];

// Boot context — filled by /init, NEVER typed by user
const ctx = { storeUrl: '', hasToken: false, storePassword: '' };

/* ══════════════════════════════════════════════════════
   BOOT
   FIX 1: Read shop from __SHOPIFY_CONTEXT__ (injected by server)
           NOT from window.location.search (unreliable in iframe)
   FIX 2: Skip storefront password check if hasToken=true
           Admin API scan does NOT visit storefront
══════════════════════════════════════════════════════ */
async function boot() {
  const overlay     = document.getElementById('boot-overlay');
  const statusEl    = document.getElementById('boot-status');
  const statusTxtEl = document.getElementById('boot-status-text');
  const storeNameEl = document.getElementById('boot-store-name');
  const pwdSection  = document.getElementById('pwd-section');
  const errSection  = document.getElementById('error-section');
  const errText     = document.getElementById('error-text');

  const setStatus = (msg, cls = '') => {
    statusEl.className   = 'boot-status' + (cls ? ' ' + cls : '');
    statusTxtEl.textContent = msg;
  };

  const showErr = (msg) => {
    errSection.style.display = 'block';
    errText.textContent      = msg;
    statusEl.style.display   = 'none';
    storeNameEl.style.color  = 'var(--danger)';
    storeNameEl.textContent  = 'Setup Required';
  };

  try {
    // ── FIX 1: Read shop from server-injected context FIRST ──────
    // __SHOPIFY_CONTEXT__ is injected into <head> by server.js '/' route
    // This is the ONLY reliable way to get shop inside a Shopify iframe
    const shopFromCtx = window.__SHOPIFY_CONTEXT__?.shop || '';

    // Fallback to URL params (works when accessed directly, not via iframe)
    const urlParams   = new URLSearchParams(window.location.search);
    const shopParam   = shopFromCtx || urlParams.get('shop') || '';

    console.log('[Boot] shopFromCtx:', shopFromCtx, '| shopFromURL:', urlParams.get('shop'));

    const initUrl = shopParam
      ? `/init?shop=${encodeURIComponent(shopParam)}`
      : '/init';

    setStatus('Connecting to Shopify...', '');

    const initRes  = await fetch(initUrl);
    const initData = await initRes.json();

    ctx.storeUrl  = initData.storeUrl  || '';
    ctx.hasToken  = initData.hasToken  || false;

    console.log('[Boot] storeUrl:', ctx.storeUrl, '| hasToken:', ctx.hasToken, '| source:', initData.tokenSource);

    if (!ctx.storeUrl) {
      showErr('Store URL not detected. Make sure the app is installed via OAuth or set SHOPIFY_STORE_URL in .env');
      return;
    }

    const displayUrl = ctx.storeUrl.replace('https://', '');
    storeNameEl.textContent = displayUrl;
    document.getElementById('topbar-store-text').textContent = displayUrl;
    document.getElementById('storeUrl').value = ctx.storeUrl;

    // ── FIX 2: Only check storefront password if NO OAuth token ──
    // hasToken=true → Admin API scan → does NOT visit storefront → no password needed
    // hasToken=false → Puppeteer scan → visits storefront → may need password
    if (!ctx.hasToken) {
      setStatus('Checking store access...', '');
      let isProtected = false;
      try {
        const pwdRes  = await fetch(`/check-password?storeUrl=${encodeURIComponent(ctx.storeUrl)}`);
        const pwdData = await pwdRes.json();
        isProtected   = pwdData.protected || false;
      } catch {}

      if (isProtected) {
        setStatus('Password protected store detected', 'warn');
        pwdSection.style.display = 'block';

        await new Promise(resolve => {
          const input  = document.getElementById('pwd-input');
          const submit = document.getElementById('pwd-submit');
          const go = () => {
            const pwd = input.value.trim();
            if (!pwd) { input.style.borderColor = 'var(--danger)'; return; }
            ctx.storePassword = pwd;
            document.getElementById('storePassword').value = pwd;
            pwdSection.style.display = 'none';
            resolve();
          };
          submit.addEventListener('click', go);
          input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
        });
      }

      setStatus('Using Puppeteer scan (no Admin Token)', 'warn');
    } else {
      setStatus('Admin API connected ✓', 'green');
    }

    // ── Show "Start Scan" button, wait for click ─────────────────
    setStatus(ctx.hasToken ? 'Admin API connected ✓ — ready to scan' : 'Ready — click to start', ctx.hasToken ? 'green' : 'warn');

    const scanBtnWrap   = document.getElementById('scan-btn-wrap');
    const scanBtn       = document.getElementById('boot-scan-btn');
    const countdownEl   = document.getElementById('countdown-num');
    const subText       = document.getElementById('boot-sub-text');

    if (scanBtnWrap) {
      scanBtnWrap.style.display = 'block';
      if (subText) subText.textContent = ctx.hasToken
        ? 'Store detected via Shopify Admin API'
        : 'No Admin Token — will use Puppeteer scan';
    }

    // Wait for button click (no auto-start)
    await new Promise(resolve => {
      if (scanBtn) {
        scanBtn.addEventListener('click', () => {
          if (scanBtnWrap) scanBtnWrap.style.display = 'none';
          resolve();
        }, { once: true });
      } else {
        // Fallback if HTML doesn't have the button
        resolve();
      }
    });

    setStatus('Starting scan...', '');
    await startScan();

  } catch (err) {
    console.error('[Boot]', err);
    showErr('Boot failed: ' + err.message);
  }
}

/* ══════════════════════════════════════════════════════
   ENSURE STORE PASSWORD
   Called by individual Puppeteer scans (speed/images/fonts/css)
   when the store might be password protected.
   Shows a small inline prompt if password not already set.
══════════════════════════════════════════════════════ */
async function ensureStorePassword() {
  if (ctx.storePassword) return true; // Already have it

  // Quick check if protected
  try {
    const pwdRes  = await fetch(`/check-password?storeUrl=${encodeURIComponent(ctx.storeUrl)}`);
    const pwdData = await pwdRes.json();
    if (!pwdData.protected) return true; // Not protected, no password needed
  } catch { return true; } // Assume not protected on error

  // Store IS protected — show a modal-like prompt
  return new Promise(resolve => {
    // Create temporary password modal
    const modal = document.createElement('div');
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998;
      display:flex;align-items:center;justify-content:center;
    `;
    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px 28px;max-width:360px;width:100%;margin:0 16px">
        <div style="font-size:13px;color:var(--warn);margin-bottom:8px;display:flex;align-items:center;gap:6px">
          <i class="fas fa-lock"></i> Password Protected Store
        </div>
        <p style="font-size:12px;color:var(--muted);margin-bottom:14px;line-height:1.5">
          This scan visits your storefront. Enter the store password to continue.
        </p>
        <div style="display:flex;gap:8px">
          <input id="modal-pwd-input" class="url-input" type="password" placeholder="Store password" style="flex:1;width:auto">
          <button id="modal-pwd-submit" class="scan-btn" style="padding:7px 14px;flex-shrink:0">Continue</button>
        </div>
        <button id="modal-pwd-skip" style="margin-top:10px;font-size:11px;color:var(--muted);background:none;border:none;cursor:pointer;width:100%;text-align:center">
          Skip (scan may fail)
        </button>
      </div>`;
    document.body.appendChild(modal);

    const input  = modal.querySelector('#modal-pwd-input');
    const submit = modal.querySelector('#modal-pwd-submit');
    const skip   = modal.querySelector('#modal-pwd-skip');

    input.focus();

    const done = (pwd) => {
      if (pwd) {
        ctx.storePassword = pwd;
        document.getElementById('storePassword').value = pwd;
      }
      document.body.removeChild(modal);
      resolve(true);
    };

    submit.addEventListener('click', () => {
      const pwd = input.value.trim();
      if (!pwd) { input.style.borderColor = 'var(--danger)'; return; }
      done(pwd);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const pwd = input.value.trim(); if (pwd) done(pwd); }
    });
    skip.addEventListener('click', () => done(''));
  });
}

/* ══════════════════════════════════════════════════════
   START SCAN
══════════════════════════════════════════════════════ */
async function startScan() {
  hasFinalized = false;
  scanState = {
    runPerfScan: document.getElementById('togglePerformance')?.checked ?? true,
    runAppScan:  document.getElementById('toggleApps')?.checked ?? true,
    appReport: null, perfReport: null, hasError: false,
  };

  elLog.innerHTML = '';
  elLoadingMsg.textContent = 'Starting...';
  elLoading.style.display  = 'flex';
  elAppShell.style.display = 'none';
  elError.style.display    = 'none';

  if (ctx.hasToken) {
    await runApiScan();
  } else {
    await runPuppeteerScan();
  }
}

/* ══════════════════════════════════════════════════════
   API SCAN — Admin API apps + Lighthouse in parallel
══════════════════════════════════════════════════════ */
function runApiScan() {
  return new Promise(resolve => {
    logMsg('[System] Using Shopify Admin API for accurate app detection...', 'success');

    let appDone  = !scanState.runAppScan;
    let perfDone = !scanState.runPerfScan;
    const done   = () => { if (appDone && perfDone) resolve(); };

    if (scanState.runAppScan) {
      const params = new URLSearchParams({ storeUrl: ctx.storeUrl });
      // No storePassword here — Admin API scan does not visit storefront
      const es = new EventSource(`/scan-apps-api?${params}`);
      es.addEventListener('log',        e => { const d = JSON.parse(e.data); logMsg(d.message, d.type||'info'); });
      es.addEventListener('scanResult', e => { scanState.appReport = JSON.parse(e.data); logMsg('[System] ✅ App data from Admin API.', 'success'); });
      es.addEventListener('scanComplete', () => { es.close(); appDone = true; done(); });
      es.addEventListener('scanError', e => {
        const d = JSON.parse(e.data);
        if (d.needsReauth && d.authUrl) {
          // FIX: Show re-auth button instead of crashing
          logMsg('[ERROR] Token expired or invalid. Need to re-authenticate.', 'error');
          scanState.hasError = true;
          es.close(); appDone = true;
          // Inject re-auth prompt into the terminal
          const authLine = document.createElement('div');
          authLine.style.cssText = 'margin-top:12px;padding:10px 14px;background:rgba(244,63,94,.1);border:1px solid rgba(244,63,94,.25);border-radius:8px;font-size:12px;';
          authLine.innerHTML = `<span style="color:var(--danger)">⚠️ Admin token rejected by Shopify.</span><br>
            <a href="${d.authUrl}" style="color:var(--accent);font-family:var(--mono);font-size:11px;display:inline-block;margin-top:6px">
              🔑 Click here to re-authenticate the app →
            </a>`;
          elLog.appendChild(authLine);
          done();
        } else {
          logMsg('[ERROR] App API: ' + d.details, 'error');
          scanState.hasError = true; es.close(); appDone = true; done();
        }
      });
      es.onerror = () => { if (es.readyState !== EventSource.CLOSED) { es.close(); appDone = true; done(); } };
    }

    if (scanState.runPerfScan) {
      logMsg('[System] Starting Lighthouse performance scan...', 'info');
      const params = new URLSearchParams({ storeUrl: ctx.storeUrl, device: 'desktop' });
      if (ctx.storePassword) params.append('storePassword', ctx.storePassword);
      const es2 = new EventSource(`/scan-speed?${params}`);
      es2.addEventListener('log',         e => { const d = JSON.parse(e.data); logMsg(d.message, d.type||'info'); });
      es2.addEventListener('speedResult', e => { scanState.perfReport = JSON.parse(e.data); logMsg('[System] ✅ Performance report received.', 'success'); });
      es2.addEventListener('appPerfData', e => {
        const { apps: perfApps } = JSON.parse(e.data);
        if (scanState.appReport?.appBreakdown && perfApps?.length) {
          mergePerfIntoApps(scanState.appReport.appBreakdown, perfApps);
          logMsg(`[System] ✅ Perf data merged into ${perfApps.length} app(s).`, 'success');
        }
      });
      es2.addEventListener('scanComplete', () => { es2.close(); perfDone = true; done(); });
      es2.addEventListener('scanError',    e => { logMsg('[ERROR] Perf: ' + JSON.parse(e.data).details, 'error'); es2.close(); perfDone = true; done(); });
      es2.onerror = () => { if (es2.readyState !== EventSource.CLOSED) { es2.close(); perfDone = true; done(); } };
    }

    if (!scanState.runAppScan && !scanState.runPerfScan) resolve();
  }).then(finalizeScan);
}

/* ══════════════════════════════════════════════════════
   PUPPETEER SCAN — fallback when no OAuth token
══════════════════════════════════════════════════════ */
function runPuppeteerScan() {
  return new Promise(resolve => {
    logMsg('[System] No OAuth token — using Puppeteer scan.', 'info');
    const params = new URLSearchParams({
      storeUrl:    ctx.storeUrl,
      runAppScan:  String(scanState.runAppScan),
      runPerfScan: String(scanState.runPerfScan),
      device:      'desktop',
    });
    if (ctx.storePassword) params.append('storePassword', ctx.storePassword);

    const es = new EventSource(`/scan-all?${params}`);
    es.onopen = () => logMsg('Connection established.', 'info');
    es.addEventListener('log',        e => { const d = JSON.parse(e.data); logMsg(d.message, d.type||'info'); });
    es.addEventListener('scanResult', e => { scanState.appReport  = JSON.parse(e.data); });
    es.addEventListener('perfResult', e => { scanState.perfReport = JSON.parse(e.data); });
    es.addEventListener('scanComplete', () => { es.close(); resolve(); });
    es.addEventListener('scanError',    e => { logMsg('[ERROR] ' + JSON.parse(e.data).details, 'error'); scanState.hasError = true; es.close(); resolve(); });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      logMsg('Connection error.', 'error'); scanState.hasError = true; es.close(); resolve();
    };
  }).then(finalizeScan);
}

/* ══════════════════════════════════════════════════════
   MERGE PERF DATA INTO APP CARDS
══════════════════════════════════════════════════════ */
function mergePerfIntoApps(appBreakdown, perfApps) {
  const perfMap = new Map(perfApps.map(p => [p.name.toLowerCase(), p]));
  for (const app of appBreakdown) {
    const perf = perfMap.get(app.name.toLowerCase());
    if (!perf) continue;
    app.totalSizeKb        = perf.totalSizeKb;
    app.totalDurationMs    = perf.totalDurationMs;
    app.assets             = perf.assets || [];
    app.estimatedSavingsMs = perf.estimatedSavingsMs;
    if (perf.totalSizeKb > 400 || perf.totalDurationMs > 1200) app.impact = 'High';
    else if ((perf.totalSizeKb > 150 || perf.totalDurationMs > 500) && app.impact === 'Low') app.impact = 'Medium';
  }
  if (scanState.appReport?.executiveSummary) {
    const totalKb = appBreakdown.reduce((s, a) => s + (a.totalSizeKb || 0), 0);
    scanState.appReport.executiveSummary.totalAppSizeMb = +(totalKb / 1024).toFixed(2);
    scanState.appReport.executiveSummary.highImpactApps = appBreakdown.filter(a => a.impact === 'High').length;
  }
}

/* ══════════════════════════════════════════════════════
   FINALIZE
══════════════════════════════════════════════════════ */
function finalizeScan() {
  if (hasFinalized) return;
  hasFinalized = true;

  const overlay = document.getElementById('boot-overlay');
  overlay.style.transition = 'opacity .3s';
  overlay.style.opacity    = '0';
  setTimeout(() => { overlay.style.display = 'none'; }, 320);

  document.getElementById('main-topbar').style.display      = 'flex';
  document.getElementById('main-options-bar').style.display = 'flex';

  if (scanState.hasError && !scanState.appReport && !scanState.perfReport) {
    hideLoading(); showError('Scan failed. Check the log for details.'); return;
  }

  if (scanState.runPerfScan && scanState.perfReport?.metrics) saveToHistory(scanState.perfReport);

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
  }, 400);
}

/* ══════════════════════════════════════════════════════
   RE-SCAN BUTTON
══════════════════════════════════════════════════════ */
function initRescanButton() {
  const btn = document.getElementById('rescanButton');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    hasFinalized = false;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:11px;height:11px;border-width:2px"></span>';
    elLog.innerHTML = '';
    elLoadingMsg.textContent = 'Reconnecting...';
    elSpinnerContainer.querySelector('.spinner').style.display = '';
    elLoading.style.display  = 'flex';
    elAppShell.style.display = 'none';
    await startScan();
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-rotate"></i> Re-scan';
  });
}

/* ══════════════════════════════════════════════════════
   TABS
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

function initStoreTypeToggle() {} // Legacy stub

/* ══════════════════════════════════════════════════════
   OVERVIEW TAB
══════════════════════════════════════════════════════ */
function renderOverview() {
  const { appReport, perfReport } = scanState;
  if (!appReport) return;

  document.getElementById('overview-empty').style.display   = 'none';
  document.getElementById('overview-results').style.display = 'block';
  document.getElementById('results-store-url').textContent  = ctx.storeUrl.replace('https://', '');

  if (perfReport?.metrics?.performanceScore != null) updateScoreRing(parseInt(perfReport.metrics.performanceScore, 10));
  if (perfReport?.metrics) renderVitals(perfReport.metrics);

  const e         = appReport.executiveSummary || {};
  const isApiScan = appReport.source === 'shopify_admin_api';
  const sourceTag = isApiScan
    ? ' <span style="font-size:10px;background:rgba(74,222,128,.15);color:var(--green);border:1px solid rgba(74,222,128,.3);padding:1px 6px;border-radius:4px;font-family:var(--mono)">✓ Admin API</span>'
    : '';
  const hasPerfData = appReport.appBreakdown?.some(a => a.totalSizeKb > 0 || a.totalDurationMs > 0);
  const metaText = isApiScan
    ? `${e.totalAppsDetected || 0} apps${hasPerfData ? ` · ${e.totalAppSizeMb || 0} MB` : ''}`
    : `${e.totalAppsDetected || 0} apps · ${e.totalAppSizeMb || 0} MB · ${e.totalRequests || 0} requests`;

  document.getElementById('results-meta').innerHTML = metaText + sourceTag;

  const banner   = document.getElementById('insight-banner');
  const insights = [];
  if (e.highImpactApps > 0) insights.push(`🚨 ${e.highImpactApps} high-impact app${e.highImpactApps > 1 ? 's' : ''}`);
  if (!isApiScan && e.totalRequests > 80) insights.push(`⚠️ ${e.totalRequests} requests`);
  if (!isApiScan && e.totalAppSizeMb > 1) insights.push(`⚠️ ${e.totalAppSizeMb} MB footprint`);
  if (perfReport?.metrics?.performanceScore < 50) insights.push('🚨 Poor performance score');
  if (isApiScan) insights.push('✅ 100% accurate app list from Shopify Admin API');
  if (insights.length) { banner.style.display = 'flex'; banner.innerHTML = insights.map(i => `<span>${i}</span>`).join(''); }
  else banner.style.display = 'none';

  if (appReport.appBreakdown?.length) reRenderCatBlocks(appReport);
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
  const el   = document.getElementById('vitals-list');
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
  Object.entries(grouped).sort((a, b) => b[1].length - a[1].length).forEach(([cat, apps]) => {
    const btn = document.createElement('button');
    btn.className = 'cat-nav-item'; btn.dataset.cat = cat;
    btn.innerHTML = `<span class="cat-left"><span class="cat-dot"></span>${escHtml(cat)}</span><span class="cat-count">${apps.length}</span>`;
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
    currentSort === 'size'   ? (b.totalSizeKb||0) - (a.totalSizeKb||0) :
    currentSort === 'time'   ? (b.totalDurationMs||0) - (a.totalDurationMs||0) :
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
  const catOrder  = Object.entries(grouped).sort((a, b) => {
    const score = apps => apps.filter(a => a.impact === 'High').length * 3 + apps.filter(a => a.impact === 'Medium').length;
    return score(b[1]) - score(a[1]);
  });
  const isApiScan = appReport.source === 'shopify_admin_api';
  container.innerHTML = '';
  catOrder.forEach(([cat, apps]) => {
    const sorted    = sortApps(apps);
    const totalKb   = apps.reduce((s, a) => s + (a.totalSizeKb||0), 0).toFixed(0);
    const highCount = apps.filter(a => a.impact === 'High').length;
    const medCount  = apps.filter(a => a.impact === 'Medium').length;
    const [label, color, pct] = highCount > 0
      ? ['HIGH impact','var(--danger)',Math.min(100,60+highCount*20)]
      : medCount > 0
      ? ['MED impact','var(--warn)',Math.min(60,30+medCount*15)]
      : ['LOW impact','var(--green)',12];
    const sizeLabel = +totalKb > 0 ? `${totalKb} KB` : `${apps.length} app${apps.length>1?'s':''}`;

    const block = document.createElement('div');
    block.className = 'cat-block'; block.dataset.cat = cat;
    block.innerHTML = `
      <div class="cat-header">
        <div class="cat-header-left">
          <span class="cat-emoji">${CATEGORY_EMOJI[cat]||'📦'}</span>
          <span class="cat-name">${escHtml(cat)}</span>
          <span class="cat-badge">${apps.length} app${apps.length>1?'s':''}</span>
        </div>
        <span class="cat-stat" style="color:${color}">${label}</span>
        <div class="cat-impact-col">
          <div class="cat-bar-wrap"><div class="cat-bar-fill" style="width:${pct}%;background:${color}"></div></div>
          <div class="cat-bar-label">${sizeLabel}</div>
        </div>
        <span class="cat-chevron open">▶</span>
      </div>
      <div class="app-list" data-list>${sorted.map(app => buildAppRow(app, isApiScan)).join('')}</div>`;

    block.querySelector('.cat-header').addEventListener('click', () => {
      const list = block.querySelector('[data-list]'), chev = block.querySelector('.cat-chevron'), open = chev.classList.contains('open');
      list.style.display = open ? 'none' : ''; chev.classList.toggle('open', !open);
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
  const initials = app.name.split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase();
  const pill = app.impact==='High' ? '<span class="impact-pill high">HIGH</span>'
             : app.impact==='Medium' ? '<span class="impact-pill medium">MED</span>'
             : '<span class="impact-pill low">LOW</span>';
  const hasPerfData = (app.totalSizeKb||0) > 0 || (app.totalDurationMs||0) > 0;

  let metricsHtml = '';
  if (hasPerfData) {
    const sc = app.totalSizeKb>400?'red':app.totalSizeKb>150?'warn':'good';
    const tc = app.totalDurationMs>1200?'red':app.totalDurationMs>500?'warn':'good';
    metricsHtml = `<span class="app-mono ${sc}">${(app.totalSizeKb||0).toFixed(1)} KB</span><span class="app-mono ${tc}">${Math.round(app.totalDurationMs||0)} ms</span>`;
  } else if (isApiScan) {
    metricsHtml = `<span class="app-mono" style="font-size:11px;color:var(--muted);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(app.developer||'')}</span><span class="app-mono" style="color:var(--muted)">—</span>`;
  } else {
    metricsHtml = `<span class="app-mono">0 KB</span><span class="app-mono">0 ms</span>`;
  }

  const tbtMs = (scanState.perfReport?.culprits?.identified||[]).find(c=>c.appName===app.name)?.duration || 0;
  const assetRows = (app.assets||[]).map(a => {
    const fname=(a.url||'').split('/').pop().split('?')[0]||a.url, fl=a.sizeKb>50||a.durationMs>500;
    return `<tr><td title="${escHtml(a.url)}">${fname.length>50?fname.slice(0,50)+'…':escHtml(fname)}</td><td>${escHtml(a.type||'—')}</td><td class="${fl?'flagged':''}">${a.sizeKb} KB</td><td class="${fl?'flagged':''}">${Math.round(a.durationMs)} ms</td></tr>`;
  }).join('');

  const apiInfo = isApiScan && app.appStoreUrl
    ? `<div style="margin-bottom:10px"><a href="${escHtml(app.appStoreUrl)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent);text-decoration:none;font-family:var(--mono)">View on App Store ↗</a></div>` : '';
  const noAsset = isApiScan && !hasPerfData
    ? `<div style="display:flex;align-items:center;gap:8px;padding:10px;background:var(--surface2);border-radius:6px;margin-top:8px"><span>⚡</span><p style="font-size:12px;color:var(--muted);line-height:1.5">Run <strong style="color:var(--text)">Speed Audit</strong> to measure this app's real load impact.</p></div>` : '';

  return `
    <div class="app-row" data-app="${escHtml(app.name)}">
      ${app.icon?`<img class="app-icon" src="${escHtml(app.icon)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`:''}<span class="app-icon-fb" style="${app.icon?'display:none':''}">${escHtml(initials)}</span>
      <span class="app-name">${escHtml(app.name)}</span>
      ${metricsHtml}${pill}<span class="expand-arrow">▶</span>
    </div>
    <div class="detail-panel">
      ${apiInfo}
      ${app.recommendation?`<div class="tip-box"><span>💡</span><span>${escHtml(app.recommendation)}</span></div>`:''}
      ${assetRows?`<table class="asset-table"><thead><tr><th>File</th><th>Type</th><th>Size</th><th>Load time</th></tr></thead><tbody>${assetRows}</tbody></table>`:noAsset||'<p style="font-size:12px;color:var(--muted)">No asset details.</p>'}
      ${tbtMs>0?`<div class="tbt-savings">✂ Removing this app could save ~${Math.round(tbtMs)} ms of TBT</div>`:''}
      ${hasPerfData&&app.estimatedSavingsMs>0?`<div class="tbt-savings" style="margin-top:6px">⏱ Estimated savings: ~${app.estimatedSavingsMs} ms</div>`:''}
    </div>`;
}

function toggleAppRow(row, block) {
  const panel = row.nextElementSibling, isOpen = row.classList.contains('is-open');
  block.querySelectorAll('.app-row.is-open').forEach(r => { if(r!==row){r.classList.remove('is-open');r.nextElementSibling.classList.remove('open');} });
  row.classList.toggle('is-open', !isOpen); panel.classList.toggle('open', !isOpen);
}

function renderUnidentified(domains) {
  const el = document.getElementById('unidentified-section');
  if (!domains?.length) { el.innerHTML=''; return; }
  el.innerHTML = `<div class="info-card" style="margin-top:12px"><h3>⚠️ Unidentified Domains <span style="color:var(--warn);font-family:var(--mono)">(${domains.length})</span></h3><p style="font-size:12px;color:var(--muted);margin-bottom:9px">These didn't match any known app fingerprint.</p><ul class="info-card-list">${domains.map(d=>`<li><span>${escHtml(d)}</span><button class="copy-btn" onclick="copyText('${escHtml(d)}')">Copy</button></li>`).join('')}</ul></div>`;
}

function renderHeavyHitters(hitters) {
  const el = document.getElementById('heavy-hitters-section');
  if (!hitters?.length) { el.innerHTML=''; return; }
  el.innerHTML = `<div class="info-card" style="margin-top:10px"><h3>🔴 Heavy Unidentified Scripts <span style="color:var(--danger);font-family:var(--mono)">(${hitters.length})</span></h3><ul class="info-card-list">${[...hitters].sort((a,b)=>b.sizeKb-a.sizeKb).map(s=>{const short=s.url.length>70?'…'+s.url.slice(-70):s.url;return`<li><span title="${escHtml(s.url)}">${escHtml(short)}</span><span style="color:var(--danger);font-family:var(--mono);flex-shrink:0;margin-left:8px">${s.sizeKb} KB</span></li>`;}).join('')}</ul></div>`;
}

/* ══════════════════════════════════════════════════════
   PERFORMANCE TAB
══════════════════════════════════════════════════════ */
function renderPerformance() {
  const { perfReport } = scanState;
  const emptyEl = document.getElementById('perf-empty'), contentEl = document.getElementById('perf-content');
  if (!perfReport?.metrics) { emptyEl.style.display='flex'; contentEl.style.display='none'; return; }
  emptyEl.style.display='none'; contentEl.style.display='block';
  const m = perfReport.metrics, cats = perfReport.categories;
  const defs = [
    {key:'lcp',label:'LCP',good:2.5,avg:4.0,desc:'Largest Contentful Paint'},
    {key:'tbt',label:'TBT',good:200,avg:600,desc:'Total Blocking Time'},
    {key:'cls',label:'CLS',good:0.1,avg:0.25,desc:'Cumulative Layout Shift'},
    {key:'fcp',label:'FCP',good:1.8,avg:3.0,desc:'First Contentful Paint'},
    {key:'speedIndex',label:'Speed Index',good:3.4,avg:5.8,desc:'Visual population speed'},
  ];
  const catCards = cats ? Object.entries(cats).map(([,cat])=>{ if(!cat)return''; const score=Math.round(cat.score*100); return`<div class="metric-card"><div class="m-label">${escHtml(cat.title)}</div><div class="m-val ${rateScore(score)}">${score}</div></div>`;}).join('') : '';
  contentEl.innerHTML = `<p class="perf-section-title">Category Scores</p><div class="perf-grid">${catCards}</div><p class="perf-section-title">Core Web Vitals</p><div class="perf-grid">${defs.map(d=>{const raw=m[d.key]||'N/A',val=parseMetricValue(raw),cls=raw==='N/A'?'na':rateMetric(val,d.good,d.avg);return`<div class="metric-card"><div class="m-label">${d.label}</div><div class="m-val ${cls}">${raw}</div><div class="m-desc">${d.desc}</div></div>`;}).join('')}</div>${perfReport.culprits?buildCulpritsSection(perfReport.culprits):''}${perfReport.audits&&cats?buildAuditSection(perfReport.audits,cats):''}`;
}

function buildCulpritsSection(c) {
  if (!c.identified?.length && !c.unidentified?.length) return '';
  const rows=[...c.identified.map(x=>`<div class="audit-block"><div class="audit-head"><div class="audit-dot poor"></div><span class="audit-head-title">${escHtml(x.appName)}</span><span class="audit-head-val">${x.duration.toFixed(0)} ms CPU</span></div></div>`),...c.unidentified.map(x=>{let l=x.url;try{l=new URL(x.url).hostname;}catch{}return`<div class="audit-block"><div class="audit-head"><div class="audit-dot warn"></div><span class="audit-head-title" title="${escHtml(x.url)}">${escHtml(l)}</span><span class="audit-head-val">${x.duration.toFixed(0)} ms CPU</span></div></div>`;})].join('');
  return `<p class="perf-section-title">Main-Thread Culprits</p>${rows}`;
}

function buildAuditSection(audits, cats) {
  const allRefs = Object.values(cats).flatMap(c=>c?.auditRefs||[]);
  const failed  = [];
  allRefs.forEach(ref => {
    if (ref.group==='metrics') return;
    const audit = audits[ref.id];
    if (!audit||audit.score===1||audit.scoreDisplayMode==='notApplicable'||audit.details?.items?.length===0) return;
    failed.push(audit);
  });
  if (!failed.length) return '';
  return `<p class="perf-section-title">Failed Audits</p>${failed.map(audit=>{const dot=audit.score>=0.9?'good':audit.score>=0.5?'warn':'poor';const desc=(audit.description||'').replace(/\[.*?\]\(.*?\)/g,'').trim();return`<div class="audit-block"><div class="audit-head" onclick="toggleAudit(this)"><div class="audit-dot ${dot}"></div><span class="audit-head-title">${escHtml(audit.title)}</span><span class="audit-head-val">${audit.displayValue||''}</span><span class="audit-chevron">▶</span></div><div class="audit-body"><p>${escHtml(desc)}</p></div></div>`;}).join('')}`;
}

function toggleAudit(head) {
  const body=head.nextElementSibling,chev=head.querySelector('.audit-chevron'),open=chev.classList.contains('open');
  body.classList.toggle('open',!open);chev.classList.toggle('open',!open);
}

/* ══════════════════════════════════════════════════════
   SPEED AUDIT TAB
   FIX: ensureStorePassword() before launching Puppeteer
══════════════════════════════════════════════════════ */
function initSpeedAudit() {
  const btn = document.getElementById('runSpeedTest');
  if (!btn) return;

  document.querySelectorAll('.device-btn').forEach(b => {
    b.addEventListener('click', function(){ document.querySelectorAll('.device-btn').forEach(x=>x.classList.remove('active')); this.classList.add('active'); });
  });

  btn.addEventListener('click', async () => {
    if (!ctx.storeUrl) { alert('No store URL detected.'); return; }

    // FIX: Ask for store password before launching Puppeteer if needed
    await ensureStorePassword();

    const device = document.querySelector('.device-btn.active')?.dataset.device || 'mobile';
    btn.disabled=true; btn.innerHTML='<span class="spinner"></span> Running...';
    const loadingEl=document.getElementById('speed-test-loading'), logEl=document.getElementById('speed-test-log');
    loadingEl.style.display='block'; logEl.textContent='';

    const params=new URLSearchParams({storeUrl:ctx.storeUrl, device});
    if (ctx.storePassword) params.append('storePassword', ctx.storePassword);

    const es=new EventSource(`/scan-speed?${params}`);
    es.addEventListener('log', e=>{ logEl.textContent+=JSON.parse(e.data).message+'\n'; logEl.scrollTop=logEl.scrollHeight; });
    es.addEventListener('speedResult', e=>{
      const pr=JSON.parse(e.data);
      if(pr?.metrics){
        const entry={url:ctx.storeUrl,device,date:new Date().toISOString(),performanceScore:parseInt(pr.metrics.performanceScore,10),accessibilityScore:Math.round((pr.categories?.accessibility?.score||0)*100),bestPracticesScore:Math.round((pr.categories?.['best-practices']?.score||0)*100),seoScore:Math.round((pr.categories?.seo?.score||0)*100),lcp:parseMetricValue(pr.metrics.lcp),tbt:parseMetricValue(pr.metrics.tbt),cls:parseMetricValue(pr.metrics.cls)};
        const hist=JSON.parse(localStorage.getItem('appAuditorHistory')||'[]');hist.push(entry);localStorage.setItem('appAuditorHistory',JSON.stringify(hist));
      }
      renderSpeedResult(pr);
    });
    es.addEventListener('appPerfData', e=>{
      const{apps:perfApps}=JSON.parse(e.data);
      if(scanState.appReport?.appBreakdown&&perfApps?.length){
        mergePerfIntoApps(scanState.appReport.appBreakdown,perfApps);
        if(document.getElementById('overview-results').style.display!=='none') renderOverview();
      }
    });
    es.addEventListener('scanComplete',()=>{ es.close(); done(); });
    es.addEventListener('scanError', e=>{ logEl.textContent+='\nERROR: '+JSON.parse(e.data).details; es.close(); done(); });
    es.onerror=()=>{ es.close(); done(); };
    function done(){loadingEl.style.display='none';btn.disabled=false;btn.innerHTML='<i class="fas fa-play"></i> Run Test';renderSpeedHistory();}
  });

  renderSpeedHistory();
}

function renderSpeedResult(perfReport) {
  const card=document.getElementById('speed-result-card'),content=document.getElementById('speed-result-content');
  if(!perfReport?.metrics)return;
  card.style.display='block';
  const m=perfReport.metrics,score=m.performanceScore,color=score>=90?'var(--green)':score>=50?'var(--warn)':'var(--danger)';
  const defs=[{key:'lcp',label:'LCP',good:2.5,avg:4.0},{key:'tbt',label:'TBT',good:200,avg:600},{key:'cls',label:'CLS',good:0.1,avg:0.25},{key:'fcp',label:'FCP',good:1.8,avg:3.0},{key:'speedIndex',label:'Speed Index',good:3.4,avg:5.8}];
  content.innerHTML=`<div style="display:flex;align-items:center;gap:20px;margin-bottom:16px;flex-wrap:wrap"><div style="text-align:center;flex-shrink:0"><div style="font-family:var(--mono);font-size:40px;font-weight:600;color:${color}">${score}</div><div style="font-size:11px;color:var(--muted)">Performance Score</div></div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;flex:1">${defs.map(d=>{const raw=m[d.key]||'N/A',cls=raw==='N/A'?'na':rateMetric(parseMetricValue(raw),d.good,d.avg);return`<div class="metric-card" style="padding:10px"><div class="m-label">${d.label}</div><div class="m-val ${cls}" style="font-size:16px">${raw}</div></div>`;}).join('')}</div></div><div style="font-size:11px;color:var(--muted);font-family:var(--mono)">Device: ${m.device} · ${new Date().toLocaleTimeString()}</div>`;
}

function renderSpeedHistory() {
  const tbody=document.getElementById('speedHistoryBody');
  if(!tbody)return;
  const history=JSON.parse(localStorage.getItem('appAuditorHistory')||'[]');
  if(!history.length){tbody.innerHTML='<tr><td colspan="7" class="table-empty">No tests run yet.</td></tr>';return;}
  tbody.innerHTML=[...history].reverse().slice(0,15).map(e=>{const color=e.performanceScore>=90?'var(--green)':e.performanceScore>=50?'var(--warn)':'var(--danger)';return`<tr><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(e.url||'')}">${escHtml(e.url||'—')}</td><td style="font-weight:600;color:${color};font-family:var(--mono);font-size:16px">${e.performanceScore}</td><td style="font-family:var(--mono)">${e.lcp}s</td><td style="font-family:var(--mono)">${e.tbt}ms</td><td style="font-family:var(--mono)">${e.cls}</td><td><span style="font-size:10px;background:var(--surface2);padding:2px 7px;border-radius:4px;font-family:var(--mono);text-transform:uppercase">${e.device||'desktop'}</span></td><td style="color:var(--muted)">${new Date(e.date).toLocaleDateString()}</td></tr>`;}).join('');
}

/* ══════════════════════════════════════════════════════
   IMAGE OPTIMIZER TAB
   FIX: ensureStorePassword() before launching Puppeteer
══════════════════════════════════════════════════════ */
function initImageScan() {
  const btn=document.getElementById('runImageScan');
  if(!btn)return;
  btn.addEventListener('click', async ()=>{
    if(!ctx.storeUrl){alert('No store URL.');return;}
    await ensureStorePassword();

    btn.disabled=true;btn.innerHTML='<span class="spinner"></span> Scanning...';
    document.getElementById('image-scan-loading').style.display='block';
    document.getElementById('image-empty').style.display='none';
    document.getElementById('image-results').style.display='none';
    const logEl=document.getElementById('image-scan-log');
    const params=new URLSearchParams({storeUrl:ctx.storeUrl});
    if(ctx.storePassword)params.append('storePassword',ctx.storePassword);
    const es=new EventSource(`/scan-images?${params}`);
    es.addEventListener('log',e=>{logEl.textContent+=JSON.parse(e.data).message+'\n';logEl.scrollTop=logEl.scrollHeight;});
    es.addEventListener('imageResult',e=>{renderImageResults(JSON.parse(e.data));es.close();done();});
    es.addEventListener('scanError',e=>{logEl.textContent+='\nERROR: '+JSON.parse(e.data).details;es.close();done();});
    es.onerror=()=>{es.close();done();};
    function done(){document.getElementById('image-scan-loading').style.display='none';btn.disabled=false;btn.innerHTML='<i class="fas fa-rotate"></i> Re-scan';}
  });
  document.getElementById('img-filter-pills')?.addEventListener('click',e=>{
    const pill=e.target.closest('.filter-pill');if(!pill)return;
    document.querySelectorAll('.filter-pill').forEach(p=>p.classList.remove('active'));
    pill.classList.add('active');renderImageTable(allImageData,pill.dataset.filter);
  });
}

function renderImageResults(data){
  allImageData=data.images||[];
  document.getElementById('image-results').style.display='block';
  document.getElementById('image-empty').style.display='none';
  const grade=data.scoreGrade||'D',gradeEl=document.getElementById('img-grade-circle');
  gradeEl.className=`img-grade-circle grade-${grade.toLowerCase()}`;
  document.getElementById('img-grade-letter').textContent=grade;
  document.getElementById('img-score-number').textContent=data.score;
  document.getElementById('istat-total-val').textContent=data.totalImages;
  document.getElementById('istat-alt-val').textContent=data.missingAlt;
  document.getElementById('istat-oversized-val').textContent=data.oversized;
  document.getElementById('istat-large-val').textContent=data.largeFiles;
  document.getElementById('istat-format-val').textContent=data.nonModern;
  const savingsKb=data.potentialSavingsKb;
  document.getElementById('img-savings-val').textContent=savingsKb>=1000?`${(savingsKb/1024).toFixed(1)} MB`:`${savingsKb} KB`;
  document.getElementById('img-current-size').textContent=`${data.totalSizeMb} MB`;
  document.getElementById('img-after-size').textContent=`~${data.afterOptimizationMb} MB`;
  const pct=data.totalSizeMb>0?Math.min(100,Math.round((savingsKb/1024)/data.totalSizeMb*100)):0;
  document.getElementById('img-savings-bar').style.width=`${100-pct}%`;
  document.getElementById('img-issue-breakdown').innerHTML=[{label:'Missing alt text',count:data.missingAlt,color:'var(--danger)'},{label:'Oversized images',count:data.oversized,color:'var(--warn)'},{label:'Large files (>500KB)',count:data.largeFiles,color:'var(--warn)'},{label:'Non-modern format',count:data.nonModern,color:'var(--muted)'}].map(i=>`<div class="img-issue-row"><span>${i.label}</span><span class="img-issue-count" style="color:${i.color}">${i.count}</span></div>`).join('');
  if(data.apiProductCount>0){const extra=document.createElement('div');extra.style.cssText='font-size:11px;color:var(--green);font-family:var(--mono);margin-top:8px;padding:6px 10px;background:var(--green-bg);border-radius:6px;border:1px solid rgba(74,222,128,.2)';extra.textContent=`✓ Includes ${data.apiProductCount} product images from Admin API`;document.getElementById('img-issue-breakdown').after(extra);}
  renderImageTable(allImageData,'all');
}

function renderImageTable(images,filter){
  const tbody=document.getElementById('img-audit-tbody');
  const filtered=filter==='all'?images:images.filter(img=>img.issues.includes(filter));
  if(!filtered.length){tbody.innerHTML=`<tr><td colspan="5" class="table-empty">No images match this filter.</td></tr>`;return;}
  tbody.innerHTML=filtered.map(img=>{
    const fname=img.src.split('/').pop().split('?')[0]||img.src,short=fname.length>35?fname.slice(0,35)+'…':fname;
    const dimStr=img.naturalWidth&&img.naturalHeight?`${img.naturalWidth}×${img.naturalHeight}px`:'—';
    const dispStr=img.displayWidth?`display: ${img.displayWidth}px`:'';
    const sizeStr=img.sizeKb>0?`${img.sizeKb} KB`:'—';
    const fmtStr=img.isModern?'<span style="color:var(--green)">WebP/AVIF</span>':'<span style="color:var(--muted)">JPEG/PNG</span>';
    const issueTags=img.issues.map(i=>`<span class="issue-tag ${i}">${i.replace('-',' ')}</span>`).join('');
    const srcTag=img.fromApi?'<span style="font-size:9px;background:var(--green-bg);color:var(--green);border:1px solid rgba(74,222,128,.2);padding:1px 5px;border-radius:3px;font-family:var(--mono);margin-left:4px">API</span>':'';
    const pLabel=img.productTitle?`<div style="font-size:10px;color:var(--accent);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(img.productTitle)}</div>`:'';
    return`<tr><td><div style="display:flex;align-items:center;gap:9px"><img class="img-thumb" src="${escHtml(img.src)}" alt="" onerror="this.style.display='none'"><div style="min-width:0"><div title="${escHtml(img.src)}" style="display:flex;align-items:center">${escHtml(short)}${srcTag}</div>${pLabel}<div style="font-size:11px;color:var(--muted);font-family:var(--mono)">${escHtml(img.alt||'no alt')}</div></div></div></td><td style="font-family:var(--mono);font-size:12px"><div>${dimStr}</div><div style="font-size:10px;color:var(--muted)">${dispStr}</div></td><td style="font-family:var(--mono);font-size:12px;color:${img.sizeKb>500?'var(--danger)':img.sizeKb>200?'var(--warn)':'var(--muted)'}">${sizeStr}</td><td>${fmtStr}</td><td>${issueTags||'<span style="color:var(--muted);font-size:12px">—</span>'}</td></tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════
   GHOST SCRIPTS TAB
══════════════════════════════════════════════════════ */
function initGhostScan(){
  const btn=document.getElementById('scan-ghost-code-btn');
  if(!btn)return;
  btn.addEventListener('click',()=>{
    const loading=document.getElementById('ghost-loading'),logEl=document.getElementById('ghost-log-mini');
    btn.disabled=true;btn.innerHTML='<span class="spinner"></span> Scanning...';
    loading.style.display='block';logEl.textContent='';
    document.getElementById('ghost-empty').style.display='none';
    document.getElementById('ghost-results').style.display='none';
    // Ghost scan uses Admin API only — no storefront visit → no password needed
    const params=new URLSearchParams();
    if(ctx.storeUrl)params.append('storeUrl',ctx.storeUrl);
    const es=new EventSource(`/scan-ghost-code?${params}`);
    es.addEventListener('log',e=>{logEl.textContent+=JSON.parse(e.data).message+'\n';logEl.scrollTop=logEl.scrollHeight;});
    es.addEventListener('ghostResult',e=>{renderGhostResults(JSON.parse(e.data));});
    es.addEventListener('scanComplete',()=>{es.close();done();});
    es.addEventListener('scanError',e=>{logEl.textContent+='\nERROR: '+JSON.parse(e.data).details;es.close();done();});
    es.onerror=()=>{es.close();done();};
    function done(){loading.style.display='none';btn.disabled=false;btn.innerHTML='<i class="fas fa-magnifying-glass"></i> Scan Now';}
  });
}

function renderGhostResults(data){
  const{apps,ghostCount,totalWastedKb,theme}=data,okCount=(apps?.length||0)-ghostCount;
  document.getElementById('ghost-results').style.display='block';
  document.getElementById('ghost-count').textContent=ghostCount;
  document.getElementById('ghost-ok').textContent=okCount;
  document.getElementById('ghost-wasted').textContent=totalWastedKb>0?`${totalWastedKb} KB`:'0 KB';
  document.getElementById('ghost-theme').textContent=theme||'—';
  const alert=document.getElementById('ghost-alert');
  if(ghostCount>0){alert.style.display='flex';alert.innerHTML=`<i class="fas fa-triangle-exclamation"></i><span>${ghostCount} ghost script${ghostCount>1?'s are':' is'} loading from uninstalled apps.</span>`;}
  else alert.style.display='none';
  const list=document.getElementById('ghost-list');
  if(!apps?.length){list.innerHTML=`<div class="empty-state" style="min-height:120px"><p class="empty-title">No scripts detected</p><p class="empty-sub">Your theme looks clean!</p></div>`;return;}
  list.innerHTML=apps.map(app=>{
    const isGhost=!app.isInstalled,cc=isGhost?'var(--danger)':'var(--green)';
    const filesHtml=(app.files||[]).map(f=>`<span style="display:inline-block;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;margin:2px;font-size:10px;font-family:var(--mono);color:var(--muted)">${escHtml(f)}</span>`).join('');
    const wastedHtml=isGhost&&app.wastedKb>0?`<span style="font-size:10px;font-family:var(--mono);color:var(--danger);margin-left:8px">~${app.wastedKb} KB wasted</span>`:'';
    return`<div class="ghost-card ${isGhost?'is-ghost':'is-ok'}"><div class="ghost-card-header">${app.icon?`<img class="ghost-card-icon" src="${escHtml(app.icon)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`:''}<div class="ghost-card-icon-fb" style="${app.icon?'display:none':''}">${isGhost?'👻':'✓'}</div><div class="ghost-card-body"><div class="ghost-card-name">${escHtml(app.name)} ${wastedHtml}</div><div class="ghost-card-cat">${escHtml(app.category||'Unknown')} · Found in ${app.fileCount||1} file${(app.fileCount||1)>1?'s':''}</div><div class="ghost-card-files" style="margin-top:4px">${filesHtml}</div><div class="confidence-bar" style="margin-top:8px"><div class="confidence-fill" style="width:${app.confidence}%;background:${cc}"></div></div><div style="font-size:10px;color:var(--muted);font-family:var(--mono);margin-top:3px">${app.confidence}% ${isGhost?'ghost':'installed'} confidence</div></div><div class="ghost-card-actions"><span class="ghost-badge ${isGhost?'active':'ok'}">${isGhost?'GHOST':'OK'}</span></div></div></div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════
   FONT OPTIMIZER TAB
   FIX: ensureStorePassword() before launching Puppeteer
══════════════════════════════════════════════════════ */
function initFontScan(){
  const btn=document.getElementById('runFontScan');
  if(!btn)return;
  btn.addEventListener('click', async ()=>{
    if(!ctx.storeUrl){alert('No store URL.');return;}
    await ensureStorePassword();

    btn.disabled=true;btn.innerHTML='<span class="spinner"></span> Scanning...';
    document.getElementById('font-scan-loading').style.display='block';
    document.getElementById('font-empty').style.display='none';
    document.getElementById('font-results').style.display='none';
    const logEl=document.getElementById('font-scan-log');
    const params=new URLSearchParams({storeUrl:ctx.storeUrl});
    if(ctx.storePassword)params.append('storePassword',ctx.storePassword);
    const es=new EventSource(`/scan-fonts?${params}`);
    es.addEventListener('log',e=>{logEl.textContent+=JSON.parse(e.data).message+'\n';logEl.scrollTop=logEl.scrollHeight;});
    es.addEventListener('fontResult',e=>{renderFontResults(JSON.parse(e.data));});
    es.addEventListener('scanComplete',()=>{es.close();done();});
    es.addEventListener('scanError',e=>{logEl.textContent+='\nERROR: '+JSON.parse(e.data).details;es.close();done();});
    es.onerror=()=>{es.close();done();};
    function done(){document.getElementById('font-scan-loading').style.display='none';btn.disabled=false;btn.innerHTML='<i class="fas fa-rotate"></i> Re-scan';}
  });
}

function renderFontResults(data){
  document.getElementById('font-results').style.display='block';document.getElementById('font-empty').style.display='none';
  const grade=data.grade||'D',gradeEl=document.getElementById('font-grade-circle');
  gradeEl.className=`img-grade-circle grade-${grade.toLowerCase()}`;
  document.getElementById('font-grade-letter').textContent=grade;document.getElementById('font-score-number').textContent=data.score;
  document.getElementById('fstat-total').textContent=data.totalFonts;document.getElementById('fstat-google').textContent=data.googleFonts;
  document.getElementById('fstat-self').textContent=data.selfHosted;document.getElementById('fstat-issues').textContent=data.issues;document.getElementById('fstat-size').textContent=data.totalSizeKb;
  const sevIcon={error:'🔴',warn:'🟡',info:'🔵'};
  document.getElementById('font-issues-list').innerHTML=data.issueList?.length?data.issueList.map(i=>`<div class="img-issue-row" style="align-items:flex-start;gap:8px"><span>${sevIcon[i.severity]||'⚪'} ${escHtml(i.message)}</span></div>`).join(''):'<div style="color:var(--green);font-size:13px;padding:8px 0">✅ No issues found!</div>';
  document.getElementById('font-recommendations').innerHTML=data.recommendations?.length?data.recommendations.map(r=>`<div class="tip-box" style="margin-bottom:8px"><span>💡</span><span>${escHtml(r)}</span></div>`).join(''):'<div style="color:var(--green);font-size:13px;padding:8px 0">✅ Fonts are well optimised!</div>';
  const fTbody=document.getElementById('font-files-tbody');
  fTbody.innerHTML=data.fontFiles?.length?data.fontFiles.map(f=>{const su=f.url.length>55?'…'+f.url.slice(-55):f.url,fc=f.format==='woff2'?'var(--green)':'var(--warn)',src=f.isGoogleFont?'<span style="color:var(--warn);font-family:var(--mono);font-size:11px">Google CDN</span>':'<span style="color:var(--green);font-family:var(--mono);font-size:11px">Self-hosted</span>';return`<tr><td style="font-family:var(--mono);font-size:11px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(f.url)}">${escHtml(su)}</td><td style="font-family:var(--mono);font-size:12px;color:${fc}">${(f.format||'—').toUpperCase()}</td><td style="font-family:var(--mono);font-size:12px;color:${f.sizeKb>60?'var(--warn)':'var(--muted)'}">${f.sizeKb>0?f.sizeKb+' KB':'—'}</td><td>${src}</td><td style="font-family:var(--mono);font-size:11px;color:${f.status===200?'var(--green)':'var(--danger)'}">${f.status}</td></tr>`;}).join(''):'<tr><td colspan="5" class="table-empty">No font files detected.</td></tr>';
  const ffTbody=document.getElementById('font-faces-tbody');
  ffTbody.innerHTML=data.fonts?.length?data.fonts.map(f=>`<tr><td style="font-family:'${escHtml(f.family)}',sans-serif">${escHtml(f.family)}</td><td style="font-family:var(--mono);font-size:12px">${escHtml(f.weight||'—')}</td><td style="font-family:var(--mono);font-size:12px">${escHtml(f.style||'normal')}</td><td><span style="font-size:10px;font-family:var(--mono);padding:2px 7px;border-radius:4px;background:${f.status==='loaded'?'var(--green-bg)':'var(--warn-bg)'};color:${f.status==='loaded'?'var(--green)':'var(--warn)'}">${f.status}</span></td></tr>`).join(''):'<tr><td colspan="4" class="table-empty">No font faces detected.</td></tr>';
}

/* ══════════════════════════════════════════════════════
   CSS ANALYSIS TAB
   FIX: ensureStorePassword() before launching Puppeteer
══════════════════════════════════════════════════════ */
function initCssScan(){
  const btn=document.getElementById('runCssScan');
  if(!btn)return;
  btn.addEventListener('click', async ()=>{
    if(!ctx.storeUrl){alert('No store URL.');return;}
    await ensureStorePassword();

    btn.disabled=true;btn.innerHTML='<span class="spinner"></span> Analysing...';
    document.getElementById('css-scan-loading').style.display='block';
    document.getElementById('css-empty').style.display='none';
    document.getElementById('css-results').style.display='none';
    document.getElementById('css-topbar-metrics').style.display='none';
    const logEl=document.getElementById('css-scan-log');
    const params=new URLSearchParams({storeUrl:ctx.storeUrl});
    if(ctx.storePassword)params.append('storePassword',ctx.storePassword);
    const es=new EventSource(`/scan-css?${params}`);
    es.addEventListener('log',e=>{logEl.textContent+=JSON.parse(e.data).message+'\n';logEl.scrollTop=logEl.scrollHeight;});
    es.addEventListener('cssResult',e=>{renderCssResults(JSON.parse(e.data));});
    es.addEventListener('scanComplete',()=>{es.close();done();});
    es.addEventListener('scanError',e=>{logEl.textContent+='\nERROR: '+JSON.parse(e.data).details;es.close();done();});
    es.onerror=()=>{es.close();done();};
    function done(){document.getElementById('css-scan-loading').style.display='none';btn.disabled=false;btn.innerHTML='<i class="fas fa-rotate"></i> Re-analyse';}
  });
}

function renderCssResults(data){
  document.getElementById('css-results').style.display='block';document.getElementById('css-empty').style.display='none';
  document.getElementById('css-topbar-metrics').style.display='block';
  document.getElementById('css-bar-size').textContent=`${data.totalSizeKb} KB`;document.getElementById('css-bar-rules').textContent=data.totalRules.toLocaleString();document.getElementById('css-bar-unused').textContent=`${data.unusedPct}%`;document.getElementById('css-bar-savings').textContent=`${data.potentialSaveKb} KB`;
  const grade=data.grade||'D',gradeEl=document.getElementById('css-grade-circle');
  gradeEl.className=`img-grade-circle grade-${grade.toLowerCase()}`;
  document.getElementById('css-grade-letter').textContent=grade;document.getElementById('css-score-number').textContent=data.score;
  document.getElementById('css-stat-size').textContent=`${data.totalSizeKb} KB`;document.getElementById('css-stat-rules').textContent=data.totalRules.toLocaleString();document.getElementById('css-stat-savings').textContent=`${data.potentialSaveKb} KB`;
  const unusedEl=document.getElementById('css-stat-unused');unusedEl.textContent=`${data.unusedPct}%`;unusedEl.className=data.unusedPct>50?'poor':data.unusedPct>30?'warn':'good';Object.assign(unusedEl.style,{fontFamily:'var(--mono)',fontSize:'26px',fontWeight:'500',marginTop:'8px'});
  const usedPct=data.totalSizeKb>0?Math.round((data.afterOptKb/data.totalSizeKb)*100):100;
  document.getElementById('css-savings-bar').style.width=`${usedPct}%`;document.getElementById('css-current-size').textContent=`${data.totalSizeKb} KB`;document.getElementById('css-after-size').textContent=`~${data.afterOptKb} KB`;
  document.getElementById('css-blocking').textContent=data.blockingSheets;document.getElementById('css-inline').textContent=data.inlineStyles;document.getElementById('css-inline-size').textContent=`${data.inlineStyleSizeKb} KB`;
  document.getElementById('css-recommendations').innerHTML=data.recommendations?.length?data.recommendations.map(r=>`<div class="tip-box" style="margin-bottom:8px"><span>💡</span><span>${escHtml(r)}</span></div>`).join(''):'<div style="color:var(--green);font-size:13px;padding:8px 0">✅ CSS looks well optimised!</div>';
  const tbody=document.getElementById('css-files-tbody');
  tbody.innerHTML=data.files?.length?data.files.map(f=>{const uc=f.unusedPct>60?'var(--danger)':f.unusedPct>30?'var(--warn)':'var(--green)';return`<tr><td style="font-family:var(--mono);font-size:11px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(f.url)}">${escHtml(f.fileName)}</td><td style="font-family:var(--mono);font-size:12px">${f.sizeKb} KB</td><td style="font-family:var(--mono);font-size:12px;color:var(--muted)">${f.rules}</td><td><div style="display:flex;align-items:center;gap:8px"><div style="width:60px;height:5px;background:var(--border);border-radius:3px;overflow:hidden"><div style="height:100%;width:${f.unusedPct}%;background:${uc};border-radius:3px"></div></div><span style="font-family:var(--mono);font-size:12px;color:${uc}">${f.unusedPct}%</span></div></td><td style="font-family:var(--mono);font-size:12px;color:var(--green)">${f.savingsKb} KB</td></tr>`;}).join(''):'<tr><td colspan="5" class="table-empty">No CSS files detected.</td></tr>';
}

/* ══════════════════════════════════════════════════════
   HISTORY TAB
══════════════════════════════════════════════════════ */
function renderHistory(){
  const history=JSON.parse(localStorage.getItem('appAuditorHistory')||'[]');
  const emptyEl=document.getElementById('history-empty'),contentEl=document.getElementById('history-content');
  if(!history.length){emptyEl.style.display='flex';contentEl.style.display='none';return;}
  emptyEl.style.display='none';contentEl.style.display='block';
  const labels=history.map(e=>new Date(e.date).toLocaleDateString()),perfScores=history.map(e=>e.performanceScore),lcpData=history.map(e=>e.lcp),tbtData=history.map(e=>e.tbt),clsData=history.map(e=>e.cls);
  const avg=arr=>arr.reduce((a,b)=>a+b,0)/arr.length;const avgPerf=avg(perfScores).toFixed(0);
  document.getElementById('kpi-grid').innerHTML=`<div class="kpi-card"><div class="kpi-label">Scans run</div><div class="kpi-val">${history.length}</div></div><div class="kpi-card"><div class="kpi-label">Avg performance</div><div class="kpi-val ${rateScore(avgPerf)}">${avgPerf}</div></div><div class="kpi-card"><div class="kpi-label">Avg LCP</div><div class="kpi-val">${avg(lcpData).toFixed(2)}s</div></div><div class="kpi-card"><div class="kpi-label">Avg TBT</div><div class="kpi-val">${avg(tbtData).toFixed(0)}ms</div></div>`;
  ['scoresChart','vitalsChart'].forEach(id=>{const c=Chart.getChart(id);if(c)c.destroy();});
  Chart.defaults.color='#8892a4';Chart.defaults.borderColor='#2a2f45';
  new Chart(document.getElementById('scoresChart'),{type:'line',data:{labels,datasets:[{label:'Performance Score',data:perfScores,borderColor:'#6d7cff',backgroundColor:'rgba(109,124,255,.1)',fill:true,tension:0.3,pointBackgroundColor:'#6d7cff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#8892a4'}}},scales:{y:{min:0,max:100,ticks:{color:'#8892a4'}},x:{ticks:{color:'#8892a4'}}}}});
  new Chart(document.getElementById('vitalsChart'),{type:'line',data:{labels,datasets:[{label:'LCP (s)',data:lcpData,borderColor:'#4ade80',tension:0.3,yAxisID:'yS',pointBackgroundColor:'#4ade80'},{label:'TBT (ms)',data:tbtData,borderColor:'#f43f5e',tension:0.3,yAxisID:'yMs',pointBackgroundColor:'#f43f5e'},{label:'CLS',data:clsData,borderColor:'#f59e0b',tension:0.3,yAxisID:'yS',pointBackgroundColor:'#f59e0b'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#8892a4'}}},scales:{yS:{type:'linear',position:'left',beginAtZero:true,ticks:{color:'#8892a4'}},yMs:{type:'linear',position:'right',beginAtZero:true,ticks:{color:'#8892a4'},grid:{display:false}},x:{ticks:{color:'#8892a4'},grid:{display:false}}}}});
  document.getElementById('clearHistoryBtn').onclick=()=>{if(!confirm('Delete all scan history?'))return;localStorage.removeItem('appAuditorHistory');renderHistory();renderSpeedHistory();};
}

function saveToHistory(perfReport){
  try{
    const entry={url:ctx.storeUrl,device:'desktop',date:new Date().toISOString(),performanceScore:parseInt(perfReport.metrics.performanceScore,10),accessibilityScore:Math.round((perfReport.categories?.accessibility?.score||0)*100),bestPracticesScore:Math.round((perfReport.categories?.['best-practices']?.score||0)*100),seoScore:Math.round((perfReport.categories?.seo?.score||0)*100),lcp:parseMetricValue(perfReport.metrics.lcp),tbt:parseMetricValue(perfReport.metrics.tbt),cls:parseMetricValue(perfReport.metrics.cls)};
    const hist=JSON.parse(localStorage.getItem('appAuditorHistory')||'[]');hist.push(entry);localStorage.setItem('appAuditorHistory',JSON.stringify(hist));
  }catch(e){console.error('History save failed:',e);}
}

/* ── UI STATE ──────────────────────────────────────── */
function hideLoading(){ elLoading.style.display='none'; }
function showError(msg){ elError.style.display='flex'; elErrorMsg.textContent=msg; }
function logMsg(message, type='info'){
  const line=document.createElement('span');
  line.className=`log-line log-${type}`;line.textContent=message;
  elLog.appendChild(line);elLog.parentElement.scrollTop=elLog.parentElement.scrollHeight;
  if(message.startsWith('[+]')||message.startsWith('[System]'))
    elLoadingMsg.textContent=message.replace(/^\[.*?\]\s*/,'').slice(0,60);
}

let toastTimer;
function copyText(text){
  navigator.clipboard.writeText(text).then(()=>{
    let toast=document.getElementById('copy-toast');
    if(!toast){toast=document.createElement('div');toast.id='copy-toast';toast.className='copy-toast';document.body.appendChild(toast);}
    toast.textContent='Copied!';toast.classList.add('show');clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>toast.classList.remove('show'),2000);
  });
}
window.toggleAudit = toggleAudit;
window.copyText    = copyText;

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
  initSort();
  initRescanButton();
  initSpeedAudit();
  initImageScan();
  initGhostScan();
  initFontScan();
  initCssScan();

  boot(); // Auto-boot — no user input needed
});
