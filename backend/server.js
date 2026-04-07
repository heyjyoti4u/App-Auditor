 import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { scanStoreLogic } from './scan.js';
import puppeteer from 'puppeteer';
import lighthouse from 'lighthouse';
import { URL } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const adminToken     = process.env.SHOPIFY_ADMIN_TOKEN;
const globalStoreUrl = process.env.SHOPIFY_STORE_URL;
const shopifyApiUrl  = globalStoreUrl ? `https://${globalStoreUrl}/admin/api/2025-10` : null;

// ── FINGERPRINT DB ──────────────────────────────────────
const dbPath = path.join(__dirname, 'fingerprintDatabase.json');
let FINGERPRINT_DB = {};
(async () => {
  try {
    FINGERPRINT_DB = JSON.parse(await fs.readFile(dbPath, 'utf-8'));
    console.log('[Server] Fingerprint DB loaded.');
  } catch (e) {
    console.error('[Server] Failed to load fingerprint DB:', e.message);
  }
})();

function buildFingerprintMap() {
  const map = new Map();
  for (const [appName, appData] of Object.entries(FINGERPRINT_DB)) {
    if (!appData || !Array.isArray(appData.fingerprints) || !appData.fingerprints.length) continue;
    for (const fp of appData.fingerprints) {
      map.set(fp, { name: appName, icon: appData.icon, recommendation: appData.recommendation, category: appData.category || 'Uncategorized' });
    }
  }
  return map;
}

// ── NORMALIZE URL ────────────────────────────────────────
function normalizeUrl(raw) {
  if (!raw) return '';
  const s = raw.trim();
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  return 'https://' + s;
}

// ── EXTRACT HOSTNAME ─────────────────────────────────────
function extractHostname(urlOrHost) {
  try {
    return new URL(normalizeUrl(urlOrHost)).hostname;
  } catch {
    return urlOrHost.replace(/^https?:\/\//, '').split('/')[0];
  }
}

// ── FIND CULPRITS from Lighthouse bootup-time audit ──────
function findCulprits(audits, fingerprintMap) {
  const bootup = audits['bootup-time'];
  if (!bootup?.details?.items) return { identified: [], unidentified: [] };
  const identified = [], unidentified = [];
  for (const item of bootup.details.items) {
    const dur = item.scripting;
    if (dur < 50) continue;
    let matched = null;
    for (const [fp, info] of fingerprintMap.entries()) {
      if (item.url.includes(fp)) { matched = info; break; }
    }
    if (matched) {
      const ex = identified.find(c => c.appName === matched.name);
      ex ? (ex.duration += dur, ex.scriptCount++) :
           identified.push({ appName: matched.name, icon: matched.icon, duration: dur, scriptCount: 1 });
    } else if (item.url) {
      unidentified.push({ url: item.url, duration: dur });
    }
  }
  identified.sort((a, b) => b.duration - a.duration);
  unidentified.sort((a, b) => b.duration - a.duration);
  return { identified: identified.slice(0, 5), unidentified: unidentified.slice(0, 5) };
}

// ── BUILD APP PERFORMANCE MAP from Lighthouse network requests ──
// Matches each app's name against network request URLs to estimate load time/size
function buildAppPerfMap(audits, fingerprintMap, apiApps) {
  const perfMap = new Map(); // appName -> { totalSizeKb, totalDurationMs, assets[] }

  // 1. Use bootup-time for CPU/scripting duration
  const bootup = audits['bootup-time'];
  if (bootup?.details?.items) {
    for (const item of bootup.details.items) {
      for (const [fp, info] of fingerprintMap.entries()) {
        if (item.url.includes(fp)) {
          const key = info.name;
          if (!perfMap.has(key)) perfMap.set(key, { totalSizeKb: 0, totalDurationMs: 0, assets: [] });
          const entry = perfMap.get(key);
          entry.totalDurationMs += item.scripting || 0;
          break;
        }
      }
    }
  }

  // 2. Use network-requests audit for transfer sizes
  const networkReqs = audits['network-requests'];
  if (networkReqs?.details?.items) {
    for (const item of networkReqs.details.items) {
      const url = item.url || '';
      if (!/\.(js|css)(\?|$)/i.test(url)) continue;
      for (const [fp, info] of fingerprintMap.entries()) {
        if (url.includes(fp)) {
          const key = info.name;
          if (!perfMap.has(key)) perfMap.set(key, { totalSizeKb: 0, totalDurationMs: 0, assets: [] });
          const entry = perfMap.get(key);
          const sizeKb = +((item.transferSize || 0) / 1024).toFixed(2);
          const durationMs = +(item.networkRequestTime || 0).toFixed(2);
          entry.totalSizeKb     += sizeKb;
          entry.totalDurationMs += durationMs;
          entry.assets.push({
            url,
            type: /\.js(\?|$)/i.test(url) ? 'JS' : 'CSS',
            sizeKb,
            durationMs,
          });
          break;
        }
      }
    }
  }

  return perfMap;
}

// ── PUPPETEER LAUNCH HELPER ──────────────────────────────
function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-ipv6', '--proxy-server=direct://', '--proxy-bypass-list=*'
    ]
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const sendSse = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
};

async function handleStorePassword(page, storePassword) {
  if (!storePassword) return;
  try {
    const input = await page.$('input[type="password"]');
    if (input) {
      await input.type(storePassword);
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    }
  } catch {}
}

async function handleModals(page, log) {
  try {
    const btn = await page.waitForSelector(
      '[id*="onetrust-accept-btn-handler"],[aria-label*="accept"],[aria-label*="Accept"],[class*="cookie-accept"],[id*="cookie-accept"]',
      { timeout: 3000 }
    );
    if (btn) {
      await btn.click();
      await new Promise(r => setTimeout(r, 1000));
      if (log) log('[System] Modal dismissed.');
    }
  } catch { if (log) log('[System] No modal found. Proceeding.'); }
}

// ════════════════════════════════════════════════════════
// ADMIN API APP SCAN: /scan-apps-api
// Fetches installed apps + enriches with fingerprint DB
// ════════════════════════════════════════════════════════
app.get('/scan-apps-api', async (req, res) => {
  const { storeUrl, adminToken: reqToken } = req.query;
  if (!storeUrl) return res.status(400).json({ error: 'storeUrl is required' });

  const token = reqToken || adminToken;
  const host  = extractHostname(storeUrl);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (message, type = 'info') => {
    console.log(message);
    sendSse(res, 'log', { message, type });
  };

  try {
    if (!token) throw new Error('No Admin Token provided. Enter shpat_... in the token field.');

    log('[Apps API] Connecting to Shopify Admin API...', 'info');

    const gqlRes = await axios({
      url: `https://${host}/admin/api/2025-01/graphql.json`,
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      data: JSON.stringify({
        query: `{
          appInstallations(first: 100) {
            edges {
              node {
                app {
                  title
                  handle
                  developerName
                  description
                  appStoreAppUrl
                }
              }
            }
          }
        }`
      }),
      timeout: 30000
    });

    const gqlErrors = gqlRes.data?.errors;
    if (gqlErrors?.length) throw new Error(gqlErrors.map(e => e.message).join('; '));

    const edges = gqlRes.data?.data?.appInstallations?.edges || [];
    if (!edges.length) throw new Error('No app installations found. Ensure token has read_apps scope.');

    log(`[Apps API] Found ${edges.length} installed apps. Enriching...`, 'success');

    const enrichedApps = edges.map(edge => {
      const shopifyApp = edge.node.app;
      const name       = shopifyApp.title || 'Unknown';
      const nameLower  = name.toLowerCase();

      let dbMatch = null;
      for (const [dbName, dbData] of Object.entries(FINGERPRINT_DB)) {
        const dbLower = dbName.toLowerCase();
        const dbWords = dbLower.split(/[\s\-_&.]+/).filter(w => w.length > 4);
        if (
          dbLower === nameLower ||
          nameLower.includes(dbLower) ||
          dbLower.includes(nameLower) ||
          dbWords.some(w => nameLower.includes(w))
        ) {
          dbMatch = { key: dbName, data: dbData };
          break;
        }
      }

      const category       = dbMatch?.data?.category || inferCategoryFromApp(name, shopifyApp.developerName || '');
      const impact         = getImpactForCategory(category);
      const recommendation = dbMatch?.data?.recommendation || getDefaultRecommendation(category);

      return {
        name,
        handle:          shopifyApp.handle || '',
        developer:       shopifyApp.developerName || 'Unknown',
        icon:            dbMatch?.data?.icon || '',
        category,
        description:     shopifyApp.description || '',
        appStoreUrl:     shopifyApp.appStoreAppUrl || `https://apps.shopify.com/${shopifyApp.handle || ''}`,
        recommendation,
        impact,
        // Performance data — filled in later by Lighthouse if available
        totalSizeKb:        0,
        totalDurationMs:    0,
        assets:             [],
        estimatedSavingsMs: 0,
        source: 'api',
      };
    });

    const impactOrder = { High: 3, Medium: 2, Low: 1 };
    enrichedApps.sort((a, b) =>
      (impactOrder[b.impact] || 0) - (impactOrder[a.impact] || 0) || a.name.localeCompare(b.name)
    );

    const highImpact = enrichedApps.filter(a => a.impact === 'High').length;
    const appReport  = {
      storeUrl:            `https://${host}`,
      executiveSummary:    {
        totalAppsDetected: enrichedApps.length,
        totalAppSizeMb:    0,
        totalRequests:     0,
        highImpactApps:    highImpact,
        source:            'shopify_admin_api',
      },
      topCulprits:         enrichedApps.filter(a => a.impact === 'High').slice(0, 5),
      appBreakdown:        enrichedApps,
      unidentifiedDomains: [],
      heavyHitters:        [],
      source:              'shopify_admin_api',
    };

    log(`[Apps API] Done — ${enrichedApps.length} apps, ${highImpact} high-impact.`, 'success');
    sendSse(res, 'scanResult', appReport);
    sendSse(res, 'scanComplete', { message: 'API app scan complete.' });

  } catch (error) {
    console.error('[Apps API] Error:', error.response?.data || error.message);
    const detail = error.response?.data?.errors
      ? JSON.stringify(error.response.data.errors)
      : error.message;
    sendSse(res, 'scanError', { details: detail });
    sendSse(res, 'scanComplete', { message: 'Done with errors' });
  } finally {
    res.end();
  }
});

// ── Category / Impact / Recommendation helpers ────────────
function inferCategoryFromApp(name, developer) {
  const n = (name + ' ' + developer).toLowerCase();
  if (n.match(/review|rating|yotpo|stamped|judge\.me|okendo|loox/)) return 'Reviews';
  if (n.match(/email|klaviyo|mailchimp|omnisend|drip|sms|attentive|postscript/)) return 'Email & Marketing';
  if (n.match(/analytic|pixel|hotjar|segment|tracking|lucky orange|clarity/)) return 'Analytics';
  if (n.match(/chat|support|helpdesk|gorgias|zendesk|reamaze|tidio/)) return 'Customer Service';
  if (n.match(/upsell|cross.sell|bundle|frequently bought|zipify|reconvert/)) return 'Upsell & Cross-sell';
  if (n.match(/page builder|pagefly|gempages|shogun|layout|sections/)) return 'Page Builder';
  if (n.match(/subscri|recharge|bold sub|appstle|recurring|paywhirl/)) return 'Subscriptions';
  if (n.match(/loyal|reward|points|referral|smile\.io|growave/)) return 'Loyalty & Rewards';
  if (n.match(/shipping|fulfil|shipstation|easyship|delivery|rates/)) return 'Shipping & Fulfillment';
  if (n.match(/payment|checkout|klarna|afterpay|sezzle|pay later/)) return 'Payments';
  if (n.match(/seo|image optim|compress|alt text|schema|json-ld/)) return 'SEO & Image Optimization';
  if (n.match(/pop.?up|popup|notification|announcement|privy|spin/)) return 'Pop-ups & Notifications';
  if (n.match(/inventory|stock|back in stock|restock|alert/)) return 'Inventory & Alerts';
  if (n.match(/return|exchange|refund|loop|returnly/)) return 'Returns & Exchanges';
  if (n.match(/social|instagram|facebook|tiktok|feed|ugc/)) return 'Social Media';
  if (n.match(/translat|langify|weglot|language|localiz/)) return 'Translation';
  if (n.match(/b2b|wholesale|trade|net 30|account/)) return 'B2B & Wholesale';
  if (n.match(/dropship|oberlo|dsers|cj drop/)) return 'Dropshipping';
  if (n.match(/trust|badge|security|mcafee|norton|safe/)) return 'Trust & Security';
  if (n.match(/option|variant|customiz|product option|infinite/)) return 'Product Options';
  if (n.match(/digital|download|ebook|file|course/)) return 'Digital Products';
  if (n.match(/booking|appointment|service|calendar|schedule/)) return 'Services & Bookings';
  if (n.match(/navigation|menu|filter|search|mega menu/)) return 'Navigation & UI';
  if (n.match(/mobile|app builder|pwa|tapcart/)) return 'Mobile';
  if (n.match(/cdn|hosting|cloudflare|speed/)) return 'CDN & Hosting';
  if (n.match(/compliance|gdpr|cookie|privacy|ccpa/)) return 'Compliance';
  if (n.match(/accessib|wcag|ada/)) return 'Accessibility';
  return 'Utilities';
}
function getImpactForCategory(category) {
  const high = ['Analytics','Email & Marketing','Reviews','Page Builder','Subscriptions','Upsell & Cross-sell'];
  const med  = ['Customer Service','Loyalty & Rewards','Pop-ups & Notifications','Navigation & UI','Social Media','Translation'];
  return high.includes(category) ? 'High' : med.includes(category) ? 'Medium' : 'Low';
}
function getDefaultRecommendation(category) {
  const recs = {
    'Analytics':              'Load analytics scripts asynchronously to avoid render blocking.',
    'Email & Marketing':      'Email/marketing widgets add significant script weight — load lazily.',
    'Reviews':                'Lazy-load review widgets below the fold to improve LCP.',
    'Customer Service':       'Defer chat widgets until after page load to reduce TBT.',
    'Page Builder':           'Page builder apps inject heavy CSS/JS — audit unused styles regularly.',
    'Subscriptions':          'Subscription widgets can slow checkout — test performance carefully.',
    'Upsell & Cross-sell':    'Ensure upsell scripts fire only after the page is interactive.',
    'Loyalty & Rewards':      'Loyalty widgets are safe to lazy-load.',
    'Pop-ups & Notifications':'Defer pop-up scripts by 3–5 seconds to avoid TBT impact.',
    'SEO & Image Optimization':'SEO apps should not add render-blocking scripts to the storefront.',
    'Social Media':           'Use native lazy loading for social feed embeds.',
    'Translation':            'Ensure language switcher scripts are deferred.',
  };
  return recs[category] || 'Monitor this app\'s impact and remove if no longer needed.';
}

// ════════════════════════════════════════════════════════
// MAIN SCAN: /scan-all  (puppeteer-based, fallback)
// ════════════════════════════════════════════════════════
app.get('/scan-all', async (req, res) => {
  const { storeUrl, storePassword, runPerfScan, runAppScan, device } = req.query;
  if (!storeUrl) return res.status(400).json({ error: 'storeUrl is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (message) => {
    console.log(message);
    let type = 'info';
    if (message.startsWith('[+]')) type = 'success';
    if (message.startsWith('[!]') || message.includes('ERROR')) type = 'error';
    sendSse(res, 'log', { message, type });
  };

  const finalUrl = normalizeUrl(storeUrl);
  let browser, errorOccurred = false;
  try {
    log('[System] Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setCacheEnabled(false);

    log('[System] Navigating to store...');
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await handleStorePassword(page, storePassword);
    await handleModals(page, log);

    const fingerprintMap = buildFingerprintMap();
    let appReport  = { executiveSummary: {}, appBreakdown: [], topCulprits: [] };
    let perfReport = { success: false, metrics: null, categories: null, audits: null, culprits: null };

    if (runAppScan === 'true') {
      log('[App] Running puppeteer app scan...');
      appReport = await scanStoreLogic(page, log, fingerprintMap);
    }

    if (runPerfScan === 'true') {
      log(`[Perf] Running Lighthouse (${device || 'desktop'})...`);
      const isMobile = device === 'mobile';
      const settings = isMobile
        ? { formFactor: 'mobile', screenEmulation: { mobile: true, width: 360, height: 640, deviceScaleFactor: 2.625, disabled: false },
            throttlingMethod: 'simulate', throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 } }
        : { formFactor: 'desktop', screenEmulation: { mobile: false } };

      const chromePort = new URL(browser.wsEndpoint()).port;
      const { lhr } = await lighthouse(page.url(), { port: chromePort, output: 'json', settings });
      const audits = lhr.audits;
      const metrics = {
        lcp:              audits['largest-contentful-paint']?.displayValue ?? 'N/A',
        cls:              audits['cumulative-layout-shift']?.displayValue   ?? 'N/A',
        tbt:              audits['total-blocking-time']?.displayValue       ?? 'N/A',
        fcp:              audits['first-contentful-paint']?.displayValue    ?? 'N/A',
        speedIndex:       audits['speed-index']?.displayValue               ?? 'N/A',
        inp:              audits['interaction-to-next-paint']?.displayValue  ?? 'N/A',
        performanceScore: Math.round(lhr.categories.performance.score * 100),
        device:           device || 'desktop',
      };
      const categories = {
        performance:      lhr.categories.performance,
        accessibility:    lhr.categories.accessibility,
        'best-practices': lhr.categories['best-practices'],
        seo:              lhr.categories.seo,
      };
      const culprits = findCulprits(audits, fingerprintMap);
      perfReport = { success: true, metrics, categories, audits, culprits };
      if (appReport?.executiveSummary) appReport.executiveSummary.performanceScore = metrics.performanceScore;
    }

    sendSse(res, 'scanResult', appReport);
    sendSse(res, 'perfResult', perfReport);
    log('[System] All scans finished.');

  } catch (error) {
    errorOccurred = true;
    console.error('[scan-all]', error);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    try { if (browser) await browser.close(); } catch {}
    if (!errorOccurred) sendSse(res, 'scanComplete', { message: 'Done' });
    else sendSse(res, 'scanComplete', { message: 'Done with errors' });
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// SPEED SCAN: /scan-speed
// Lighthouse only. Also enriches API apps with perf data
// and sends back perfResult + optional enrichedApps event.
// ════════════════════════════════════════════════════════
app.get('/scan-speed', async (req, res) => {
  const { storeUrl, storePassword, device, adminToken: reqToken } = req.query;
  if (!storeUrl) return res.status(400).json({ error: 'storeUrl is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (message) => {
    console.log(message);
    let type = 'info';
    if (message.startsWith('[+]')) type = 'success';
    if (message.startsWith('[!]') || message.includes('ERROR')) type = 'error';
    sendSse(res, 'log', { message, type });
  };

  const finalUrl = normalizeUrl(storeUrl);
  let browser, errorOccurred = false;
  try {
    log('[Speed] Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setCacheEnabled(false);

    log('[Speed] Navigating to store...');
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await handleStorePassword(page, storePassword);

    log(`[Speed] Running Lighthouse (${device || 'desktop'})...`);
    const isMobile = device === 'mobile';
    const settings = isMobile
      ? { formFactor: 'mobile', screenEmulation: { mobile: true, width: 360, height: 640, deviceScaleFactor: 2.625, disabled: false },
          throttlingMethod: 'simulate', throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 } }
      : { formFactor: 'desktop', screenEmulation: { mobile: false } };

    const fingerprintMap = buildFingerprintMap();
    const chromePort = new URL(browser.wsEndpoint()).port;
    const { lhr } = await lighthouse(page.url(), { port: chromePort, output: 'json', settings });
    const audits = lhr.audits;

    const metrics = {
      lcp:              audits['largest-contentful-paint']?.displayValue ?? 'N/A',
      cls:              audits['cumulative-layout-shift']?.displayValue   ?? 'N/A',
      tbt:              audits['total-blocking-time']?.displayValue       ?? 'N/A',
      fcp:              audits['first-contentful-paint']?.displayValue    ?? 'N/A',
      speedIndex:       audits['speed-index']?.displayValue               ?? 'N/A',
      inp:              audits['interaction-to-next-paint']?.displayValue  ?? 'N/A',
      performanceScore: Math.round(lhr.categories.performance.score * 100),
      device:           device || 'desktop',
    };
    const categories = {
      performance:      lhr.categories.performance,
      accessibility:    lhr.categories.accessibility,
      'best-practices': lhr.categories['best-practices'],
      seo:              lhr.categories.seo,
    };
    const culprits   = findCulprits(audits, fingerprintMap);
    const perfReport = { success: true, metrics, categories, audits, culprits };

    // ── Build per-app perf data from Lighthouse network-requests ──
    const appPerfMap = buildAppPerfMap(audits, fingerprintMap, []);

    sendSse(res, 'speedResult', perfReport);

    // Send enriched perf map so client can merge into app cards
    if (appPerfMap.size > 0) {
      const appPerfArray = Array.from(appPerfMap.entries()).map(([name, data]) => ({
        name,
        totalSizeKb:        +data.totalSizeKb.toFixed(2),
        totalDurationMs:    +data.totalDurationMs.toFixed(2),
        assets:             data.assets,
        estimatedSavingsMs: Math.round(data.totalDurationMs * 0.6),
      }));
      sendSse(res, 'appPerfData', { apps: appPerfArray });
    }

    log(`[+] Lighthouse done. Score: ${metrics.performanceScore}`);

  } catch (error) {
    errorOccurred = true;
    console.error('[scan-speed]', error);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    try { if (browser) await browser.close(); } catch {}
    if (!errorOccurred) sendSse(res, 'scanComplete', { message: 'Done' });
    else sendSse(res, 'scanComplete', { message: 'Done with errors' });
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// IMAGE OPTIMIZER: /scan-images
// Uses Admin API (if token provided) to get product images,
// PLUS puppeteer scan of homepage + up to 3 product pages
// ════════════════════════════════════════════════════════
app.get('/scan-images', async (req, res) => {
  const { storeUrl, storePassword, adminToken: reqToken } = req.query;
  if (!storeUrl) return res.status(400).json({ error: 'storeUrl is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (msg) => { console.log(msg); sendSse(res, 'log', { message: msg }); };

  const token    = reqToken || adminToken;
  const finalUrl = normalizeUrl(storeUrl);
  const hostname = extractHostname(storeUrl);
  let browser, errorOccurred = false;

  try {
    // ── STEP 1: Fetch product images via Admin API ────────
    let apiProductImages = [];
    if (token) {
      log('[Images] Fetching product images via Admin API...');
      try {
        // Use REST for simplicity — fetch up to 250 products with images
        const productsRes = await axios.get(
          `https://${hostname}/admin/api/2024-01/products.json?fields=id,title,images&limit=250`,
          { headers: { 'X-Shopify-Access-Token': token }, timeout: 30000 }
        );
        const products = productsRes.data?.products || [];
        for (const product of products) {
          for (const img of product.images || []) {
            if (img.src) {
              apiProductImages.push({
                src:       img.src,
                alt:       img.alt || product.title || '',
                hasAlt:    !!(img.alt || '').trim(),
                productId: product.id,
                productTitle: product.title,
                fromApi:   true,
              });
            }
          }
        }
        log(`[Images] API returned ${apiProductImages.length} product images from ${products.length} products.`);
      } catch (apiErr) {
        log(`[Images] Admin API image fetch failed (${apiErr.message}). Will use DOM scan only.`);
      }
    }

    // ── STEP 2: DOM scan of homepage + product pages ──────
    log('[Images] Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCacheEnabled(false);

    // Track image response sizes
    const imageSizeMap = new Map();
    const attachResponseListener = () => {
      page.on('response', async (response) => {
        const url = response.url();
        if (!/\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|$)/i.test(url) || imageSizeMap.has(url)) return;
        try {
          const headers = response.headers();
          let size = parseInt(headers['content-length'] || 0, 10);
          if (!size) {
            try { const buf = await response.buffer(); size = buf.length; } catch {}
          }
          if (size) imageSizeMap.set(url, size);
        } catch {}
      });
    };

    attachResponseListener();

    log('[Images] Navigating to homepage...');
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await handleStorePassword(page, storePassword);
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    page.removeAllListeners('response');

    // Grab homepage images
    const homepageImages = await extractDomImages(page);
    log(`[Images] Homepage: ${homepageImages.length} images found.`);

    // ── STEP 3: Visit product pages for DOM images ────────
    let productPageImages = [];
    try {
      // Find product links on homepage
      const productLinks = await page.evaluate((baseUrl) => {
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.href)
          .filter(href => href.includes('/products/') && !href.includes('#'))
          .filter(href => {
            try { return new URL(href).hostname === new URL(baseUrl).hostname; } catch { return false; }
          });
        // Deduplicate
        return [...new Set(links)].slice(0, 4);
      }, finalUrl);

      log(`[Images] Found ${productLinks.length} product page(s) to scan...`);

      for (const link of productLinks) {
        try {
          attachResponseListener();
          await page.goto(link, { waitUntil: 'networkidle2', timeout: 45000 });
          await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
          page.removeAllListeners('response');
          const imgs = await extractDomImages(page);
          productPageImages.push(...imgs);
          log(`[Images] Product page scanned: ${imgs.length} images.`);
        } catch { page.removeAllListeners('response'); }
      }
    } catch (e) {
      log(`[Images] Product page scan skipped: ${e.message}`);
    }

    // ── STEP 4: Merge all image sources ──────────────────
    log('[Images] Merging all image sources...');

    // Combine DOM images (homepage + product pages)
    const domImages = [...homepageImages, ...productPageImages];

    // Build a URL-keyed map — DOM images take priority (have display dimensions)
    const allImagesMap = new Map();

    // Add API product images first (as base)
    for (const img of apiProductImages) {
      // Strip Shopify CDN query params for deduplication key
      const baseUrl = img.src.split('?')[0];
      if (!allImagesMap.has(baseUrl)) {
        allImagesMap.set(baseUrl, {
          src:          img.src,
          alt:          img.alt,
          hasAlt:       img.hasAlt,
          naturalWidth: 0,
          naturalHeight:0,
          displayWidth: 0,
          sizeKb:       0,
          loading:      'eager',
          fromApi:      true,
          productTitle: img.productTitle || '',
        });
      }
    }

    // Merge/overwrite with DOM data (more accurate)
    for (const img of domImages) {
      const baseUrl = img.src.split('?')[0];
      const sizeBytes = imageSizeMap.get(img.src) || 0;
      const sizeKb    = +(sizeBytes / 1024).toFixed(1);
      if (allImagesMap.has(baseUrl)) {
        // Update existing with DOM dimensions
        const existing = allImagesMap.get(baseUrl);
        existing.naturalWidth  = img.naturalWidth  || existing.naturalWidth;
        existing.naturalHeight = img.naturalHeight || existing.naturalHeight;
        existing.displayWidth  = img.displayWidth  || existing.displayWidth;
        existing.sizeKb        = sizeKb > 0 ? sizeKb : existing.sizeKb;
        existing.hasAlt        = img.hasAlt || existing.hasAlt;
        existing.alt           = img.alt   || existing.alt;
        existing.loading       = img.loading;
        existing.fromApi       = false; // confirmed in DOM
      } else {
        allImagesMap.set(baseUrl, {
          src:          img.src,
          alt:          img.alt,
          hasAlt:       img.hasAlt,
          naturalWidth: img.naturalWidth,
          naturalHeight:img.naturalHeight,
          displayWidth: img.displayWidth,
          sizeKb,
          loading:      img.loading,
          fromApi:      false,
          productTitle: '',
        });
      }
    }

    // ── STEP 5: Fetch sizes for API-only images via HEAD requests ──
    const apiOnlyImages = Array.from(allImagesMap.values()).filter(img => img.fromApi && img.sizeKb === 0);
    if (apiOnlyImages.length > 0) {
      log(`[Images] Fetching sizes for ${apiOnlyImages.length} API-only product images...`);
      // Batch HEAD requests (max 20 to avoid rate limits)
      const batchSize = 20;
      for (let i = 0; i < Math.min(apiOnlyImages.length, batchSize); i++) {
        const img = apiOnlyImages[i];
        try {
          const headRes = await axios.head(img.src, { timeout: 8000 });
          const cl = parseInt(headRes.headers['content-length'] || 0, 10);
          if (cl > 0) {
            img.sizeKb = +(cl / 1024).toFixed(1);
            allImagesMap.get(img.src.split('?')[0]).sizeKb = img.sizeKb;
          }
        } catch {}
      }
    }

    // ── STEP 6: Analyse all images ─────────────────────────
    log('[Images] Analysing all images...');
    let missingAlt = 0, oversized = 0, largeFiles = 0, nonModern = 0;
    let totalSizeBytes = 0, potentialSavingsBytes = 0;

    const processed = Array.from(allImagesMap.values())
      .filter(img => img.src && !img.src.startsWith('data:'))
      .map(img => {
        const sizeBytes = img.sizeKb * 1024;
        totalSizeBytes += sizeBytes;

        const issues = [];
        if (!img.hasAlt)                                  { issues.push('missing-alt'); missingAlt++; }
        const isOversized = img.naturalWidth > 0 && img.displayWidth > 0
          && img.naturalWidth > img.displayWidth * 2 && img.naturalWidth > 200;
        if (isOversized)                                   { issues.push('oversized'); oversized++; }
        if (img.sizeKb > 500)                              { issues.push('large-file'); largeFiles++; }
        const isModern = /\.(webp|avif)(\?|$)/i.test(img.src);
        if (!isModern && sizeBytes > 0)                    { issues.push('non-modern'); nonModern++; }

        let savingsBytes = 0;
        if (isOversized)  savingsBytes += sizeBytes * 0.35;
        if (!isModern)    savingsBytes += sizeBytes * 0.25;
        if (img.sizeKb > 500) savingsBytes += sizeBytes * 0.40;
        potentialSavingsBytes += savingsBytes;

        return {
          src:          img.src,
          alt:          img.alt,
          hasAlt:       img.hasAlt,
          naturalWidth: img.naturalWidth,
          naturalHeight:img.naturalHeight,
          displayWidth: img.displayWidth,
          sizeKb:       img.sizeKb,
          loading:      img.loading,
          isOversized,
          isModern,
          issues,
          fromApi:      img.fromApi,
          productTitle: img.productTitle,
        };
      });

    const withIssues   = processed.filter(img => img.issues.length > 0 || img.sizeKb > 100);
    const totalImages  = allImagesMap.size;
    const issuePoints  = missingAlt * 3 + oversized * 5 + largeFiles * 8 + nonModern * 2;
    const score        = Math.max(0, Math.min(100, 100 - Math.round(issuePoints / Math.max(totalImages, 1) * 10)));
    const scoreGrade   = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';

    const result = {
      score, scoreGrade,
      totalImages,
      imagesWithIssues: withIssues.length,
      missingAlt, oversized, largeFiles, nonModern,
      totalSizeMb:        +(totalSizeBytes / 1024 / 1024).toFixed(2),
      potentialSavingsKb: Math.round(potentialSavingsBytes / 1024),
      afterOptimizationMb: +((totalSizeBytes - potentialSavingsBytes) / 1024 / 1024).toFixed(2),
      apiProductCount:    apiProductImages.length,
      images:             withIssues.slice(0, 100),
    };

    log(`[Images] Done. ${totalImages} total images (${apiProductImages.length} from API). Score: ${score}/100.`);
    sendSse(res, 'imageResult', result);

  } catch (error) {
    errorOccurred = true;
    console.error('[scan-images]', error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    try { if (browser) await browser.close(); } catch {}
    if (!errorOccurred) sendSse(res, 'scanComplete', { message: 'Image scan complete.' });
    else sendSse(res, 'scanComplete', { message: 'Done with errors' });
    res.end();
  }
});

// ── Helper: extract all img tags from current page ────────
async function extractDomImages(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('img')).map(img => ({
      src:          img.currentSrc || img.src || '',
      alt:          img.alt || '',
      hasAlt:       (img.alt || '').trim() !== '',
      naturalWidth: img.naturalWidth  || 0,
      naturalHeight:img.naturalHeight || 0,
      displayWidth: Math.round(img.getBoundingClientRect().width) || 0,
      loading:      img.loading || 'eager',
    }))
  ).then(imgs =>
    imgs.filter(img => img.src && !img.src.startsWith('data:') && img.src.startsWith('http'))
  );
}

// ════════════════════════════════════════════════════════
// GHOST CODE SCANNER: /scan-ghost-code
// ════════════════════════════════════════════════════════
app.get('/scan-ghost-code', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (msg) => { console.log(msg); sendSse(res, 'log', { message: msg }); };

  const activeToken    = req.query.adminToken || adminToken;
  const activeStoreUrl = req.query.storeUrl   || globalStoreUrl;

  try {
    if (!activeToken)    throw new Error('Admin API Token missing. Enter it in the shpat_... field or set SHOPIFY_ADMIN_TOKEN in .env');
    if (!activeStoreUrl) throw new Error('Store URL missing.');

    const storeHostname = extractHostname(activeStoreUrl);
    const baseApiUrl    = `https://${storeHostname}/admin/api/2025-10`;

    const shopify = axios.create({
      baseURL: baseApiUrl,
      headers: { 'X-Shopify-Access-Token': activeToken, 'Content-Type': 'application/json' },
      timeout: 30000
    });

    log('[Ghost] Fetching installed apps...');
    let installedAppNames   = [];
    let installedAppHandles = [];
    try {
      const gqlRes = await axios({
        url: `https://${storeHostname}/admin/api/2024-01/graphql.json`,
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': activeToken, 'Content-Type': 'application/json' },
        data: JSON.stringify({ query: `{ appInstallations(first: 50) { edges { node { app { title handle } } } } }` }),
        timeout: 30000
      });
      const edges = gqlRes.data?.data?.appInstallations?.edges || [];
      installedAppNames   = edges.map(e => e.node.app.title.toLowerCase());
      installedAppHandles = edges.map(e => (e.node.app.handle || '').toLowerCase());
      log(`[Ghost] ${installedAppNames.length} installed apps found.`);
    } catch (err) {
      log(`[Ghost] Warning: Could not fetch installed apps (${err.message}). Continuing...`);
    }

    log('[Ghost] Fetching main theme...');
    const themeRes  = await shopify.get('/themes.json?role=main');
    const mainTheme = themeRes.data.themes?.[0];
    if (!mainTheme) throw new Error('No published theme found.');
    log(`[Ghost] Theme: "${mainTheme.name}" (ID: ${mainTheme.id})`);

    log('[Ghost] Fetching theme asset list...');
    const assetListRes = await shopify.get(`/themes/${mainTheme.id}/assets.json`);
    const allAssets    = assetListRes.data.assets || [];
    const liquidFiles  = allAssets.filter(a => a.key.endsWith('.liquid'));
    log(`[Ghost] Scanning ${liquidFiles.length} liquid files...`);

    const fingerprintMap = buildFingerprintMap();
    const detectedApps   = new Map();

    for (const file of liquidFiles) {
      let content = '';
      try {
        const fileRes = await shopify.get(
          `/themes/${mainTheme.id}/assets.json?asset[key]=${encodeURIComponent(file.key)}`
        );
        content = fileRes.data.asset?.value || '';
      } catch { continue; }
      if (!content) continue;

      for (const [fingerprint, appInfo] of fingerprintMap.entries()) {
        if (!content.includes(fingerprint)) continue;
        const key = appInfo.name;
        if (!detectedApps.has(key)) {
          const appWords   = appInfo.name.toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 3);
          const isInstalled =
            installedAppNames.some(name => appWords.some(w => name.includes(w))) ||
            installedAppHandles.some(handle => appWords.some(w => handle.includes(w)));

          const assetMeta = allAssets.find(a => a.key === file.key);
          const wastedKb  = assetMeta ? Math.round((assetMeta.size || 0) / 1024) : 0;

          detectedApps.set(key, {
            name:        appInfo.name,
            icon:        appInfo.icon,
            category:    appInfo.category || 'Uncategorized',
            files:       new Set(),
            fingerprint,
            isInstalled,
            confidence:  isInstalled ? 15 : 85,
            wastedKb,
          });
        }
        detectedApps.get(key).files.add(file.key);
      }
    }

    const foundApps = Array.from(detectedApps.values()).map(app => ({
      name:        app.name,
      icon:        app.icon,
      category:    app.category,
      fingerprint: app.fingerprint,
      isInstalled: app.isInstalled,
      confidence:  app.confidence,
      wastedKb:    app.wastedKb,
      files:       Array.from(app.files),
      fileCount:   app.files.size,
    }));

    foundApps.sort((a, b) => {
      if (!a.isInstalled && b.isInstalled) return -1;
      if (a.isInstalled && !b.isInstalled) return 1;
      return b.confidence - a.confidence;
    });

    const ghostCount    = foundApps.filter(a => !a.isInstalled).length;
    const totalWastedKb = foundApps.filter(a => !a.isInstalled).reduce((s, a) => s + (a.wastedKb || 0), 0);

    log(`[Ghost] Done. ${ghostCount} ghost(s) out of ${foundApps.length} matches.`);
    sendSse(res, 'ghostResult', { apps: foundApps, ghostCount, totalWastedKb, theme: mainTheme.name });

  } catch (error) {
    console.error('[scan-ghost-code]', error.response?.data || error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    sendSse(res, 'scanComplete', { message: 'Ghost scan complete.' });
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// FONT OPTIMIZER: /scan-fonts
// ════════════════════════════════════════════════════════
app.get('/scan-fonts', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (msg) => { console.log(msg); sendSse(res, 'log', { message: msg }); };
  const { storeUrl, storePassword } = req.query;
  if (!storeUrl) {
    sendSse(res, 'scanError', { details: 'storeUrl is required' });
    sendSse(res, 'scanComplete', { message: 'Done' });
    return res.end();
  }

  const finalUrl = normalizeUrl(storeUrl);
  let browser, errorOccurred = false;
  try {
    log('[Fonts] Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setCacheEnabled(false);

    const fontRequests = [];
    page.on('response', async (response) => {
      const url = response.url();
      const ct  = response.headers()['content-type'] || '';
      if (!/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url) && !ct.includes('font')) return;
      try {
        const headers  = response.headers();
        let sizeBytes  = parseInt(headers['content-length'] || 0, 10);
        if (!sizeBytes) { try { const buf = await response.buffer(); sizeBytes = buf.length; } catch {} }
        fontRequests.push({
          url, sizeKb: +(sizeBytes / 1024).toFixed(1),
          format:      url.match(/\.(woff2?|ttf|otf|eot)/i)?.[1]?.toLowerCase() || 'unknown',
          isGoogleFont: url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com'),
          status:      response.status(),
        });
      } catch {}
    });

    log('[Fonts] Navigating to store...');
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await handleStorePassword(page, storePassword);

    log('[Fonts] Analysing font usage...');
    const fontData = await page.evaluate(() => {
      const fonts = [], seen = new Set();
      document.fonts.forEach(font => {
        const key = `${font.family}|${font.weight}|${font.style}`;
        if (!seen.has(key)) { seen.add(key); fonts.push({ family: font.family, weight: font.weight, style: font.style, status: font.status }); }
      });
      const fontDisplayIssues = [];
      try {
        Array.from(document.styleSheets).forEach(sheet => {
          try {
            Array.from(sheet.cssRules || []).forEach(rule => {
              if (rule.constructor.name === 'CSSFontFaceRule') {
                const display = rule.style.getPropertyValue('font-display');
                const src     = rule.style.getPropertyValue('src');
                if (!display || display === 'auto' || display === 'block') {
                  fontDisplayIssues.push({ src: src.slice(0, 100), display: display || 'not set' });
                }
              }
            });
          } catch {}
        });
      } catch {}
      const preloadedFonts = Array.from(document.querySelectorAll('link[rel="preload"][as="font"]')).map(l => l.href);
      return { fonts, fontDisplayIssues, preloadedFonts };
    });

    page.removeAllListeners('response');

    const uniqueFonts = [];
    const seenUrls    = new Set();
    for (const f of fontRequests) { if (!seenUrls.has(f.url)) { seenUrls.add(f.url); uniqueFonts.push(f); } }

    const googleFonts = uniqueFonts.filter(f => f.isGoogleFont);
    const selfHosted  = uniqueFonts.filter(f => !f.isGoogleFont);
    const nonWoff2    = uniqueFonts.filter(f => f.format !== 'woff2' && !f.url.includes('fonts.gstatic.com'));
    const heavyFonts  = uniqueFonts.filter(f => f.sizeKb > 60);

    const issues = [], recommendations = [];
    let score = 100;
    if (googleFonts.length > 0) { issues.push({ type:'google-fonts', severity:'warn', message:`${googleFonts.length} Google Font(s) loaded from external CDN` }); recommendations.push('Self-host Google Fonts to eliminate external DNS lookups'); score -= 15; }
    if (fontData.fontDisplayIssues.length > 0) { issues.push({ type:'no-font-display', severity:'error', message:`${fontData.fontDisplayIssues.length} font(s) missing font-display: swap` }); recommendations.push('Add font-display: swap to all @font-face declarations'); score -= 20; }
    if (fontData.preloadedFonts.length === 0 && uniqueFonts.length > 0) { issues.push({ type:'no-preload', severity:'warn', message:'No fonts are preloaded' }); recommendations.push('Add <link rel="preload" as="font"> for primary fonts'); score -= 10; }
    if (nonWoff2.length > 0) { issues.push({ type:'non-woff2', severity:'warn', message:`${nonWoff2.length} font(s) not in WOFF2 format` }); recommendations.push('Convert all fonts to WOFF2'); score -= 10; }
    if (heavyFonts.length > 0) { issues.push({ type:'heavy-fonts', severity:'warn', message:`${heavyFonts.length} font file(s) over 60 KB` }); recommendations.push('Use Unicode-range subsetting'); score -= 5 * heavyFonts.length; }
    if (fontData.fonts.length > 6) { issues.push({ type:'too-many-fonts', severity:'info', message:`${fontData.fonts.length} font variants loaded` }); recommendations.push('Limit font variants to 2-3'); score -= 5; }

    score = Math.max(0, Math.min(100, score));
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';

    const result = {
      score, grade,
      totalFonts: fontData.fonts.length, totalFontFiles: uniqueFonts.length,
      googleFonts: googleFonts.length, selfHosted: selfHosted.length,
      totalSizeKb: +uniqueFonts.reduce((s, f) => s + f.sizeKb, 0).toFixed(1),
      preloaded: fontData.preloadedFonts.length, issues: issues.length,
      fontFaceIssues: fontData.fontDisplayIssues.length,
      fonts: fontData.fonts, fontFiles: uniqueFonts, issueList: issues, recommendations,
      estimatedSavingsMs: issues.length > 0 ? issues.length * 120 : 0,
    };

    log(`[Fonts] Done. Score: ${score}/100, ${issues.length} issue(s).`);
    sendSse(res, 'fontResult', result);

  } catch (error) {
    errorOccurred = true;
    console.error('[scan-fonts]', error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    try { if (browser) await browser.close(); } catch {}
    if (!errorOccurred) sendSse(res, 'scanComplete', { message: 'Font scan complete.' });
    else sendSse(res, 'scanComplete', { message: 'Done with errors' });
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// CSS ANALYSIS: /scan-css
// ════════════════════════════════════════════════════════
app.get('/scan-css', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (msg) => { console.log(msg); sendSse(res, 'log', { message: msg }); };
  const { storeUrl, storePassword } = req.query;
  if (!storeUrl) {
    sendSse(res, 'scanError', { details: 'storeUrl is required' });
    sendSse(res, 'scanComplete', { message: 'Done' });
    return res.end();
  }

  const finalUrl = normalizeUrl(storeUrl);
  let browser, errorOccurred = false;
  try {
    log('[CSS] Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setCacheEnabled(false);

    log('[CSS] Navigating to store...');
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await handleStorePassword(page, storePassword);

    log('[CSS] Starting CSS coverage...');
    await page.coverage.startCSSCoverage();
    try { await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }); } catch { log('[CSS] Reload timed out, using partial data.'); }
    const cssCoverage = await page.coverage.stopCSSCoverage();

    let totalBytes = 0, usedBytes = 0, totalRules = 0;
    const fileBreakdown = [];

    for (const entry of cssCoverage) {
      const entryTotal = entry.text ? entry.text.length : 0;
      let entryUsed = 0;
      for (const range of entry.ranges) entryUsed += range.end - range.start;
      totalBytes += entryTotal; usedBytes += entryUsed;
      const ruleCount  = (entry.text || '').split('{').length - 1;
      totalRules += ruleCount;
      const unusedPct  = entryTotal > 0 ? Math.round((1 - entryUsed / entryTotal) * 100) : 0;
      const sizeKb     = +(entryTotal / 1024).toFixed(1);
      const savingsKb  = +((entryTotal - entryUsed) / 1024).toFixed(1);
      let fileName = entry.url;
      try { fileName = new URL(entry.url).pathname.split('/').pop() || entry.url; } catch {}
      fileBreakdown.push({ url: entry.url, fileName, sizeKb, unusedPct, savingsKb, rules: ruleCount });
    }

    fileBreakdown.sort((a, b) => b.savingsKb - a.savingsKb);
    const unusedPct   = totalBytes > 0 ? Math.round((1 - usedBytes / totalBytes) * 100) : 0;
    const totalSizeKb = +(totalBytes / 1024).toFixed(1);
    const potentialSave = +((totalBytes - usedBytes) / 1024).toFixed(1);

    const domAnalysis = await page.evaluate(() => {
      const blocking = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).filter(l => !l.media || l.media === 'all' || l.media === 'screen').length;
      const inlineStyles = document.querySelectorAll('[style]').length;
      const inlineStyleSize = Array.from(document.querySelectorAll('style')).reduce((s, el) => s + (el.textContent || '').length, 0);
      return { blocking, inlineStyles, inlineStyleSizeKb: +(inlineStyleSize / 1024).toFixed(1) };
    });

    let score = 100;
    if (unusedPct > 60) score -= 30; else if (unusedPct > 40) score -= 20; else if (unusedPct > 20) score -= 10;
    if (totalSizeKb > 500) score -= 20; else if (totalSizeKb > 200) score -= 10;
    if (domAnalysis.blocking > 3) score -= 10;
    score = Math.max(0, Math.min(100, score));
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';

    const recommendations = [];
    if (unusedPct > 30)  recommendations.push('Remove unused CSS — consider PurgeCSS or Shopify theme CSS optimization');
    if (domAnalysis.blocking > 2) recommendations.push('Reduce render-blocking stylesheets by inlining critical CSS');
    if (totalSizeKb > 200) recommendations.push('Minify CSS files to reduce transfer size');
    if (fileBreakdown.some(f => f.unusedPct > 70)) recommendations.push('Some CSS files are >70% unused — consider splitting or removing them');

    const result = {
      score, grade, totalSizeKb, totalRules, unusedPct,
      potentialSaveKb: potentialSave, afterOptKb: +(usedBytes / 1024).toFixed(1),
      blockingSheets: domAnalysis.blocking, inlineStyles: domAnalysis.inlineStyles,
      inlineStyleSizeKb: domAnalysis.inlineStyleSizeKb,
      fileCount: fileBreakdown.length, files: fileBreakdown.slice(0, 20), recommendations,
    };

    log(`[CSS] Done. Score: ${score}/100, ${unusedPct}% unused.`);
    sendSse(res, 'cssResult', result);

  } catch (error) {
    errorOccurred = true;
    console.error('[scan-css]', error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    try { if (browser) await browser.close(); } catch {}
    if (!errorOccurred) sendSse(res, 'scanComplete', { message: 'CSS analysis complete.' });
    else sendSse(res, 'scanComplete', { message: 'Done with errors' });
    res.end();
  }
});

// ── SERVE FRONTEND ────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend', 'server.html'));
});

app.listen(port, () => console.log(`[Server] App Auditor running at http://localhost:${port}`));
