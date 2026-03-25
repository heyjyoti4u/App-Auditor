import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
// --- Import fs for reading the database ---
import fs from 'fs/promises'; 
// --- Import the real scan function ---
import { scanStoreLogic } from './scan.js'; 

// --- Import modules for performance scanning ---
import puppeteer from 'puppeteer';
import lighthouse from 'lighthouse';
import { URL } from 'url';

// --- (NEW) Import Axios and DotEnv for Ghost Scan ---
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config(); // Load .env file

const app = express();
const port = 3000;

// Get the directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- (NEW) Load Shopify Admin API credentials ---
const adminToken = process.env.SHOPIFY_ADMIN_TOKEN;
const storeUrl = process.env.SHOPIFY_STORE_URL;
const shopifyApiUrl = `https://${storeUrl}/admin/api/2025-10`; // Use a recent, stable API version


// --- (NEW) Load Fingerprint Database ---
const dbPath = path.join(__dirname, 'fingerprintDatabase.json');
let FINGERPRINT_DB = {};

(async () => {
    try {
        FINGERPRINT_DB = JSON.parse(await fs.readFile(dbPath, 'utf-8'));
        console.log('[Server] Fingerprint database loaded successfully.');
    } catch (error) {
        console.error(`[Server] Failed to load fingerprint database from: ${dbPath}`);
        console.error(error);
    }
})();

// --- (NEW) Helper to build a fast lookup map from the DB ---
function buildFingerprintMap() {
    const map = new Map();
    for (const [appName, appData] of Object.entries(FINGERPRINT_DB)) {
        if (appData && appData.fingerprints) {
            for (const fingerprint of appData.fingerprints) {
                // Store the app name and icon for the culprit report
                map.set(fingerprint, { 
                    name: appName, 
                    icon: appData.icon,
                    recommendation: appData.recommendation,
                    category: appData.category || 'Uncategorized' // <-- ADD THIS LINE
                });
            }
        }
    }
    return map;
}

// --- (UPGRADED) Helper to find TBT culprits ---
function findCulprits(audits, fingerprintMap) {
    // --- 1. CHANGE AUDIT ---
    // We now use 'bootup-time', which lists individual scripts and their execution time.
    const bootupTime = audits['bootup-time'];
    
    if (!bootupTime || bootupTime.score === 1 || !bootupTime.details || !bootupTime.details.items) {
        return { identified: [], unidentified: [] };
    }

    const identifiedCulprits = [];
    const unidentifiedOffenders = [];
    const minTime = 50; // Only show scripts that took > 50ms

    // --- 2. LOOP new audit items ---
    for (const item of bootupTime.details.items) {
        // --- 3. USE 'item.scripting' ---
        // 'bootup-time' gives us 'scripting' time directly.
        // We no longer need to check for 'groupLabel'.
        const scriptDuration = item.scripting;

        if (scriptDuration >= minTime) {
            let matchedApp = null;

            for (const [fingerprint, appInfo] of fingerprintMap.entries()) {
                if (item.url.includes(fingerprint)) {
                    matchedApp = appInfo;
                    break;
                }
            }

            if (matchedApp) {
                const existing = identifiedCulprits.find(c => c.appName === matchedApp.name);
                if (existing) {
                    // --- 4. ADD 'scriptDuration' ---
                    existing.duration += scriptDuration;
                    existing.scriptCount += 1;
                } else {
                    identifiedCulprits.push({
                        appName: matchedApp.name,
                        icon: matchedApp.icon,
                        // --- 4. ADD 'scriptDuration' ---
                        duration: scriptDuration,
                        scriptCount: 1
                    });
                }
            } else if (item.url) {
                unidentifiedOffenders.push({
                    url: item.url,
                    // --- 4. ADD 'scriptDuration' ---
                    duration: scriptDuration
                });
            }
        }
    }

    identifiedCulprits.sort((a, b) => b.duration - a.duration);
    unidentifiedOffenders.sort((a, b) => b.duration - a.duration);

    return {
        identified: identifiedCulprits.slice(0, 5),
        unidentified: unidentifiedOffenders.slice(0, 5)
    };
}


app.use(express.json()); 
app.use(express.static(__dirname));

// --- (NEW) Helper function to send SSE data ---
const sendSse = (res, event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    
    if (typeof res.flush === 'function') {
        res.flush();
    }
};

// --- (NEW) HELPER FUNCTION TO HANDLE COOKIE/LOCATION MODALS ---
async function handleModals(page, logStreamCallback) {
    try {
        logStreamCallback('[System] Checking for cookie/location modals...');
        
        // Wait for up to 3 seconds for a common modal button
        // This selector checks for common IDs and ARIA labels for "accept" buttons
        const acceptButton = await page.waitForSelector(
            '[id*="onetrust-accept-btn-handler"], [aria-label*="accept"], [aria-label*="Accept"], [class*="cookie-accept"], [id*="cookie-accept"]', 
            { timeout: 3000 }
        );
        
        if (acceptButton) {
            logStreamCallback('[System] Found a modal. Clicking "Accept"...');
            await acceptButton.click();
            await page.waitForTimeout(1000); // Wait for modal to animate and disappear
            logStreamCallback('[System] Modal dismissed.');
        }
    } catch (e) {
        logStreamCallback('[System] No cookie/location modal found. Proceeding.');
    }
}

// --- UNIFIED SCAN ENDPOINT ---
app.get('/scan-all', async (req, res) => {

  // 1. Get data from query parameters
  const { storeUrl, storePassword, runPerfScan, runAppScan } = req.query;

  if (!storeUrl) {
    return res.status(400).json({ error: 'storeUrl is required' });
  }

  // 2. Set Server-Sent Event (SSE) headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 3. Define the streaming log function
  const logStreamCallback = (message) => {
    console.log(message);

    let type = 'info';
    if (message.startsWith('[+]') || message.includes('success')) type = 'success';
    if (message.startsWith('[!]') || message.startsWith('ERROR:') || message.includes('failed')) type = 'error';
    if (message.includes('warn') || message.includes('Note:')) type = 'warning';

    sendSse(res, 'log', { message, type }); // Send to client
  };

  let browser;
  let errorOccurred = false;

  try {
    // 4. --- BROWSER LAUNCHES ONCE ---
    logStreamCallback('[System] Launching browser...');
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Disable cache to fix 0.00 KB files issue
    await page.setCacheEnabled(false);
    logStreamCallback('[System] Browser cache disabled.');

    // 5. --- NAVIGATION AND PASSWORD HAPPENS ONCE ---
    logStreamCallback('[System] Navigating to store...');
    await page.goto(storeUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    if (storePassword) {
      logStreamCallback('[System] Password provided, attempting to unlock store...');
      try {
        const passwordInput = await page.waitForSelector('input[type="password"]#password', { timeout: 5000 });
        if (passwordInput) {
          await passwordInput.type(storePassword);
          await page.click('button[type="submit"]');
          logStreamCallback('[System] Password submitted, waiting for navigation...');
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 120000 });
          logStreamCallback('[System] Store unlocked successfully.');
        } else {
          logStreamCallback('[System] Note: Password provided, but store appears public.');
        }
      } catch {
        logStreamCallback('[System] Warning: Password form not found. Assuming store is public.');
      }
    } else {
      logStreamCallback('[System] No password provided, scanning public page.');
    }

    // --- Handle Modals ---
    await handleModals(page, logStreamCallback);

    logStreamCallback('[System] Page is loaded and ready for scanning.');

    const fingerprintMap = buildFingerprintMap();

    // 6. Run App Scan First
    let appReport = null;
    if (runAppScan === 'true') {
      logStreamCallback('[App] Running App/Asset scan...');
      appReport = await scanStoreLogic(page, logStreamCallback, fingerprintMap);
      sendSse(res, 'scanResult', appReport);
    } else {
      sendSse(res, 'scanResult', { detectedApps: [] });
    }

    // 7. Run Performance Scan Second
    let perfReport = null;
    if (runPerfScan === 'true') {
      logStreamCallback('[Perf] Running Lighthouse scan... (This may take a minute)');
      const { port: browserPort } = new URL(browser.wsEndpoint());

      // --- LIGHTHOUSE CONFIG ---
      const lighthouseConfig = {
        port: browserPort,
        output: 'json',
        settings: {
          formFactor: 'desktop',
          screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }
        }
      };

      const { lhr } = await lighthouse(page.url(), lighthouseConfig);

      logStreamCallback('[Perf] Lighthouse scan complete. Processing metrics.');
      const audits = lhr.audits;

      const metrics = {
        lcp: audits['largest-contentful-paint']?.displayValue ?? 'N/A',
        fid: audits['first-input-delay']?.displayValue ?? 'N/A',
        cls: audits['cumulative-layout-shift']?.displayValue ?? 'N/A',
        fcp: audits['first-contentful-paint']?.displayValue ?? 'N/A',
        tbt: audits['total-blocking-time']?.displayValue ?? 'N/A',
        speedIndex: audits['speed-index']?.displayValue ?? 'N/A',
        performanceScore: (lhr.categories.performance.score * 100).toFixed(0)
      };

      const categories = {
        performance: lhr.categories.performance,
        accessibility: lhr.categories.accessibility,
        'best-practices': lhr.categories['best-practices'],
        seo: lhr.categories.seo
      };

      const detailedAudits = lhr.audits;
      const culprits = findCulprits(detailedAudits, fingerprintMap);

      perfReport = {
        success: true,
        metrics,
        categories,
        audits: detailedAudits,
        culprits
      };

      sendSse(res, 'perfResult', perfReport);
    } else {
      sendSse(res, 'perfResult', { success: false, metrics: null, categories: null, audits: null, culprits: null });
    }

    logStreamCallback('[System] All scans finished.');

  } catch (error) {
    errorOccurred = true;
    console.error('[Server] Error during unified scan:', error);
    logStreamCallback(`[System] ERROR: ${error.message}`);
    sendSse(res, 'scanError', { details: error.message });
  } finally {
    // 8. --- CLOSE BROWSER ---
    if (browser) {
      await browser.close();
      logStreamCallback('[System] Browser closed.');
    }

    if (!errorOccurred) {
      logStreamCallback('[System] Sending completion signal.');
      sendSse(res, 'scanComplete', { message: 'All tasks finished.' });
    }

    // 9. Close the connection
    res.end();
    console.log('[Server] Scan stream closed.');
  }
});


// ---------------------------------------------------------------
// (NEW) GHOST CODE SCANNER ENDPOINT
// ---------------------------------------------------------------
app.get('/scan-ghost-code', async (req, res) => {
    // 1. Set SSE headers for streaming logs
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // 2. Define the streaming log function
    const logStreamCallback = (message) => {
        console.log(message);
        sendSse(res, 'log', { message }); // Send to client
    };

    try {
        if (!adminToken || !storeUrl) {
            throw new Error('SHOPIFY_ADMIN_TOKEN or SHOPIFY_STORE_URL is not set in .env');
        }

        // 3. Setup Axios client with Shopify headers
        const shopifyApiClient = axios.create({
            baseURL: shopifyApiUrl,
            headers: {
                'X-Shopify-Access-Token': adminToken,
                'Content-Type': 'application/json'
            }
        });

        // 4. Get the ID of the main, published theme
        logStreamCallback('[Ghost] Fetching main theme ID...');
        const themeResponse = await shopifyApiClient.get('/themes.json?role=main');
        const mainTheme = themeResponse.data.themes[0];
        if (!mainTheme) {
            throw new Error('Could not find a main theme.');
        }
        logStreamCallback(`[Ghost] Found theme: ${mainTheme.name} (ID: ${mainTheme.id})`);

        // 5. Get the list of all assets in that theme
        logStreamCallback('[Ghost] Fetching theme asset list...');
        const assetListResponse = await shopifyApiClient.get(`/themes/${mainTheme.id}/assets.json`);
        
        // Filter for just .liquid files (theme, layout, snippets, sections)
        const liquidFiles = assetListResponse.data.assets.filter(asset => 
            asset.key.endsWith('.liquid')
        );
        logStreamCallback(`[Ghost] Found ${liquidFiles.length} .liquid files to scan.`);

        // 6. Build the fingerprint map (you already have this function)
        const fingerprintMap = buildFingerprintMap();
        const detectedApps = new Map();

        // 7. Scan each file's content
        for (const file of liquidFiles) {
            logStreamCallback(`[Ghost] Scanning: ${file.key}`);
            
            // Fetch the content of the single file
            const fileContentResponse = await shopifyApiClient.get(`/themes/${mainTheme.id}/assets.json?asset[key]=${file.key}`);
            const fileContent = fileContentResponse.data.asset.value;

            if (!fileContent) continue;

            // Check content against every fingerprint in your DB
            for (const [fingerprint, appInfo] of fingerprintMap.entries()) {
                if (fileContent.includes(fingerprint)) {
                    // Found a match!
                    logStreamCallback(`[+] Found reference to "${appInfo.name}" in ${file.key}`);
                    
                    if (!detectedApps.has(appInfo.name)) {
                        detectedApps.set(appInfo.name, {
                            ...appInfo,
                            files: new Set() // Use a Set to avoid duplicate file names
                        });
                    }
                    // Add the file where the code was found
                    detectedApps.get(appInfo.name).files.add(file.key);
                }
            }
        }

        // 8. Format the final report
        const foundApps = Array.from(detectedApps.values()).map(app => ({
            ...app,
            files: Array.from(app.files) // Convert Set back to Array for JSON
        }));
        
        const reportMessage = `Scan complete. Found references to ${foundApps.length} apps in your theme files.`;
        logStreamCallback(reportMessage);
        
        // Convert the detailed report to a string to send
        const finalReport = JSON.stringify(foundApps, null, 2);
        logStreamCallback('--- DETAILED REPORT ---');
        logStreamCallback(finalReport);

        sendSse(res, 'scanComplete', { message: 'Ghost Code scan finished.' });

    } catch (error) {
        console.error('[Ghost] Error during ghost scan:', error.response ? error.response.data : error.message);
        logStreamCallback(`[Ghost] ERROR: ${error.message}`);
        sendSse(res, 'scanError', { details: error.message });
    } finally {
        res.end(); // Close the connection
    }
});
// ---------------------------------------------------------------
// (END) GHOST CODE SCANNER ENDPOINT
// ---------------------------------------------------------------


// --- Serve the HTML Page (Existing) ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'server.html')); 
});

app.listen(port, () => {
    console.log(`[Server] App Auditor UI running at http://localhost:${port}`);
});