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
const port = process.env.PORT || 3000;

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
    // ✅ Guard: skip entries with no fingerprints array
    if (!appData || !Array.isArray(appData.fingerprints) || appData.fingerprints.length === 0) {
      console.warn(`[DB] Skipping "${appName}" — missing or empty fingerprints array.`);
      continue;
    }
    for (const fingerprint of appData.fingerprints) {
      map.set(fingerprint, {
        name: appName,
        icon: appData.icon,
        recommendation: appData.recommendation,
        category: appData.category || 'Uncategorized'
      });
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
// Tell Express to look up one level and into the frontend folder for CSS/JS
app.use(express.static(path.join(__dirname, '../frontend')));

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

 
    app.get('/scan-all', async (req, res) => {

  const { storeUrl, storePassword, runPerfScan, runAppScan } = req.query;

  if (!storeUrl) {
    return res.status(400).json({ error: 'storeUrl is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const logStreamCallback = (message) => {
    console.log(message);

    let type = 'info';
    if (message.startsWith('[+]')) type = 'success';
    if (message.startsWith('[!]') || message.includes('ERROR')) type = 'error';

    sendSse(res, 'log', { message, type });
  };

  let browser;
  let errorOccurred = false;

  try {
    // Launch browser
    logStreamCallback('[System] Launching browser...');
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setCacheEnabled(false);

    logStreamCallback('[System] Navigating to store...');
    await page.goto(storeUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    // Password handling
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

    await handleModals(page, logStreamCallback);

    const fingerprintMap = buildFingerprintMap();

    let appReport = {
      executiveSummary: {},
      appBreakdown: [],
      topCulprits: []
    };

    let perfReport = {
      success: false,
      metrics: null,
      categories: null,
      audits: null,
      culprits: null
    };

    // 🔥 APP SCAN
    if (runAppScan === 'true') {
      logStreamCallback('[App] Running scan...');
      appReport = await scanStoreLogic(page, logStreamCallback, fingerprintMap);
    }

    // 🔥 PERF SCAN (ONLY ONCE — FIXED)
    if (runPerfScan === 'true') {
      logStreamCallback('[Perf] Running Lighthouse...');

      const { port } = new URL(browser.wsEndpoint());

      const { lhr } = await lighthouse(page.url(), {
        port,
        output: 'json',
        settings: {
          formFactor: 'desktop',
          screenEmulation: { mobile: false }
        }
      });

      const audits = lhr.audits;

      const metrics = {
        lcp: audits['largest-contentful-paint']?.displayValue ?? 'N/A',
        cls: audits['cumulative-layout-shift']?.displayValue ?? 'N/A',
        tbt: audits['total-blocking-time']?.displayValue ?? 'N/A',
        fcp: audits['first-contentful-paint']?.displayValue ?? 'N/A',
        speedIndex: audits['speed-index']?.displayValue ?? 'N/A',
        performanceScore: Math.round(lhr.categories.performance.score * 100)
      };

      const categories = {
        performance: lhr.categories.performance,
        accessibility: lhr.categories.accessibility,
        'best-practices': lhr.categories['best-practices'],
        seo: lhr.categories.seo
      };

      const culprits = findCulprits(audits, fingerprintMap);

      perfReport = {
        success: true,
        metrics,
        categories,
        audits,
        culprits
      };

      // 🔥 MERGE PERFORMANCE
      if (appReport?.executiveSummary) {
        appReport.executiveSummary.performanceScore = metrics.performanceScore;
      }
    }

    // 🔥 FINAL SEND (ONLY ONCE — FIXED)
    sendSse(res, 'scanResult', appReport);
    sendSse(res, 'perfResult', perfReport);

    logStreamCallback('[System] All scans finished.');

  } catch (error) {
    errorOccurred = true;
    console.error(error);
    sendSse(res, 'scanError', { details: error.message });

  } finally {
    if (browser) await browser.close();

    if (!errorOccurred) {
      sendSse(res, 'scanComplete', { message: 'Done' });
    }

    res.end();
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
    // Point the root route to the frontend folder
    res.sendFile(path.join(__dirname, '../frontend', 'server.html')); 
});

// ---------------------------------------------------------------
// (NEW) ADMIN API APP DETECTION & SEGREGATION ENDPOINT
// ---------------------------------------------------------------
app.get('/api-app-scan', async (req, res) => {
    try {
        if (!adminToken || !storeUrl) {
            return res.status(400).json({ error: 'SHOPIFY_ADMIN_TOKEN or SHOPIFY_STORE_URL missing in .env' });
        }

        const query = `
        {
          appInstallations(first: 50) {
            edges {
              node {
                app {
                  title
                  developerName
                }
              }
            }
          }
        }`;

        // GraphQL API Call using axios already imported in your file
        const response = await axios({
            url: `https://${storeUrl}/admin/api/2024-01/graphql.json`, 
            method: 'POST',
            headers: {
                'X-Shopify-Access-Token': adminToken,
                'Content-Type': 'application/json',
            },
            data: JSON.stringify({ query })
        });

        const installedApps = response.data.data.appInstallations.edges.map(edge => edge.node.app.title);

        // Standard Shopify Categories setup
        let report = {
            total_installed: installedApps.length,
            categories: {
                "Marketing": { count: 0, apps: [] },
                "Store Design": { count: 0, apps: [] },
                "Sales & Conversion": { count: 0, apps: [] },
                "Orders & Shipping": { count: 0, apps: [] },
                "Customer Support": { count: 0, apps: [] },
                "Store Management": { count: 0, apps: [] }
            },
            uncategorized: []
        };

        // Smart Segregation Logic
        installedApps.forEach(appName => {
            let foundCategory = null;
            
            // FINGERPRINT_DB tumhare server.js mein already upar load ho raha hai
            for (const [dbAppName, dbAppData] of Object.entries(FINGERPRINT_DB)) {
                // Agar API ka naam aur database ka naam thoda bhi match hota hai
                if (appName.toLowerCase().includes(dbAppName.toLowerCase()) || dbAppName.toLowerCase().includes(appName.toLowerCase())) {
                    foundCategory = dbAppData.category;
                    break;
                }
            }

            if (foundCategory) {
                // Agar json me category di hai aur wo exist karti hai
                if (!report.categories[foundCategory]) {
                    report.categories[foundCategory] = { count: 0, apps: [] };
                }
                report.categories[foundCategory].count += 1;
                report.categories[foundCategory].apps.push(appName);
            } else {
                // Agar match nahi hua ya json me nahi hai, toh seedha uncategorized mein daalo
                report.uncategorized.push(appName);
            }
        });

        // Frontend ko direct categorized data bhej diya
        res.json(report);

    } catch (error) {
        console.error('[API Scan Error]', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch and segregate apps' });
    }
});


app.listen(port, () => {
    console.log(`[Server] App Auditor UI running at http://localhost:${port}`);
});
