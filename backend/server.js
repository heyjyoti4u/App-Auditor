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

const adminToken    = process.env.SHOPIFY_ADMIN_TOKEN;
const globalStoreUrl = process.env.SHOPIFY_STORE_URL;
const shopifyApiUrl  = `https://${globalStoreUrl}/admin/api/2025-10`;

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
      ex ? (ex.duration += dur, ex.scriptCount++) : identified.push({ appName: matched.name, icon: matched.icon, duration: dur, scriptCount: 1 });
    } else if (item.url) {
      unidentified.push({ url: item.url, duration: dur });
    }
  }
  identified.sort((a, b) => b.duration - a.duration);
  unidentified.sort((a, b) => b.duration - a.duration);
  return { identified: identified.slice(0, 5), unidentified: unidentified.slice(0, 5) };
}

// ── PUPPETEER LAUNCH HELPER ──────────────────────────────
function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu',
           '--disable-ipv6','--proxy-server="direct://"','--proxy-bypass-list=*']
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const sendSse = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
};

async function handleModals(page, log) {
  try {
    const btn = await page.waitForSelector(
      '[id*="onetrust-accept-btn-handler"],[aria-label*="accept"],[aria-label*="Accept"],[class*="cookie-accept"],[id*="cookie-accept"]',
      { timeout: 3000 }
    );
    if (btn) { await btn.click(); await page.waitForTimeout(1000); log('[System] Modal dismissed.'); }
  } catch { log('[System] No modal found. Proceeding.'); }
}

// ════════════════════════════════════════════════════════
// SHOPIFY ADMIN APP SCAN: /scan-apps-api
// Uses Shopify Admin GraphQL to get REAL installed apps.
// This replaces puppeteer-based app detection for accuracy.
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// SHOPIFY ADMIN APP SCAN: /scan-apps-api
// Uses Shopify Admin GraphQL to get REAL installed apps.
// This replaces puppeteer-based app detection for accuracy.
// ════════════════════════════════════════════════════════
app.get('/scan-apps-api', async (req, res) => {
  const { storeUrl, adminToken: reqAdminToken } = req.query;
  if (!storeUrl) return res.status(400).json({ error: 'storeUrl is required' });

  // Use token from request OR fall back to env
  const token = reqAdminToken || adminToken;
  const host  = storeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (message, type = 'info') => {
    console.log(message);
    sendSse(res, 'log', { message, type });
  };

  try {
    if (!token) throw new Error('No Shopify Admin Token provided. Enter it in the shpat_... field or set SHOPIFY_ADMIN_TOKEN in .env');

    log('[Apps API] Connecting to Shopify Admin API...', 'info');

    // ── 1. Fetch installed apps via GraphQL (FIXED QUERY) ──────────────
    const gqlRes = await axios({
      url: `https://${host}/admin/api/2025-01/graphql.json`,
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
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
      })
    });

    const gqlErrors = gqlRes.data?.errors;
    if (gqlErrors?.length) throw new Error(gqlErrors.map(e => e.message).join('; '));

    const edges = gqlRes.data?.data?.appInstallations?.edges || [];
    if (!edges.length) throw new Error('No app installations found. Ensure your Admin Token has the read_apps scope.');

    log(`[Apps API] Found ${edges.length} installed apps. Enriching with database...`, 'success');

    // ── 2. Enrich each app with fingerprint DB data ───────
    const enrichedApps = edges.map(edge => {
      const shopifyApp = edge.node.app;
      const name       = shopifyApp.title || 'Unknown App';
      const nameLower  = name.toLowerCase();

      // Match against fingerprintDatabase by name similarity
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

      const category      = dbMatch?.data?.category || inferCategoryFromApp(name, shopifyApp.developerName || '');
      const impact        = getImpactForCategory(category);
      const recommendation = dbMatch?.data?.recommendation || getDefaultRecommendation(category);

      return {
        name,
        handle:          shopifyApp.handle || '',
        developer:       shopifyApp.developerName || 'Unknown',
        icon:            dbMatch?.data?.icon || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png',
        category,
        pricingSummary:  'Pricing info unavailable via API',
        description:     shopifyApp.description || '',
        appStoreUrl:     shopifyApp.appStoreAppUrl || `https://apps.shopify.com/${shopifyApp.handle || ''}`,
        recommendation,
        impact,
        // Size/duration not available from API — set 0 so UI renders without errors
        totalSizeKb:        0,
        totalDurationMs:    0,
        assetCount:         0,
        assets:             [],
        estimatedSavingsMs: 0,
        source: 'api',
      };
    });

    // ── 3. Sort: high impact first then alphabetical ──────
    const impactOrder = { High: 3, Medium: 2, Low: 1 };
    enrichedApps.sort((a, b) =>
      (impactOrder[b.impact] || 0) - (impactOrder[a.impact] || 0) ||
      a.name.localeCompare(b.name)
    );

    // ── 4. Executive summary ──────────────────────────────
    const highImpact = enrichedApps.filter(a => a.impact === 'High').length;
    const executiveSummary = {
      totalAppsDetected: enrichedApps.length,
      totalAppSizeMb:    0,
      totalRequests:     0,
      highImpactApps:    highImpact,
      source:            'shopify_admin_api',
    };

    const appReport = {
      storeUrl:            `https://${host}`,
      executiveSummary,
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
  } finally {
    res.end();
  }
});

// ── HELPERS for /scan-apps-api ───────────────────────────
function inferCategoryFromApp(name, developer) {
  const n = (name + ' ' + developer).toLowerCase();
  if (n.match(/review|rating|yotpo|stamped|judge\.me|okendo|loox/)) return 'Reviews';
  if (n.match(/email|klaviyo|mailchimp|omnisend|drip|sms|attentive|postscript/)) return 'Email & Marketing';
  if (n.match(/analytic|pixel|hotjar|segment|tracking|lucky orange|clarity/)) return 'Analytics';
  if (n.match(/chat|support|helpdesk|gorgias|zendesk|reamaze|tidio/)) return 'Customer Service';
  if (n.match(/upsell|cross.sell|bundle|frequently bought|zipify|reconvert/)) return 'Upsell & Cross-sell';
  if (n.match(/page builder|pagefly|gempages|shogun|layout|sections/)) return 'Page Builder';
  if (n.match(/subscri|recharge|bold sub|appstle|recurring|paywhirl/)) return 'Subscriptions';
  if (n.match(/loyal|reward|points|referral|smile\.io|growave|yotpo loyal/)) return 'Loyalty & Rewards';
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
  if (n.match(/accessib|wcag|ada|wave/)) return 'Accessibility';
  return 'Utilities';
}

function getImpactForCategory(category) {
  const highImpact = ['Analytics', 'Email & Marketing', 'Reviews', 'Page Builder', 'Subscriptions', 'Upsell & Cross-sell'];
  const medImpact  = ['Customer Service', 'Loyalty & Rewards', 'Pop-ups & Notifications', 'Navigation & UI', 'Social Media', 'Translation'];
  if (highImpact.includes(category)) return 'High';
  if (medImpact.includes(category))  return 'Medium';
  return 'Low';
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
    'Loyalty & Rewards':      'Loyalty widgets are safe to lazy-load — defer their initialisation.',
    'Pop-ups & Notifications':'Defer pop-up scripts by 3–5 seconds to avoid TBT impact.',
    'Shipping & Fulfillment': 'Fulfillment apps are mostly backend — minimal frontend impact expected.',
    'SEO & Image Optimization':'SEO apps should not add render-blocking scripts to the storefront.',
    'Returns & Exchanges':    'Load return portals on-demand rather than on every page load.',
    'Social Media':           'Use native lazy loading for social feed embeds.',
    'Translation':            'Ensure language switcher scripts are deferred.',
  };
  return recs[category] || 'Monitor this app\'s impact on page load and remove it if no longer needed.';
}

// ════════════════════════════════════════════════════════
// MAIN SCAN: /scan-all
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

  let browser, errorOccurred = false;
  try {
    log('[System] Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setCacheEnabled(false);

    log('[System] Navigating to store...');
    await page.goto(storeUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    if (storePassword) {
      try {
        const input = await page.$('input[type="password"]');
        if (input) {
          await input.type(storePassword);
          await page.click('button[type="submit"]');
          await page.waitForNavigation({ waitUntil: 'networkidle2' });
        }
      } catch {}
    }

    await handleModals(page, log);
    const fingerprintMap = buildFingerprintMap();

    let appReport  = { executiveSummary: {}, appBreakdown: [], topCulprits: [] };
    let perfReport = { success: false, metrics: null, categories: null, audits: null, culprits: null };

    if (runAppScan === 'true') {
      log('[App] Running app scan...');
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
        lcp: audits['largest-contentful-paint']?.displayValue ?? 'N/A',
        cls: audits['cumulative-layout-shift']?.displayValue ?? 'N/A',
        tbt: audits['total-blocking-time']?.displayValue ?? 'N/A',
        fcp: audits['first-contentful-paint']?.displayValue ?? 'N/A',
        speedIndex: audits['speed-index']?.displayValue ?? 'N/A',
        inp: audits['interaction-to-next-paint']?.displayValue ?? 'N/A',
        performanceScore: Math.round(lhr.categories.performance.score * 100),
        device: device || 'desktop',
      };
      const categories = {
        performance:     lhr.categories.performance,
        accessibility:   lhr.categories.accessibility,
        'best-practices':lhr.categories['best-practices'],
        seo:             lhr.categories.seo,
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
    console.error(error);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    if (browser) await browser.close();
    if (!errorOccurred) sendSse(res, 'scanComplete', { message: 'Done' });
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// SPEED-ONLY SCAN: /scan-speed
// ════════════════════════════════════════════════════════
app.get('/scan-speed', async (req, res) => {
  const { storeUrl, storePassword, device } = req.query;
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

  let browser, errorOccurred = false;
  try {
    log('[Speed] Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setCacheEnabled(false);

    log('[Speed] Navigating to store...');
    await page.goto(storeUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    if (storePassword) {
      try {
        const input = await page.$('input[type="password"]');
        if (input) {
          await input.type(storePassword);
          await page.click('button[type="submit"]');
          await page.waitForNavigation({ waitUntil: 'networkidle2' });
        }
      } catch {}
    }

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
      lcp: audits['largest-contentful-paint']?.displayValue ?? 'N/A',
      cls: audits['cumulative-layout-shift']?.displayValue ?? 'N/A',
      tbt: audits['total-blocking-time']?.displayValue ?? 'N/A',
      fcp: audits['first-contentful-paint']?.displayValue ?? 'N/A',
      speedIndex: audits['speed-index']?.displayValue ?? 'N/A',
      inp: audits['interaction-to-next-paint']?.displayValue ?? 'N/A',
      performanceScore: Math.round(lhr.categories.performance.score * 100),
      device: device || 'desktop',
    };
    const categories = {
      performance:     lhr.categories.performance,
      accessibility:   lhr.categories.accessibility,
      'best-practices':lhr.categories['best-practices'],
      seo:             lhr.categories.seo,
    };
    const culprits = findCulprits(audits, fingerprintMap);
    const perfReport = { success: true, metrics, categories, audits, culprits };

    sendSse(res, 'speedResult', perfReport);
    log('[Speed] Lighthouse scan complete.');

  } catch (error) {
    errorOccurred = true;
    console.error(error);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    if (browser) await browser.close();
    if (!errorOccurred) sendSse(res, 'scanComplete', { message: 'Done' });
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// IMAGE OPTIMIZER: /scan-images
// ════════════════════════════════════════════════════════
app.get('/scan-images', async (req, res) => {
  const { storeUrl, storePassword } = req.query;
  if (!storeUrl) return res.status(400).json({ error: 'storeUrl is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (msg) => { console.log(msg); sendSse(res, 'log', { message: msg }); };

  let browser;
  try {
    log('[Images] Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCacheEnabled(false);

    const imageSizeMap = new Map();
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

    log('[Images] Navigating to store...');
    await page.goto(storeUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    if (storePassword) {
      try {
        const input = await page.$('input[type="password"]');
        if (input) {
          await input.type(storePassword);
          await page.click('button[type="submit"]');
          await page.waitForNavigation({ waitUntil: 'networkidle2' });
        }
      } catch {}
    }

    log('[Images] Reloading page to capture network sizes...');
    try { await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }); } catch {}
    page.removeAllListeners('response');

    log('[Images] Analyzing images in DOM...');
    const rawImages = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img')).map(img => ({
        src: img.currentSrc || img.src || '',
        alt: img.alt || '',
        hasAlt: (img.alt || '').trim() !== '',
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        displayWidth: Math.round(img.getBoundingClientRect().width),
        displayHeight: Math.round(img.getBoundingClientRect().height),
        loading: img.loading || 'eager',
      }));
    });

    log(`[Images] Found ${rawImages.length} images. Processing...`);

    let missingAlt = 0, oversized = 0, largeFiles = 0, nonModern = 0;
    let totalSizeBytes = 0, potentialSavingsBytes = 0;

    const processed = rawImages
      .filter(img => img.src && !img.src.startsWith('data:') && img.src.startsWith('http'))
      .map(img => {
        const sizeBytes = imageSizeMap.get(img.src) || 0;
        const sizeKb = +(sizeBytes / 1024).toFixed(1);
        totalSizeBytes += sizeBytes;

        const issues = [];
        if (!img.hasAlt) { issues.push('missing-alt'); missingAlt++; }
        const isOversized = img.naturalWidth > 0 && img.displayWidth > 0
          && img.naturalWidth > img.displayWidth * 2 && img.naturalWidth > 200;
        if (isOversized) { issues.push('oversized'); oversized++; }
        if (sizeKb > 500) { issues.push('large-file'); largeFiles++; }
        const isModern = /\.(webp|avif)(\?|$)/i.test(img.src);
        if (!isModern && sizeBytes > 0) { issues.push('non-modern'); nonModern++; }

        let savingsBytes = 0;
        if (isOversized)  savingsBytes += sizeBytes * 0.35;
        if (!isModern)    savingsBytes += sizeBytes * 0.25;
        if (sizeKb > 500) savingsBytes += sizeBytes * 0.40;
        potentialSavingsBytes += savingsBytes;

        return {
          src: img.src, thumb: img.src, alt: img.alt, hasAlt: img.hasAlt,
          naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
          displayWidth: img.displayWidth, sizeKb, issues, isOversized, isModern,
          loading: img.loading,
        };
      })
      .filter(img => img.issues.length > 0 || img.sizeKb > 100);

    const issuePoints = missingAlt * 3 + oversized * 5 + largeFiles * 8 + nonModern * 2;
    const score = Math.max(0, Math.min(100, 100 - Math.round(issuePoints / Math.max(rawImages.length, 1) * 10)));
    const scoreGrade = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';

    const result = {
      score, scoreGrade,
      totalImages: rawImages.length, imagesWithIssues: processed.length,
      missingAlt, oversized, largeFiles, nonModern,
      totalSizeMb: +(totalSizeBytes / 1024 / 1024).toFixed(2),
      potentialSavingsKb: Math.round(potentialSavingsBytes / 1024),
      afterOptimizationMb: +((totalSizeBytes - potentialSavingsBytes) / 1024 / 1024).toFixed(2),
      images: processed.slice(0, 60),
    };

    log(`[Images] Scan complete. Score: ${score}/100.`);
    sendSse(res, 'imageResult', result);
    sendSse(res, 'scanComplete', { message: 'Image scan complete.' });

  } catch (error) {
    console.error('[Images] Error:', error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    if (browser) await browser.close();
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// GHOST CODE SCANNER: /scan-ghost-code
// ════════════════════════════════════════════════════════
app.get('/scan-ghost-code', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (msg) => { console.log(msg); sendSse(res, 'log', { message: msg }); };

  try {
    if (!adminToken || !globalStoreUrl) throw new Error('SHOPIFY_ADMIN_TOKEN or SHOPIFY_STORE_URL not set in .env');

    const shopify = axios.create({
      baseURL: shopifyApiUrl,
      headers: { 'X-Shopify-Access-Token': adminToken, 'Content-Type': 'application/json' }
    });

    log('[Ghost] Fetching installed apps list...');
    let installedAppNames = [];
    let installedAppHandles = [];
    try {
      const gqlRes = await axios({
        url: `https://${globalStoreUrl}/admin/api/2024-01/graphql.json`,
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': adminToken, 'Content-Type': 'application/json' },
        data: JSON.stringify({ query: `{ appInstallations(first:50) { edges { node { app { title developerName } } } } }` })      });
      const edges = gqlRes.data?.data?.appInstallations?.edges || [];
      installedAppNames = edges.map(e => e.node.app.title.toLowerCase());
      installedAppHandles = edges.map(e => (e.node.app.handle || '').toLowerCase());
      log(`[Ghost] Found ${installedAppNames.length} installed apps.`);
    } catch (err) {
      log('[Ghost] Could not fetch installed apps (optional). Continuing...');
    }

    log('[Ghost] Fetching main theme...');
    const themeRes = await shopify.get('/themes.json?role=main');
    const mainTheme = themeRes.data.themes[0];
    if (!mainTheme) throw new Error('No main theme found.');
    log(`[Ghost] Theme: ${mainTheme.name} (ID: ${mainTheme.id})`);

    log('[Ghost] Fetching theme asset list...');
    const assetListRes = await shopify.get(`/themes/${mainTheme.id}/assets.json`);
    const liquidFiles = assetListRes.data.assets.filter(a => a.key.endsWith('.liquid'));
    log(`[Ghost] Scanning ${liquidFiles.length} liquid files...`);

    const fingerprintMap = buildFingerprintMap();
    const detectedApps = new Map();

    for (const file of liquidFiles) {
      let content = '';
      try {
        const fileRes = await shopify.get(`/themes/${mainTheme.id}/assets.json?asset[key]=${encodeURIComponent(file.key)}`);
        content = fileRes.data.asset?.value || '';
      } catch { continue; }
      if (!content) continue;

      for (const [fingerprint, appInfo] of fingerprintMap.entries()) {
        if (content.includes(fingerprint)) {
          const key = appInfo.name;
          if (!detectedApps.has(key)) {
            const appWords = appInfo.name.toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 3);
            const isInstalled = installedAppNames.some(name => {
              return appWords.some(w => name.includes(w));
            }) || installedAppHandles.some(handle => {
              return appWords.some(w => handle.includes(w));
            });

            let wastedKb = 0;
            try {
              const asset = assetListRes.data.assets.find(a => a.key === file.key);
              wastedKb = asset ? Math.round((asset.size || 0) / 1024) : 0;
            } catch {}

            detectedApps.set(key, {
              name: appInfo.name,
              icon: appInfo.icon,
              category: appInfo.category || 'Uncategorized',
              files: new Set(),
              fingerprint,
              isInstalled,
              confidence: isInstalled ? 15 : 85,
              wastedKb,
            });
          }
          detectedApps.get(key).files.add(file.key);
        }
      }
    }

    const foundApps = Array.from(detectedApps.values()).map(app => ({
      ...app,
      files: Array.from(app.files),
      fileCount: app.files.size,
    }));

    foundApps.sort((a, b) => {
      if (!a.isInstalled && b.isInstalled) return -1;
      if (a.isInstalled && !b.isInstalled) return 1;
      return b.confidence - a.confidence;
    });

    const ghostCount = foundApps.filter(a => !a.isInstalled).length;
    const totalWastedKb = foundApps.filter(a => !a.isInstalled).reduce((s, a) => s + (a.wastedKb || 0), 0);

    log(`[Ghost] Scan complete. ${ghostCount} ghost scripts out of ${foundApps.length} total matches.`);

    sendSse(res, 'ghostResult', { apps: foundApps, ghostCount, totalWastedKb, theme: mainTheme.name });
    sendSse(res, 'scanComplete', { message: `Ghost scan done. ${ghostCount} ghost script(s) detected.` });

  } catch (error) {
    console.error('[Ghost] Error:', error.response?.data || error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
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

  let browser;
  try {
    const { storeUrl, storePassword } = req.query;
    if (!storeUrl) throw new Error('storeUrl is required');

    log('[Fonts] Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setCacheEnabled(false);

    const fontRequests = [];
    page.on('response', async (response) => {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url) || ct.includes('font')) {
        const headers = response.headers();
        let sizeBytes = parseInt(headers['content-length'] || 0, 10);
        if (!sizeBytes) {
          try { const buf = await response.buffer(); sizeBytes = buf.length; } catch {}
        }
        fontRequests.push({
          url,
          sizeKb: +(sizeBytes / 1024).toFixed(1),
          format: url.match(/\.(woff2?|ttf|otf|eot)/i)?.[1]?.toLowerCase() || 'unknown',
          isGoogleFont: url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com'),
          status: response.status(),
        });
      }
    });

    log('[Fonts] Navigating to store...');
    await page.goto(storeUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    if (storePassword) {
      try {
        const input = await page.$('input[type="password"]');
        if (input) {
          await input.type(storePassword);
          await page.click('button[type="submit"]');
          await page.waitForNavigation({ waitUntil: 'networkidle2' });
        }
      } catch {}
    }

    log('[Fonts] Analysing font usage in DOM...');
    const fontData = await page.evaluate(() => {
      const fonts = [];
      const seen = new Set();
      document.fonts.forEach(font => {
        const key = `${font.family}|${font.weight}|${font.style}`;
        if (!seen.has(key)) {
          seen.add(key);
          fonts.push({ family: font.family, weight: font.weight, style: font.style, status: font.status });
        }
      });
      const googleFontLinks = Array.from(document.querySelectorAll('link[href*="fonts.googleapis.com"]')).map(l => l.href);
      const fontDisplayIssues = [];
      try {
        Array.from(document.styleSheets).forEach(sheet => {
          try {
            Array.from(sheet.cssRules || []).forEach(rule => {
              if (rule instanceof CSSFontFaceRule) {
                const display = rule.style.getPropertyValue('font-display');
                const src = rule.style.getPropertyValue('src');
                if (!display || display === 'auto' || display === 'block') {
                  fontDisplayIssues.push({ src: src.slice(0, 100), display: display || 'not set' });
                }
              }
            });
          } catch {}
        });
      } catch {}
      const renderBlockingFonts = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        .filter(l => l.href.includes('font')).map(l => ({ href: l.href, hasPreload: false }));
      const preloadedFonts = Array.from(document.querySelectorAll('link[rel="preload"][as="font"]')).map(l => l.href);
      return { fonts, googleFontLinks, fontDisplayIssues, renderBlockingFonts, preloadedFonts };
    });

    page.removeAllListeners('response');

    const uniqueFontRequests = [];
    const seenUrls = new Set();
    for (const f of fontRequests) {
      if (!seenUrls.has(f.url)) { seenUrls.add(f.url); uniqueFontRequests.push(f); }
    }

    const issues = [], recommendations = [];
    let score = 100;

    const googleFonts = uniqueFontRequests.filter(f => f.isGoogleFont);
    const selfHosted  = uniqueFontRequests.filter(f => !f.isGoogleFont);
    const nonWoff2    = uniqueFontRequests.filter(f => f.format !== 'woff2' && !f.url.includes('fonts.gstatic.com'));
    const heavyFonts  = uniqueFontRequests.filter(f => f.sizeKb > 60);

    if (googleFonts.length > 0) { issues.push({ type: 'google-fonts', severity: 'warn', message: `${googleFonts.length} Google Font(s) loaded from external CDN — causes extra DNS lookup & render blocking` }); recommendations.push('Self-host Google Fonts to eliminate external DNS lookups and improve LCP'); score -= 15; }
    if (fontData.fontDisplayIssues.length > 0) { issues.push({ type: 'no-font-display', severity: 'error', message: `${fontData.fontDisplayIssues.length} font(s) missing font-display: swap — causes invisible text (FOIT)` }); recommendations.push('Add font-display: swap to all @font-face declarations to prevent invisible text'); score -= 20; }
    if (fontData.preloadedFonts.length === 0 && uniqueFontRequests.length > 0) { issues.push({ type: 'no-preload', severity: 'warn', message: 'No fonts are preloaded — fonts discovered late cause layout shifts' }); recommendations.push('Add <link rel="preload" as="font"> for your primary fonts in <head>'); score -= 10; }
    if (nonWoff2.length > 0) { issues.push({ type: 'non-woff2', severity: 'warn', message: `${nonWoff2.length} font(s) not in WOFF2 format — WOFF2 is 30% smaller than WOFF` }); recommendations.push('Convert all fonts to WOFF2 format for maximum compression'); score -= 10; }
    if (heavyFonts.length > 0) { issues.push({ type: 'heavy-fonts', severity: 'warn', message: `${heavyFonts.length} font file(s) over 60KB — consider subsetting` }); recommendations.push('Use Unicode range subsetting to only load the characters you need'); score -= 5 * heavyFonts.length; }
    if (fontData.fonts.length > 6) { issues.push({ type: 'too-many-fonts', severity: 'info', message: `${fontData.fonts.length} font variants loaded — consider reducing to 2-3` }); recommendations.push('Limit font variants to reduce total font payload'); score -= 5; }

    score = Math.max(0, Math.min(100, score));
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
    const totalFontSizeKb = uniqueFontRequests.reduce((s, f) => s + f.sizeKb, 0);

    const result = {
      score, grade,
      totalFonts: fontData.fonts.length,
      totalFontFiles: uniqueFontRequests.length,
      googleFonts: googleFonts.length,
      selfHosted: selfHosted.length,
      totalSizeKb: +totalFontSizeKb.toFixed(1),
      preloaded: fontData.preloadedFonts.length,
      issues: issues.length,
      fontFaceIssues: fontData.fontDisplayIssues.length,
      fonts: fontData.fonts,
      fontFiles: uniqueFontRequests,
      issueList: issues,
      recommendations,
      estimatedSavingsMs: issues.length > 0 ? Math.round(issues.length * 120) : 0,
    };

    log(`[Fonts] Done. Score: ${score}/100, ${issues.length} issues found.`);
    sendSse(res, 'fontResult', result);
    sendSse(res, 'scanComplete', { message: 'Font scan complete.' });

  } catch (error) {
    console.error('[Fonts] Error:', error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    if (browser) await browser.close();
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

  let browser;
  try {
    const { storeUrl, storePassword } = req.query;
    if (!storeUrl) throw new Error('storeUrl is required');

    log('[CSS] Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setCacheEnabled(false);

    const cssFiles = new Map();
    page.on('response', async (response) => {
      const url = response.url();
      const ct  = response.headers()['content-type'] || '';
      if (!/\.css(\?|$)/i.test(url) && !ct.includes('text/css')) return;
      if (cssFiles.has(url)) return;
      try {
        const headers = response.headers();
        let sizeBytes = parseInt(headers['content-length'] || 0, 10);
        if (!sizeBytes) { try { const buf = await response.buffer(); sizeBytes = buf.length; } catch {} }
        cssFiles.set(url, { url, sizeBytes, sizeKb: +(sizeBytes / 1024).toFixed(1) });
      } catch {}
    });

    log('[CSS] Navigating to store...');
    await page.goto(storeUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    if (storePassword) {
      try {
        const input = await page.$('input[type="password"]');
        if (input) {
          await input.type(storePassword);
          await page.click('button[type="submit"]');
          await page.waitForNavigation({ waitUntil: 'networkidle2' });
        }
      } catch {}
    }

    page.removeAllListeners('response');
    log('[CSS] Analysing CSS coverage and rules...');

    await page.coverage.startCSSCoverage();
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    const cssCoverage = await page.coverage.stopCSSCoverage();

    let totalBytes = 0, usedBytes = 0, totalRules = 0;
    const fileBreakdown = [];

    for (const entry of cssCoverage) {
      const entryTotal = entry.text ? entry.text.length : 0;
      let entryUsed = 0;
      for (const range of entry.ranges) { entryUsed += range.end - range.start; }
      totalBytes += entryTotal;
      usedBytes  += entryUsed;
      const ruleCount = (entry.text || '').split('{').length - 1;
      totalRules += ruleCount;
      const unusedPct = entryTotal > 0 ? Math.round((1 - entryUsed / entryTotal) * 100) : 0;
      const sizeKb    = +(entryTotal / 1024).toFixed(1);
      const savingsKb = +((entryTotal - entryUsed) / 1024).toFixed(1);
      let fileName = entry.url;
      try { fileName = new URL(entry.url).pathname.split('/').pop() || entry.url; } catch {}
      fileBreakdown.push({ url: entry.url, fileName, sizeKb, unusedPct, savingsKb, rules: ruleCount });
    }

    fileBreakdown.sort((a, b) => b.savingsKb - a.savingsKb);

    const unusedPct     = totalBytes > 0 ? Math.round((1 - usedBytes / totalBytes) * 100) : 0;
    const totalSizeKb   = +(totalBytes / 1024).toFixed(1);
    const potentialSave = +((totalBytes - usedBytes) / 1024).toFixed(1);

    const domAnalysis = await page.evaluate(() => {
      const blocking = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).filter(l => !l.media || l.media === 'all' || l.media === 'screen').map(l => l.href);
      const inlineStyles = document.querySelectorAll('[style]').length;
      const hasInlineStyle = document.querySelector('style') !== null;
      const inlineStyleSize = Array.from(document.querySelectorAll('style')).reduce((s, el) => s + (el.textContent || '').length, 0);
      return { blocking: blocking.length, inlineStyles, hasInlineStyle, inlineStyleSizeKb: +(inlineStyleSize / 1024).toFixed(1) };
    });

    let score = 100;
    if (unusedPct > 60) score -= 30; else if (unusedPct > 40) score -= 20; else if (unusedPct > 20) score -= 10;
    if (totalSizeKb > 500) score -= 20; else if (totalSizeKb > 200) score -= 10;
    if (domAnalysis.blocking > 3) score -= 10;
    score = Math.max(0, Math.min(100, score));
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';

    const recommendations = [];
    if (unusedPct > 30) recommendations.push('Remove unused CSS — consider PurgeCSS or Shopify theme CSS optimization');
    if (domAnalysis.blocking > 2) recommendations.push('Reduce render-blocking stylesheets by inlining critical CSS');
    if (totalSizeKb > 200) recommendations.push('Minify CSS files to reduce transfer size');
    if (fileBreakdown.some(f => f.unusedPct > 70)) recommendations.push('Some CSS files are >70% unused — consider splitting or removing them');

    const result = { score, grade, totalSizeKb, totalRules, unusedPct, potentialSaveKb: potentialSave, afterOptKb: +(usedBytes / 1024).toFixed(1), blockingSheets: domAnalysis.blocking, inlineStyles: domAnalysis.inlineStyles, inlineStyleSizeKb: domAnalysis.inlineStyleSizeKb, fileCount: fileBreakdown.length, files: fileBreakdown.slice(0, 20), recommendations };

    log(`[CSS] Done. Score: ${score}/100, ${unusedPct}% unused CSS.`);
    sendSse(res, 'cssResult', result);
    sendSse(res, 'scanComplete', { message: 'CSS analysis complete.' });

  } catch (error) {
    console.error('[CSS] Error:', error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    if (browser) await browser.close();
    res.end();
  }
});

// ── SERVE FRONTEND ────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend', 'server.html'));
});

// ── API APP SCAN (legacy endpoint) ──────────────────────
app.get('/api-app-scan', async (req, res) => {
  try {
    if (!adminToken || !globalStoreUrl) return res.status(400).json({ error: 'Credentials missing in .env' });
    const response = await axios({
      url: `https://${globalStoreUrl}/admin/api/2024-01/graphql.json`,
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': adminToken, 'Content-Type': 'application/json' },
      data: JSON.stringify({ query: `{ appInstallations(first:50) { edges { node { app { title developerName } } } } }` })
    });
    const installedApps = response.data.data.appInstallations.edges.map(e => e.node.app.title);
    let report = { total_installed: installedApps.length, categories: {}, uncategorized: [] };
    installedApps.forEach(appName => {
      let cat = null;
      for (const [dbName, dbData] of Object.entries(FINGERPRINT_DB)) {
        if (appName.toLowerCase().includes(dbName.toLowerCase()) || dbName.toLowerCase().includes(appName.toLowerCase())) {
          cat = dbData.category; break;
        }
      }
      if (cat) {
        if (!report.categories[cat]) report.categories[cat] = { count: 0, apps: [] };
        report.categories[cat].count++;
        report.categories[cat].apps.push(appName);
      } else { report.uncategorized.push(appName); }
    });
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch apps' });
  }
});

app.listen(port, () => console.log(`[Server] App Auditor running at http://localhost:${port}`));
