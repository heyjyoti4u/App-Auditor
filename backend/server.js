import '@shopify/shopify-api/adapters/node';
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
import mongoose from 'mongoose';

dotenv.config();

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('[Server] MongoDB Connected'))
  .catch(err => console.error('[Server] DB Error:', err));

const storeSchema = new mongoose.Schema({
  shop:        { type: String, required: true, unique: true },
  accessToken: { type: String, required: true },
  isActive:    { type: Boolean, default: true }
});
const Store = mongoose.model('Store', storeSchema);

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const ENV_ADMIN_TOKEN    = process.env.SHOPIFY_ADMIN_TOKEN;
const ENV_STORE_URL      = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_API_KEY    = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL            = process.env.APP_URL;

// ── iframe fix ────────────────────────────────────────────
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors https://admin.shopify.com https://*.myshopify.com 'self';");
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ── FINGERPRINT DB ───────────────────────────────────────
const dbPath = path.join(__dirname, 'fingerprintDatabase.json');
let FINGERPRINT_DB = {};
(async () => {
  try {
    FINGERPRINT_DB = JSON.parse(await fs.readFile(dbPath, 'utf-8'));
    console.log('[Server] Fingerprint DB loaded.');
  } catch (e) { console.error('[Server] Failed to load fingerprint DB:', e.message); }
})();

// ── HELPERS ──────────────────────────────────────────────
function buildFingerprintMap() {
  const map = new Map();
  for (const [appName, appData] of Object.entries(FINGERPRINT_DB)) {
    if (!appData || !Array.isArray(appData.fingerprints) || !appData.fingerprints.length) continue;
    for (const fp of appData.fingerprints)
      map.set(fp, { name: appName, icon: appData.icon, recommendation: appData.recommendation, category: appData.category || 'Uncategorized' });
  }
  return map;
}

function normalizeUrl(raw) {
  if (!raw) return '';
  const s = raw.trim();
  return (s.startsWith('http://') || s.startsWith('https://')) ? s : 'https://' + s;
}

function extractHostname(urlOrHost) {
  let s = (urlOrHost || '').trim();
  if (!s.startsWith('http')) s = 'https://' + s;
  try { return new URL(s).hostname.toLowerCase().replace(/\/$/, ''); }
  catch { return s.replace(/^https?:\/\//, '').split('/')[0].toLowerCase(); }
}

// ── KEY FIX: ENV token is ALWAYS PRIMARY ─────────────────
// Shopify deprecated "offline" OAuth tokens. The SHOPIFY_ADMIN_TOKEN
// in .env is a custom app token that NEVER expires. Use it first.
async function resolveToken(hostname) {
  // 1. ENV token is PRIMARY — it's a custom app token, never expires
  if (ENV_ADMIN_TOKEN) {
    console.log(`[Token] ✅ Using ENV_ADMIN_TOKEN (primary) for ${hostname}`);
    return { token: ENV_ADMIN_TOKEN, source: 'env' };
  }

  // 2. Only fall back to DB if no ENV token
  try {
    const storeData = await Store.findOne({ shop: { $regex: new RegExp(`^${hostname}$`, 'i') } });
    if (storeData?.accessToken) {
      console.log(`[Token] DB token found for ${hostname}`);
      return { token: storeData.accessToken, source: 'oauth-db' };
    }
  } catch (e) { console.log(`[Token] DB error: ${e.message}`); }

  console.log(`[Token] ❌ No token for ${hostname}`);
  return { token: null, source: 'none' };
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
      ex ? (ex.duration += dur, ex.scriptCount++) :
           identified.push({ appName: matched.name, icon: matched.icon, duration: dur, scriptCount: 1 });
    } else if (item.url) { unidentified.push({ url: item.url, duration: dur }); }
  }
  identified.sort((a, b) => b.duration - a.duration);
  unidentified.sort((a, b) => b.duration - a.duration);
  return { identified: identified.slice(0, 5), unidentified: unidentified.slice(0, 5) };
}

function buildAppPerfMap(audits, fingerprintMap) {
  const perfMap = new Map();
  const bootup  = audits['bootup-time'];
  if (bootup?.details?.items) {
    for (const item of bootup.details.items) {
      for (const [fp, info] of fingerprintMap.entries()) {
        if (item.url.includes(fp)) {
          const key = info.name;
          if (!perfMap.has(key)) perfMap.set(key, { totalSizeKb: 0, totalDurationMs: 0, assets: [] });
          perfMap.get(key).totalDurationMs += item.scripting || 0;
          break;
        }
      }
    }
  }
  const netReqs = audits['network-requests'];
  if (netReqs?.details?.items) {
    for (const item of netReqs.details.items) {
      const url = item.url || '';
      if (!/\.(js|css)(\?|$)/i.test(url)) continue;
      for (const [fp, info] of fingerprintMap.entries()) {
        if (url.includes(fp)) {
          const key = info.name;
          if (!perfMap.has(key)) perfMap.set(key, { totalSizeKb: 0, totalDurationMs: 0, assets: [] });
          const e   = perfMap.get(key);
          const skb = +((item.transferSize || 0) / 1024).toFixed(2);
          const dms = +(item.networkRequestTime || 0).toFixed(2);
          e.totalSizeKb     += skb;
          e.totalDurationMs += dms;
          e.assets.push({ url, type: /\.js(\?|$)/i.test(url) ? 'JS' : 'CSS', sizeKb: skb, durationMs: dms });
          break;
        }
      }
    }
  }
  return perfMap;
}

function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--proxy-server=direct://','--proxy-bypass-list=*']
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

function startHeartbeat(res, ms = 15000) {
  const iv = setInterval(() => {
    if (res.writableEnded) { clearInterval(iv); return; }
    try { res.write(': heartbeat\n\n'); if (typeof res.flush === 'function') res.flush(); }
    catch { clearInterval(iv); }
  }, ms);
  return iv;
}

function sseHeaders(res, req) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (req?.socket) { req.socket.setTimeout(0); req.socket.setNoDelay(true); req.socket.setKeepAlive(true, 0); }
  res.flushHeaders();
}

const sendSse = (res, event, data) => {
  if (res.writableEnded) return;
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); if (typeof res.flush === 'function') res.flush(); }
  catch {}
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
    const btn = await page.waitForSelector('[id*="onetrust-accept-btn-handler"],[aria-label*="accept"],[class*="cookie-accept"]', { timeout: 3000 });
    if (btn) { await btn.click(); await new Promise(r => setTimeout(r, 800)); if (log) log('[System] Modal dismissed.'); }
  } catch { if (log) log('[System] No modal. Proceeding.'); }
}

function inferCategoryFromApp(name, dev = '') {
  const n = (name + ' ' + dev).toLowerCase();
  if (n.match(/review|rating|yotpo|stamped|judge\.me|okendo|loox/))  return 'Reviews';
  if (n.match(/email|klaviyo|mailchimp|omnisend|sms|attentive/))      return 'Email & Marketing';
  if (n.match(/analytic|pixel|hotjar|segment|tracking/))              return 'Analytics';
  if (n.match(/chat|support|helpdesk|gorgias|zendesk|tidio/))         return 'Customer Service';
  if (n.match(/upsell|cross.sell|bundle|zipify|reconvert/))           return 'Upsell & Cross-sell';
  if (n.match(/page builder|pagefly|gempages|shogun/))                return 'Page Builder';
  if (n.match(/subscri|recharge|appstle|recurring/))                  return 'Subscriptions';
  if (n.match(/loyal|reward|points|referral|smile\.io/))              return 'Loyalty & Rewards';
  if (n.match(/shipping|fulfil|shipstation|easyship/))                return 'Shipping & Fulfillment';
  if (n.match(/payment|checkout|klarna|afterpay/))                    return 'Payments';
  if (n.match(/seo|image optim|compress|alt text/))                   return 'SEO & Image Optimization';
  if (n.match(/pop.?up|popup|notification|privy/))                    return 'Pop-ups & Notifications';
  if (n.match(/inventory|stock|back in stock/))                       return 'Inventory & Alerts';
  if (n.match(/return|exchange|refund/))                              return 'Returns & Exchanges';
  if (n.match(/social|instagram|facebook|tiktok/))                    return 'Social Media';
  if (n.match(/translat|langify|weglot/))                             return 'Translation';
  if (n.match(/trust|badge|security/))                                return 'Trust & Security';
  if (n.match(/option|variant|customiz/))                             return 'Product Options';
  if (n.match(/compliance|gdpr|cookie|privacy/))                      return 'Compliance';
  return 'Utilities';
}

function getImpactForCategory(cat) {
  const high = ['Analytics','Email & Marketing','Reviews','Page Builder','Subscriptions','Upsell & Cross-sell'];
  const med  = ['Customer Service','Loyalty & Rewards','Pop-ups & Notifications','Navigation & UI','Social Media','Translation'];
  return high.includes(cat) ? 'High' : med.includes(cat) ? 'Medium' : 'Low';
}

function getDefaultRecommendation(cat) {
  const recs = {
    'Analytics':               'Load analytics asynchronously to avoid render blocking.',
    'Email & Marketing':       'Marketing widgets add script weight — load lazily.',
    'Reviews':                 'Lazy-load review widgets below the fold.',
    'Customer Service':        'Defer chat widgets until after page load.',
    'Page Builder':            'Page builder apps inject heavy CSS/JS — audit regularly.',
    'Subscriptions':           'Subscription widgets can slow checkout — test carefully.',
    'Upsell & Cross-sell':     'Ensure upsell scripts fire only after page is interactive.',
    'Pop-ups & Notifications': 'Defer pop-up scripts by 3–5 seconds.',
  };
  return recs[cat] || "Monitor this app's impact and remove if no longer needed.";
}

async function shopifyGetAllPages(baseUrl, token, dataKey) {
  const all = [];
  let nextUrl = baseUrl;
  while (nextUrl) {
    const res = await axios.get(nextUrl, { headers: { 'X-Shopify-Access-Token': token }, timeout: 30000 });
    all.push(...(res.data?.[dataKey] || []));
    const match = (res.headers['link'] || '').match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }
  return all;
}

// ════════════════════════════════════════════════════════
// OAUTH FLOW (kept for future use, but ENV token is primary)
// ════════════════════════════════════════════════════════
app.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  const host       = extractHostname(shop);
  const redirectUri = `${APP_URL}/auth/callback`;
  // Use online token scopes (not offline) to avoid deprecation warning
  const scopes     = 'read_products,read_apps,read_themes,read_script_tags';
  const installUrl = `https://${host}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  console.log(`[OAuth] Redirecting: ${installUrl}`);
  res.redirect(installUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;
  const host = extractHostname(shop);
  try {
    const response = await axios.post(`https://${host}/admin/oauth/access_token`, {
      client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code
    });
    const accessToken = response.data.access_token;
    console.log(`[OAuth] Token for ${host}: ${accessToken.slice(0, 10)}...`);
    await Store.findOneAndUpdate({ shop: host }, { shop: host, accessToken, isActive: true }, { upsert: true, new: true });
    console.log(`[OAuth] ✅ Token saved to DB for ${host}`);
    res.redirect(`/?shop=${host}`);
  } catch (error) {
    console.error('[OAuth] Error:', error.response?.data || error.message);
    res.status(500).send(`Authentication failed: ${error.message}`);
  }
});

// ════════════════════════════════════════════════════════
// /init — returns storeUrl + hasToken
// ════════════════════════════════════════════════════════
app.get('/init', async (req, res) => {
  const shopParam   = req.query.shop || '';
  let storeHostname = '';

  if (shopParam)         storeHostname = extractHostname(shopParam);
  if (!storeHostname && ENV_STORE_URL) storeHostname = extractHostname(ENV_STORE_URL);
  if (!storeHostname) {
    try { const any = await Store.findOne({ isActive: true }); if (any?.shop) storeHostname = any.shop; } catch {}
  }

  const { token, source } = storeHostname
    ? await resolveToken(storeHostname)
    : { token: ENV_ADMIN_TOKEN || null, source: ENV_ADMIN_TOKEN ? 'env' : 'none' };

  console.log(`[Init] shop="${storeHostname}" tokenSource="${source}" hasToken=${!!token}`);

  res.json({
    storeUrl:    storeHostname ? `https://${storeHostname}` : '',
    hasToken:    !!token,
    tokenSource: source,
    needsAuth:   !token && !!storeHostname,
    authUrl:     storeHostname ? `/auth?shop=${storeHostname}` : null,
  });
});

// ════════════════════════════════════════════════════════
// /scan-apps-api — FIXED: ENV token primary, clean 401 handling
// ════════════════════════════════════════════════════════
app.get('/scan-apps-api', async (req, res) => {
  const { storeUrl } = req.query;
  if (!storeUrl) return res.status(400).json({ error: 'storeUrl is required' });

  sseHeaders(res, req);
  const hb  = startHeartbeat(res);
  const log = (msg, type = 'info') => { console.log(msg); sendSse(res, 'log', { message: msg, type }); };

  const host = extractHostname(storeUrl);

  try {
    const { token, source } = await resolveToken(host);

    if (!token) {
      throw new Error(
        `No Admin Token found.\n` +
        `→ Set SHOPIFY_ADMIN_TOKEN in your Render environment variables.\n` +
        `→ Create one at: https://${host}/admin/apps/private`
      );
    }

    log(`[Apps API] Token source: ${source}`, 'info');
    log('[Apps API] Connecting to Shopify...', 'info');

    const gqlRes = await axios({
      url:     `https://${host}/admin/api/2025-01/graphql.json`,
      method:  'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      data:    JSON.stringify({
        query: `{ appInstallations(first: 100) { edges { node { app { title handle developerName appStoreAppUrl } } } } }`,
      }),
      timeout: 30000,
    });

    // Check for GraphQL-level errors
    const errs = gqlRes.data?.errors;
    if (errs?.length) {
      const errMsg = errs.map(e => e.message).join('; ');
      // If it's an auth error, give a clear message
      if (errMsg.toLowerCase().includes('access') || errMsg.toLowerCase().includes('unauthorized') || errMsg.toLowerCase().includes('token')) {
        throw new Error(
          `Token rejected by Shopify (${errMsg}).\n` +
          `Your SHOPIFY_ADMIN_TOKEN may be expired or missing read_apps scope.\n` +
          `→ Go to: https://${host}/admin/apps and create a new custom app token.`
        );
      }
      throw new Error(errMsg);
    }

    const edges = gqlRes.data?.data?.appInstallations?.edges || [];
    log(`[Apps API] ✅ Found ${edges.length} installed apps. Enriching...`, 'success');

    const enrichedApps = edges.map(edge => {
      const shopApp   = edge.node.app;
      const name      = shopApp.title || 'Unknown';
      const nameLower = name.toLowerCase();

      let dbMatch = null;
      for (const [dbName, dbData] of Object.entries(FINGERPRINT_DB)) {
        const dbLower = dbName.toLowerCase();
        const dbWords = dbLower.split(/[\s\-_&.]+/).filter(w => w.length > 4);
        if (dbLower === nameLower || nameLower.includes(dbLower) || dbLower.includes(nameLower) || dbWords.some(w => nameLower.includes(w))) {
          dbMatch = { key: dbName, data: dbData }; break;
        }
      }

      const category       = dbMatch?.data?.category || inferCategoryFromApp(name, shopApp.developerName || '');
      const impact         = getImpactForCategory(category);
      const recommendation = dbMatch?.data?.recommendation || getDefaultRecommendation(category);

      return {
        name, handle: shopApp.handle || '', developer: shopApp.developerName || 'Unknown',
        icon: dbMatch?.data?.icon || '', category, description: shopApp.description || '',
        appStoreUrl: shopApp.appStoreAppUrl || `https://apps.shopify.com/${shopApp.handle || ''}`,
        recommendation, impact,
        totalSizeKb: 0, totalDurationMs: 0, assets: [], estimatedSavingsMs: 0, source: 'api',
      };
    });

    const impactOrder = { High:3, Medium:2, Low:1 };
    enrichedApps.sort((a, b) => (impactOrder[b.impact]||0) - (impactOrder[a.impact]||0) || a.name.localeCompare(b.name));

    const highImpact = enrichedApps.filter(a => a.impact === 'High').length;
    const appReport  = {
      storeUrl: `https://${host}`,
      executiveSummary: { totalAppsDetected: enrichedApps.length, totalAppSizeMb: 0, totalRequests: 0, highImpactApps: highImpact, source: 'shopify_admin_api' },
      topCulprits:         enrichedApps.filter(a => a.impact === 'High').slice(0, 5),
      appBreakdown:        enrichedApps,
      unidentifiedDomains: [], heavyHitters: [],
      source: 'shopify_admin_api',
    };

    log(`[Apps API] Done — ${enrichedApps.length} apps, ${highImpact} high-impact.`, 'success');
    sendSse(res, 'scanResult', appReport);

  } catch (error) {
    console.error('[Apps API]', error.message);
    // Check if it's a 401 HTTP error
    const is401 = error.response?.status === 401 || error.message.includes('401');
    sendSse(res, 'scanError', {
      details: is401
        ? `❌ 401 Unauthorized.\nYour token is invalid or expired.\n\nFix: Go to your Shopify admin → Settings → Apps and sales channels → Develop apps → Create or regenerate your custom app token. Then update SHOPIFY_ADMIN_TOKEN in Render.`
        : error.message,
    });
  } finally {
    clearInterval(hb);
    sendSse(res, 'scanComplete', { message: 'Done.' });
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// /scan-all — Puppeteer fallback
// ════════════════════════════════════════════════════════
app.get('/scan-all', async (req, res) => {
  const { storeUrl, storePassword, runPerfScan, runAppScan, device } = req.query;
  if (!storeUrl) return res.status(400).json({ error: 'storeUrl is required' });

  sseHeaders(res, req);
  const hb  = startHeartbeat(res);
  const log = (msg) => {
    console.log(msg);
    const type = msg.startsWith('[+]') ? 'success' : (msg.startsWith('[!]') || msg.includes('ERROR')) ? 'error' : 'info';
    sendSse(res, 'log', { message: msg, type });
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
    let perfReport = { success: false, metrics: null };

    if (runAppScan === 'true') {
      log('[App] Running Puppeteer fingerprint scan...');
      appReport = await scanStoreLogic(page, log, fingerprintMap);
    }

    if (runPerfScan === 'true') {
      log(`[Perf] Running Lighthouse (${device || 'desktop'})...`);
      try { if (page && !page.isClosed()) await page.close(); } catch {}
      const isMobile = device === 'mobile';
      const settings = isMobile
        ? { formFactor:'mobile', screenEmulation:{mobile:true,width:360,height:640,deviceScaleFactor:2.625,disabled:false}, throttlingMethod:'simulate', throttling:{rttMs:150,throughputKbps:1638.4,cpuSlowdownMultiplier:4} }
        : { formFactor:'desktop', screenEmulation:{mobile:false} };
      const chromePort = new URL(browser.wsEndpoint()).port;
      const { lhr } = await lighthouse(finalUrl, { port: chromePort, output: 'json', settings });
      const audits = lhr.audits;
      const metrics = {
        lcp: audits['largest-contentful-paint']?.displayValue ?? 'N/A',
        cls: audits['cumulative-layout-shift']?.displayValue   ?? 'N/A',
        tbt: audits['total-blocking-time']?.displayValue       ?? 'N/A',
        fcp: audits['first-contentful-paint']?.displayValue    ?? 'N/A',
        speedIndex: audits['speed-index']?.displayValue        ?? 'N/A',
        performanceScore: Math.round(lhr.categories.performance.score * 100),
        device: device || 'desktop',
      };
      const categories = { performance: lhr.categories.performance, accessibility: lhr.categories.accessibility, 'best-practices': lhr.categories['best-practices'], seo: lhr.categories.seo };
      perfReport = { success:true, metrics, categories, audits, culprits: findCulprits(audits, fingerprintMap) };
    }

    sendSse(res, 'scanResult', appReport);
    sendSse(res, 'perfResult', perfReport);
    log('[System] All scans finished.');

  } catch (error) {
    errorOccurred = true;
    console.error('[scan-all]', error);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    clearInterval(hb);
    try { if (browser) await browser.close(); } catch {}
    sendSse(res, 'scanComplete', { message: errorOccurred ? 'Done with errors' : 'Done' });
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// /scan-speed — Lighthouse only
// ════════════════════════════════════════════════════════
app.get('/scan-speed', async (req, res) => {
  const { storeUrl, storePassword, device } = req.query;
  if (!storeUrl) return res.status(400).json({ error: 'storeUrl is required' });

  sseHeaders(res, req);
  const hb  = startHeartbeat(res);
  const log = (msg) => {
    console.log(msg);
    const type = msg.startsWith('[+]') ? 'success' : (msg.startsWith('[!]') || msg.includes('ERROR')) ? 'error' : 'info';
    sendSse(res, 'log', { message: msg, type });
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

    const isMobile = device === 'mobile';
    log(`[Speed] Running Lighthouse (${device || 'desktop'})...`);
    const settings = isMobile
      ? { formFactor:'mobile', screenEmulation:{mobile:true,width:360,height:640,deviceScaleFactor:2.625,disabled:false}, throttlingMethod:'simulate', throttling:{rttMs:150,throughputKbps:1638.4,cpuSlowdownMultiplier:4} }
      : { formFactor:'desktop', screenEmulation:{mobile:false} };

    const fingerprintMap = buildFingerprintMap();
    const chromePort = new URL(browser.wsEndpoint()).port;
    const { lhr } = await lighthouse(page.url(), { port: chromePort, output: 'json', settings });
    const audits = lhr.audits;
    const metrics = {
      lcp: audits['largest-contentful-paint']?.displayValue ?? 'N/A',
      cls: audits['cumulative-layout-shift']?.displayValue   ?? 'N/A',
      tbt: audits['total-blocking-time']?.displayValue       ?? 'N/A',
      fcp: audits['first-contentful-paint']?.displayValue    ?? 'N/A',
      speedIndex: audits['speed-index']?.displayValue        ?? 'N/A',
      inp: audits['interaction-to-next-paint']?.displayValue ?? 'N/A',
      performanceScore: Math.round(lhr.categories.performance.score * 100),
      device: device || 'desktop',
    };
    const categories = { performance: lhr.categories.performance, accessibility: lhr.categories.accessibility, 'best-practices': lhr.categories['best-practices'], seo: lhr.categories.seo };
    const perfReport = { success:true, metrics, categories, audits, culprits: findCulprits(audits, fingerprintMap) };

    sendSse(res, 'speedResult', perfReport);

    const appPerfMap = buildAppPerfMap(audits, fingerprintMap);
    if (appPerfMap.size > 0) {
      sendSse(res, 'appPerfData', {
        apps: Array.from(appPerfMap.entries()).map(([name, data]) => ({
          name, totalSizeKb: +data.totalSizeKb.toFixed(2), totalDurationMs: +data.totalDurationMs.toFixed(2),
          assets: data.assets, estimatedSavingsMs: Math.round(data.totalDurationMs * 0.6),
        }))
      });
    }

    log(`[+] Lighthouse done. Score: ${metrics.performanceScore}`);

  } catch (error) {
    errorOccurred = true;
    console.error('[scan-speed]', error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    clearInterval(hb);
    try { if (browser) await browser.close(); } catch {}
    sendSse(res, 'scanComplete', { message: errorOccurred ? 'Done with errors' : 'Done' });
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// /scan-images
// ════════════════════════════════════════════════════════
app.get('/scan-images', async (req, res) => {
  const { storeUrl, storePassword } = req.query;
  if (!storeUrl) return res.status(400).json({ error: 'storeUrl is required' });

  sseHeaders(res, req);
  const hb  = startHeartbeat(res);
  const log = (msg) => { console.log(msg); sendSse(res, 'log', { message: msg }); };

  const finalUrl = normalizeUrl(storeUrl);
  const hostname = extractHostname(storeUrl);
  const { token } = await resolveToken(hostname);
  let browser, errorOccurred = false;

  try {
    let apiProductImages = [];
    if (token) {
      log('[Images] Fetching product images via Admin API...');
      try {
        const allProducts = await shopifyGetAllPages(`https://${hostname}/admin/api/2024-01/products.json?fields=id,title,images&limit=250`, token, 'products');
        for (const p of allProducts) {
          for (const img of p.images || []) {
            if (img.src) apiProductImages.push({ src: img.src, alt: img.alt || '', hasAlt: !!(img.alt || '').trim(), productTitle: p.title, fromApi: true, naturalWidth: 0, naturalHeight: 0, displayWidth: 0, sizeKb: 0 });
          }
        }
        log(`[Images] API: ${apiProductImages.length} product images from ${allProducts.length} products.`);
      } catch (e) { log(`[Images] API failed: ${e.message}. DOM scan only.`); }
    }

    log('[Images] Launching browser for DOM scan...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCacheEnabled(false);

    const imageSizeMap = new Map();
    const attachListener = () => {
      page.on('response', async (response) => {
        const url = response.url();
        if (!/\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|$)/i.test(url) || imageSizeMap.has(url)) return;
        try {
          let size = parseInt(response.headers()['content-length'] || 0, 10);
          if (!size) { try { const buf = await response.buffer(); size = buf.length; } catch {} }
          if (size) imageSizeMap.set(url, size);
        } catch {}
      });
    };

    attachListener();
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await handleStorePassword(page, storePassword);
    try { await page.reload({ waitUntil: 'networkidle2', timeout: 45000 }); } catch {}
    page.removeAllListeners('response');

    const homepageImages = await extractDomImages(page);
    log(`[Images] Homepage: ${homepageImages.length} images.`);

    let extraImages = [];
    try {
      const links = await page.evaluate((base) => {
        const all = Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(href => {
          try { return new URL(href).hostname === new URL(base).hostname && !href.includes('#'); } catch { return false; }
        });
        return [...new Set([...all.filter(h => h.includes('/products/')).slice(0, 6), ...all.filter(h => h.includes('/collections/')).slice(0, 3)])];
      }, finalUrl);

      for (const link of links) {
        try {
          attachListener();
          await page.goto(link, { waitUntil: 'networkidle2', timeout: 40000 });
          try { await page.reload({ waitUntil: 'networkidle2', timeout: 25000 }); } catch {}
          page.removeAllListeners('response');
          extraImages.push(...(await extractDomImages(page)));
        } catch { page.removeAllListeners('response'); }
      }
    } catch {}

    const allImagesMap = new Map();
    for (const img of apiProductImages) { const key = img.src.split('?')[0]; if (!allImagesMap.has(key)) allImagesMap.set(key, { ...img }); }
    for (const img of [...homepageImages, ...extraImages]) {
      if (!img.src) continue;
      const key = img.src.split('?')[0];
      const sizeKb = +((imageSizeMap.get(img.src) || 0) / 1024).toFixed(1);
      if (allImagesMap.has(key)) {
        const ex = allImagesMap.get(key);
        if (img.naturalWidth > 0)  ex.naturalWidth  = img.naturalWidth;
        if (img.naturalHeight > 0) ex.naturalHeight = img.naturalHeight;
        if (img.displayWidth > 0)  ex.displayWidth  = img.displayWidth;
        if (sizeKb > 0) ex.sizeKb = sizeKb;
        ex.hasAlt = img.hasAlt || ex.hasAlt; ex.alt = img.alt || ex.alt; ex.loading = img.loading; ex.fromApi = false;
      } else {
        allImagesMap.set(key, { src: img.src, alt: img.alt, hasAlt: img.hasAlt, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, displayWidth: img.displayWidth, sizeKb, loading: img.loading, fromApi: false, productTitle: '' });
      }
    }

    const needsSize = Array.from(allImagesMap.values()).filter(i => i.fromApi && i.sizeKb === 0);
    if (needsSize.length > 0) {
      await Promise.allSettled(needsSize.slice(0, 30).map(async (img) => {
        try {
          const h = await axios.head(img.src, { timeout: 6000 });
          const cl = parseInt(h.headers['content-length'] || 0, 10);
          if (cl > 0) { img.sizeKb = +(cl / 1024).toFixed(1); const k = img.src.split('?')[0]; if (allImagesMap.has(k)) allImagesMap.get(k).sizeKb = img.sizeKb; }
        } catch {}
      }));
    }

    let missingAlt = 0, oversized = 0, largeFiles = 0, nonModern = 0, totalSizeBytes = 0, potentialSavingsBytes = 0;
    const allProcessed = Array.from(allImagesMap.values()).filter(img => img.src && !img.src.startsWith('data:')).map(img => {
      const sizeBytes = img.sizeKb * 1024;
      totalSizeBytes += sizeBytes;
      const issues = [];
      if (!img.hasAlt) { issues.push('missing-alt'); missingAlt++; }
      const isOversized = img.naturalWidth > 0 && img.displayWidth > 0 && img.naturalWidth > img.displayWidth * 2 && img.naturalWidth > 200;
      if (isOversized) { issues.push('oversized'); oversized++; }
      if (img.sizeKb > 500) { issues.push('large-file'); largeFiles++; }
      const isModern = /\.(webp|avif)(\?|$)/i.test(img.src);
      if (!isModern && sizeBytes > 0) { issues.push('non-modern'); nonModern++; }
      let sv = 0;
      if (isOversized)  sv += sizeBytes * 0.35;
      if (!isModern)    sv += sizeBytes * 0.25;
      if (img.sizeKb > 500) sv += sizeBytes * 0.40;
      potentialSavingsBytes += sv;
      return { src: img.src, alt: img.alt, hasAlt: img.hasAlt, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, displayWidth: img.displayWidth, sizeKb: img.sizeKb, loading: img.loading || 'eager', isOversized, isModern, issues, fromApi: img.fromApi || false, productTitle: img.productTitle || '' };
    });

    allProcessed.sort((a, b) => { if (a.issues.length > 0 && b.issues.length === 0) return -1; if (a.issues.length === 0 && b.issues.length > 0) return 1; return b.sizeKb - a.sizeKb; });

    const totalImages = allImagesMap.size;
    const issuePoints = missingAlt * 3 + oversized * 5 + largeFiles * 8 + nonModern * 2;
    const score       = Math.max(0, Math.min(100, 100 - Math.round(issuePoints / Math.max(totalImages, 1) * 10)));
    const result      = { score, scoreGrade: score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D', totalImages, imagesWithIssues: allProcessed.filter(i => i.issues.length > 0).length, missingAlt, oversized, largeFiles, nonModern, totalSizeMb: +(totalSizeBytes / 1024 / 1024).toFixed(2), potentialSavingsKb: Math.round(potentialSavingsBytes / 1024), afterOptimizationMb: +((totalSizeBytes - potentialSavingsBytes) / 1024 / 1024).toFixed(2), apiProductCount: apiProductImages.length, images: allProcessed.slice(0, 200) };

    log(`[Images] Done. ${totalImages} total images. Score: ${score}/100.`);
    sendSse(res, 'imageResult', result);

  } catch (error) {
    errorOccurred = true;
    console.error('[scan-images]', error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    clearInterval(hb);
    try { if (browser) await browser.close(); } catch {}
    sendSse(res, 'scanComplete', { message: errorOccurred ? 'Done with errors' : 'Image scan complete.' });
    res.end();
  }
});

async function extractDomImages(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('img')).map(img => ({
      src: img.currentSrc || img.src || '', alt: img.alt || '', hasAlt: (img.alt || '').trim() !== '',
      naturalWidth: img.naturalWidth || 0, naturalHeight: img.naturalHeight || 0,
      displayWidth: Math.round(img.getBoundingClientRect().width) || 0, loading: img.loading || 'eager',
    }))
  ).then(imgs => imgs.filter(img => img.src && !img.src.startsWith('data:') && img.src.startsWith('http')));
}

// ════════════════════════════════════════════════════════
// /scan-ghost-code
// ════════════════════════════════════════════════════════
app.get('/scan-ghost-code', async (req, res) => {
  sseHeaders(res, req);
  const hb  = startHeartbeat(res);
  const log = (msg) => { console.log(msg); sendSse(res, 'log', { message: msg }); };

  const activeStoreUrl = req.query.storeUrl || ENV_STORE_URL;
  if (!activeStoreUrl) { sendSse(res, 'scanError', { details: 'Store URL missing.' }); clearInterval(hb); sendSse(res, 'scanComplete', { message: 'Done' }); return res.end(); }

  const host = extractHostname(activeStoreUrl);
  const { token: activeToken } = await resolveToken(host);

  try {
    if (!activeToken) throw new Error('Admin Token missing. Set SHOPIFY_ADMIN_TOKEN in environment.');

    const shopify = axios.create({ baseURL: `https://${host}/admin/api/2025-10`, headers: { 'X-Shopify-Access-Token': activeToken, 'Content-Type': 'application/json' }, timeout: 30000 });

    log('[Ghost] Fetching installed apps...');
    let installedAppNames = [], installedAppHandles = [];
    try {
      const gqlRes = await axios({ url: `https://${host}/admin/api/2024-01/graphql.json`, method: 'POST', headers: { 'X-Shopify-Access-Token': activeToken, 'Content-Type': 'application/json' }, data: JSON.stringify({ query: `{ appInstallations(first:50) { edges { node { app { title handle } } } } }` }), timeout: 30000 });
      const edges = gqlRes.data?.data?.appInstallations?.edges || [];
      installedAppNames   = edges.map(e => e.node.app.title.toLowerCase());
      installedAppHandles = edges.map(e => (e.node.app.handle || '').toLowerCase());
      log(`[Ghost] ${installedAppNames.length} installed apps found.`);
    } catch (err) { log(`[Ghost] Warning: ${err.message}`); }

    const themeRes  = await shopify.get('/themes.json?role=main');
    const mainTheme = themeRes.data.themes?.[0];
    if (!mainTheme) throw new Error('No published theme found.');
    log(`[Ghost] Theme: "${mainTheme.name}"`);

    const assetListRes = await shopify.get(`/themes/${mainTheme.id}/assets.json`);
    const allAssets    = assetListRes.data.assets || [];
    const liquidFiles  = allAssets.filter(a => a.key.endsWith('.liquid'));
    log(`[Ghost] Scanning ${liquidFiles.length} liquid files...`);

    const fingerprintMap = buildFingerprintMap();
    const detectedApps   = new Map();

    for (const file of liquidFiles) {
      let content = '';
      try {
        const fileRes = await shopify.get(`/themes/${mainTheme.id}/assets.json?asset[key]=${encodeURIComponent(file.key)}`);
        content = fileRes.data.asset?.value || '';
      } catch { continue; }
      if (!content) continue;

      for (const [fingerprint, appInfo] of fingerprintMap.entries()) {
        if (!content.includes(fingerprint)) continue;
        const key = appInfo.name;
        if (!detectedApps.has(key)) {
          const appWords    = appInfo.name.toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 3);
          const isInstalled = installedAppNames.some(n => appWords.some(w => n.includes(w))) || installedAppHandles.some(h => appWords.some(w => h.includes(w)));
          const assetMeta   = allAssets.find(a => a.key === file.key);
          detectedApps.set(key, { name: appInfo.name, icon: appInfo.icon, category: appInfo.category || 'Uncategorized', files: new Set(), fingerprint, isInstalled, confidence: isInstalled ? 15 : 85, wastedKb: Math.round((assetMeta?.size || 0) / 1024) });
        }
        detectedApps.get(key).files.add(file.key);
      }
    }

    const foundApps = Array.from(detectedApps.values()).map(app => ({ name: app.name, icon: app.icon, category: app.category, fingerprint: app.fingerprint, isInstalled: app.isInstalled, confidence: app.confidence, wastedKb: app.wastedKb, files: Array.from(app.files), fileCount: app.files.size }));
    foundApps.sort((a, b) => { if (!a.isInstalled && b.isInstalled) return -1; if (a.isInstalled && !b.isInstalled) return 1; return b.confidence - a.confidence; });

    const ghostCount    = foundApps.filter(a => !a.isInstalled).length;
    const totalWastedKb = foundApps.filter(a => !a.isInstalled).reduce((s, a) => s + (a.wastedKb || 0), 0);

    log(`[Ghost] Done. ${ghostCount} ghost(s) out of ${foundApps.length} matches.`);
    sendSse(res, 'ghostResult', { apps: foundApps, ghostCount, totalWastedKb, theme: mainTheme.name });

  } catch (error) {
    console.error('[Ghost]', error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    clearInterval(hb);
    sendSse(res, 'scanComplete', { message: 'Ghost scan complete.' });
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// /scan-fonts
// ════════════════════════════════════════════════════════
app.get('/scan-fonts', async (req, res) => {
  sseHeaders(res, req);
  const hb  = startHeartbeat(res);
  const log = (msg) => { console.log(msg); sendSse(res, 'log', { message: msg }); };
  const { storeUrl, storePassword } = req.query;
  if (!storeUrl) { sendSse(res, 'scanError', { details: 'storeUrl required' }); clearInterval(hb); sendSse(res, 'scanComplete', { message: 'Done' }); return res.end(); }

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
      const url = response.url(), ct = response.headers()['content-type'] || '';
      if (!/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url) && !ct.includes('font')) return;
      try {
        let sizeBytes = parseInt(response.headers()['content-length'] || 0, 10);
        if (!sizeBytes) { try { const buf = await response.buffer(); sizeBytes = buf.length; } catch {} }
        fontRequests.push({ url, sizeKb: +(sizeBytes / 1024).toFixed(1), format: url.match(/\.(woff2?|ttf|otf|eot)/i)?.[1]?.toLowerCase() || 'unknown', isGoogleFont: url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com'), status: response.status() });
      } catch {}
    });

    log('[Fonts] Navigating...');
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await handleStorePassword(page, storePassword);

    const fontData = await page.evaluate(() => {
      const fonts = [], seen = new Set();
      document.fonts.forEach(font => { const key = `${font.family}|${font.weight}|${font.style}`; if (!seen.has(key)) { seen.add(key); fonts.push({ family: font.family, weight: font.weight, style: font.style, status: font.status }); } });
      const fontDisplayIssues = [];
      try { Array.from(document.styleSheets).forEach(sheet => { try { Array.from(sheet.cssRules || []).forEach(rule => { if (rule.constructor.name === 'CSSFontFaceRule') { const display = rule.style.getPropertyValue('font-display'); if (!display || display === 'auto' || display === 'block') fontDisplayIssues.push({ src: rule.style.getPropertyValue('src').slice(0,100), display: display || 'not set' }); } }); } catch {} }); } catch {}
      return { fonts, fontDisplayIssues, preloadedFonts: Array.from(document.querySelectorAll('link[rel="preload"][as="font"]')).map(l => l.href) };
    });
    page.removeAllListeners('response');

    const seen = new Set();
    const uniqueFonts = fontRequests.filter(f => { if (seen.has(f.url)) return false; seen.add(f.url); return true; });
    const googleFonts = uniqueFonts.filter(f => f.isGoogleFont);
    const nonWoff2    = uniqueFonts.filter(f => f.format !== 'woff2' && !f.url.includes('fonts.gstatic.com'));
    const heavyFonts  = uniqueFonts.filter(f => f.sizeKb > 60);

    const issues = [], recommendations = [];
    let score = 100;
    if (googleFonts.length > 0) { issues.push({type:'google-fonts',severity:'warn',message:`${googleFonts.length} Google Font(s) from external CDN`}); recommendations.push('Self-host Google Fonts'); score -= 15; }
    if (fontData.fontDisplayIssues.length > 0) { issues.push({type:'no-font-display',severity:'error',message:`${fontData.fontDisplayIssues.length} font(s) missing font-display: swap`}); recommendations.push('Add font-display: swap'); score -= 20; }
    if (fontData.preloadedFonts.length === 0 && uniqueFonts.length > 0) { issues.push({type:'no-preload',severity:'warn',message:'No fonts are preloaded'}); recommendations.push('Add <link rel="preload" as="font">'); score -= 10; }
    if (nonWoff2.length > 0) { issues.push({type:'non-woff2',severity:'warn',message:`${nonWoff2.length} font(s) not in WOFF2`}); recommendations.push('Convert to WOFF2'); score -= 10; }
    if (heavyFonts.length > 0) { issues.push({type:'heavy-fonts',severity:'warn',message:`${heavyFonts.length} font file(s) over 60 KB`}); recommendations.push('Use Unicode-range subsetting'); score -= 5 * heavyFonts.length; }
    if (fontData.fonts.length > 6) { issues.push({type:'too-many-fonts',severity:'info',message:`${fontData.fonts.length} variants loaded`}); score -= 5; }
    score = Math.max(0, Math.min(100, score));

    const result = { score, grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D', totalFonts: fontData.fonts.length, totalFontFiles: uniqueFonts.length, googleFonts: googleFonts.length, selfHosted: uniqueFonts.filter(f => !f.isGoogleFont).length, totalSizeKb: +uniqueFonts.reduce((s, f) => s + f.sizeKb, 0).toFixed(1), preloaded: fontData.preloadedFonts.length, issues: issues.length, fonts: fontData.fonts, fontFiles: uniqueFonts, issueList: issues, recommendations };

    log(`[Fonts] Done. Score: ${score}/100.`);
    sendSse(res, 'fontResult', result);
  } catch (error) {
    errorOccurred = true;
    console.error('[scan-fonts]', error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    clearInterval(hb);
    try { if (browser) await browser.close(); } catch {}
    sendSse(res, 'scanComplete', { message: errorOccurred ? 'Done with errors' : 'Font scan complete.' });
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// /scan-css
// ════════════════════════════════════════════════════════
app.get('/scan-css', async (req, res) => {
  sseHeaders(res, req);
  const hb  = startHeartbeat(res);
  const log = (msg) => { console.log(msg); sendSse(res, 'log', { message: msg }); };
  const { storeUrl, storePassword } = req.query;
  if (!storeUrl) { sendSse(res, 'scanError', { details: 'storeUrl required' }); clearInterval(hb); sendSse(res, 'scanComplete', { message: 'Done' }); return res.end(); }

  const finalUrl = normalizeUrl(storeUrl);
  let browser, errorOccurred = false;
  try {
    log('[CSS] Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setCacheEnabled(false);

    log('[CSS] Navigating...');
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await handleStorePassword(page, storePassword);

    log('[CSS] Running coverage...');
    await page.coverage.startCSSCoverage();
    try { await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }); } catch { log('[CSS] Reload timed out.'); }
    const cssCoverage = await page.coverage.stopCSSCoverage();

    let totalBytes = 0, usedBytes = 0, totalRules = 0;
    const fileBreakdown = [];
    for (const entry of cssCoverage) {
      const tot = entry.text ? entry.text.length : 0;
      let used = 0;
      for (const r of entry.ranges) used += r.end - r.start;
      totalBytes += tot; usedBytes += used;
      const rules = (entry.text || '').split('{').length - 1;
      totalRules += rules;
      const unusedPct = tot > 0 ? Math.round((1 - used / tot) * 100) : 0;
      const sizeKb    = +(tot / 1024).toFixed(1);
      const savingsKb = +((tot - used) / 1024).toFixed(1);
      let fileName = entry.url;
      try { fileName = new URL(entry.url).pathname.split('/').pop() || entry.url; } catch {}
      fileBreakdown.push({ url: entry.url, fileName, sizeKb, unusedPct, savingsKb, rules });
    }
    fileBreakdown.sort((a, b) => b.savingsKb - a.savingsKb);

    const unusedPct    = totalBytes > 0 ? Math.round((1 - usedBytes / totalBytes) * 100) : 0;
    const totalSizeKb  = +(totalBytes / 1024).toFixed(1);
    const potentialSave = +((totalBytes - usedBytes) / 1024).toFixed(1);

    const domAnalysis = await page.evaluate(() => ({
      blocking:          Array.from(document.querySelectorAll('link[rel="stylesheet"]')).filter(l => !l.media || l.media === 'all' || l.media === 'screen').length,
      inlineStyles:      document.querySelectorAll('[style]').length,
      inlineStyleSizeKb: +(Array.from(document.querySelectorAll('style')).reduce((s, el) => s + (el.textContent || '').length, 0) / 1024).toFixed(1),
    })).catch(() => ({ blocking: 0, inlineStyles: 0, inlineStyleSizeKb: 0 }));

    let score = 100;
    if (unusedPct > 60) score -= 30; else if (unusedPct > 40) score -= 20; else if (unusedPct > 20) score -= 10;
    if (totalSizeKb > 500) score -= 20; else if (totalSizeKb > 200) score -= 10;
    if (domAnalysis.blocking > 3) score -= 10;
    score = Math.max(0, Math.min(100, score));

    const recommendations = [];
    if (unusedPct > 30) recommendations.push('Remove unused CSS — consider PurgeCSS');
    if (domAnalysis.blocking > 2) recommendations.push('Reduce render-blocking stylesheets');
    if (totalSizeKb > 200) recommendations.push('Minify CSS files');
    if (fileBreakdown.some(f => f.unusedPct > 70)) recommendations.push('Some files are >70% unused');

    const result = { score, grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D', totalSizeKb, totalRules, unusedPct, potentialSaveKb: potentialSave, afterOptKb: +(usedBytes / 1024).toFixed(1), blockingSheets: domAnalysis.blocking, inlineStyles: domAnalysis.inlineStyles, inlineStyleSizeKb: domAnalysis.inlineStyleSizeKb, fileCount: fileBreakdown.length, files: fileBreakdown.slice(0, 20), recommendations };

    log(`[CSS] Done. Score: ${score}/100.`);
    sendSse(res, 'cssResult', result);
  } catch (error) {
    errorOccurred = true;
    console.error('[scan-css]', error.message);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    clearInterval(hb);
    try { if (browser) await browser.close(); } catch {}
    sendSse(res, 'scanComplete', { message: errorOccurred ? 'Done with errors' : 'CSS analysis complete.' });
    res.end();
  }
});

// ════════════════════════════════════════════════════════
// /check-password
// ════════════════════════════════════════════════════════
app.get('/check-password', async (req, res) => {
  const { storeUrl } = req.query;
  if (!storeUrl) return res.json({ protected: false });
  try {
    const response = await axios.get(normalizeUrl(storeUrl), { maxRedirects: 5, timeout: 10000, validateStatus: () => true });
    const isProtected = response.request?.path?.includes('/password') ||
      (typeof response.data === 'string' && (response.data.includes('password_form') || response.data.includes('Enter store password')));
    res.json({ protected: !!isProtected });
  } catch { res.json({ protected: false }); }
});

// ════════════════════════════════════════════════════════
// / — serve HTML + inject shop context
// ════════════════════════════════════════════════════════
app.get('/', async (req, res) => {
  try {
    const shop = req.query.shop ? extractHostname(req.query.shop) : (ENV_STORE_URL ? extractHostname(ENV_STORE_URL) : '');

    // Only redirect to OAuth if NO env token AND no DB token
    if (shop && !ENV_ADMIN_TOKEN) {
      const storeData = await Store.findOne({ shop }).catch(() => null);
      if (!storeData?.accessToken) {
        console.log(`[Serve] No token for ${shop} → OAuth redirect`);
        return res.redirect(`/auth?shop=${shop}`);
      }
    }

    const htmlPath = path.join(__dirname, '../frontend', 'server.html');
    let html = await fs.readFile(htmlPath, 'utf8');
    const injected = `<script>window.__SHOPIFY_CONTEXT__={shop:"${shop}"};</script>`;
    html = html.replace('</head>', injected + '\n</head>');
    res.send(html);
  } catch (error) {
    console.error('[Serve]', error);
    res.status(500).send('Error loading the app.');
  }
});

app.listen(port, () => console.log(`[Server] App Auditor running on port ${port}`));
