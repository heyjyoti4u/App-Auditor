// Import the required libraries
import fs from 'fs/promises'; // Use promises (fs/promises)
import { fileURLToPath } from 'url';
import path from 'path';

// Get the directory of the current script
const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

// --- MODIFICATION: The database is now loaded in server.js ---
// We no longer need to load FINGERPRINT_DB here.


/**
 * Main function to scan a store's PAGE
 * Optimized: Added enhanced error handling, minimal spacing, and modern logging.
 * @param {import('puppeteer').Page} page - Puppeteer page object.
 * @param {function(string): void} [logStreamCallback] - Optional log callback.
 * @param {Map} fingerprintMap - Pre-built fingerprint map from server.js.
 */
/**
 * Main function to scan a store's PAGE
 * --- UPDATED to combine network listeners (for size) and Performance API (for duration) ---
 * @param {import('puppeteer').Page} page - An already navigated Puppeteer page object.
 * @param {function(string): void} [logStreamCallback] - Optional callback to stream logs.
 * @param {Map} fingerprintMap - The pre-built fingerprint map from server.js.
 */
export async function scanStoreLogic(page, logStreamCallback, fingerprintMap) {
  const log = logStreamCallback || (() => {});
  log('[+] App Scan: Initializing network capture for file sizes...');

  const sizeMap = new Map(); // Stores accurate file sizes
  const startTime = Date.now();

  // 1. Network Listener Setup (for accurate SIZE only)
  page.on('response', async (response) => {
    const url = response.url();
    if (!/\.(js|css)(\?|$)/i.test(url) || sizeMap.has(url)) return;

    try {
      const headers = response.headers();
      let rawSize = parseInt(headers['content-length'] || 0, 10);

      // Fallback to buffer read if content-length is missing
      if (!rawSize) rawSize = (await response.buffer()).length;

      sizeMap.set(url, +(rawSize / 1024).toFixed(2)); // Size in KB
    } catch (e) {
      log(`[!] Warning: Could not get size for ${url.slice(0, 80)} (${e.message})`);
      sizeMap.set(url, 0);
    }
  });

  // 2. Reload page to trigger listeners
  try {
    log('[+] Reloading page for network capture...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 90000 });
  } catch {
    log('[!] Warning: Page reload timeout. Using partial data.');
  }

  // 3. Cleanup listeners
  page.removeAllListeners('response');
  log('[+] Network size capture complete.');

  // 4. Extract durations via Performance API
  log('[+] App Scan: Harvesting resource durations from Performance API...');
  const performanceEntries = await page.evaluate(() => {
    const isAsset = (url) => /\.(js|css)(\?|$)/i.test(url);
    return window.performance.getEntriesByType('resource')
      .filter(entry => isAsset(entry.name))
      .map(entry => ({
        url: entry.name,
        durationMs: entry.duration,
        type: /\.js(\?|$)/i.test(entry.name) ? 'JS' : 'CSS'
      }));
  });

  log(`[+] App Scan: Found ${performanceEntries.length} assets in Performance API.`);

  // 5. Merge Performance + Network data
  const detectedResources = performanceEntries.map(entry => ({
    url: entry.url,
    durationMs: +entry.durationMs.toFixed(2),
    type: entry.type,
    sizeKb: sizeMap.get(entry.url) || 0
  }));

  // 6. Process and Summarize results
  const { detectedAppsFormatted, unidentifiedDomains, heavyHitters } =
    processAssets(detectedResources, page.url(), fingerprintMap);

  printSimplifiedReport(
    { storeUrl: page.url(), detectedApps: detectedAppsFormatted },
    heavyHitters
  );

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
  log(`[+] App Scan: Analysis complete in ${totalTime}s.`);

  // 7. Return final report
  return {
    storeUrl: page.url(),
    detectedApps: detectedAppsFormatted,
    unidentifiedDomains,
    heavyHitters
  };
}


/**
 * --- MODIFIED: This function now reads the new DB structure ---
 */
function processAssets(detectedResources, storeUrl, fingerprintMap) { // <-- Added fingerprintMap
    const appMap = new Map();

    // --- NEW: Definitions for "Heavy Hitters" and unidentified domains ---
    const allKnownFingerprints = new Set(fingerprintMap.keys()); // Get all keys from the map
    const foundHostnames = new Set();
    const unidentifiedHostnames = new Set();
    const heavyHitters = [];
    const HEAVY_HITTER_THRESHOLD_KB = 150; // Set threshold to 150 KB
    const storeHostname = new URL(storeUrl).hostname; 

    // 1. Loop 1: Get all hostnames, process known apps, and find heavy hitters
    for (const resource of detectedResources) {
        const assetUrl = resource.url;
        let hostname;
        try {
            hostname = new URL(assetUrl).hostname;
        } catch (e) {
            continue; // Skip invalid URLs
        }
        
        // Add all unique hostnames to a set (for unidentified domain logic)
        foundHostnames.add(hostname); 

        let resourceMatched = false;

        // --- Check against known app fingerprints ---
        // --- FIX 2: Loop to read the pre-built map ---
        for (const [fingerprint, appInfo] of fingerprintMap.entries()) {
            
            if (assetUrl.includes(fingerprint)) {
                const appName = appInfo.name;

                if (!appMap.has(appName)) {
                    appMap.set(appName, {
                        name: appName,
                        recommendation: appInfo.recommendation,
                        icon: appInfo.icon,
                        category: appInfo.category, // <-- ADD THIS LINE
                        matchedFingerprints: new Set(),
                        assets: []
                    });
                }

                appMap.get(appName).assets.push(resource); 
                appMap.get(appName).matchedFingerprints.add(fingerprint);
                resourceMatched = true; // Mark this resource as "known"
                // We don't break here, in case a URL matches multiple fingerprints (e.g. a generic CDN)
            }
        }
        // --- END FIX 2 ---
        
        // --- NEW: "Heavy Hitter" Logic ---
        // If the resource was NOT matched AND is over the size threshold...
        if (!resourceMatched && resource.sizeKb > HEAVY_HITTER_THRESHOLD_KB) {
            // ...and it's not a generic Shopify CDN file...
            if (!hostname.endsWith('myshopify.com') && !hostname.endsWith('cdn.shopify.com')) {
                // ...it's a heavy hitter.
                heavyHitters.push({
                    url: resource.url,
                    sizeKb: resource.sizeKb
                });
            }
        }
    }

    // --- Loop 2: Find unidentified domains (This logic is now correct because allKnownFingerprints is fixed) ---
    for (const hostname of foundHostnames) {
        // Skip store's own domain, subdomains, and shopify cdn
        if (hostname.endsWith(storeHostname) || hostname.endsWith('myshopify.com') || hostname.endsWith('cdn.shopify.com')) {
            continue;
        }

        let isKnown = false;
        for (const knownFp of allKnownFingerprints) {
            if (hostname.includes(knownFp)) {
                isKnown = true;
                break;
            }
        }

        if (!isKnown) {
            unidentifiedHostnames.add(hostname);
        }
    }
    // --- END NEW SECTION ---

    // 3. Format the report (This is correct, ...appData will now include the recommendation and icon)
    const detectedAppsFormatted = Array.from(appMap.values()).map(appData => ({
        ...appData,
        matchedFingerprints: Array.from(appData.matchedFingerprints),
        assets: appData.assets 
    }));

    // 4. Return all three lists
    return {
        detectedAppsFormatted,
        unidentifiedDomains: Array.from(unidentifiedHostnames),
        heavyHitters: heavyHitters // NEW
    };
}


/**
 * Prints a simplified, human-readable summary of the detected apps.
 */
function printSimplifiedReport(report, heavyHitters) { // Modified to accept heavyHitters
    const apps = report.detectedApps;
    const totalApps = apps.length;

    console.log('\n======================================================');
    console.log(`🎯 AUDIT COMPLETE for: ${report.storeUrl}`);
    console.log(`✨ **TOTAL DETECTED APPS: ${totalApps}**`);
    console.log('======================================================');

    if (totalApps === 0) {
        console.log('No known third-party apps were detected based on current fingerprints.');
    }

    for (const app of apps) {
        const jsCount = app.assets.filter(a => a.type === 'JS').length;
        const cssCount = app.assets.filter(a => a.type === 'CSS').length;
        const totalAssetCount = app.assets.length;

        console.log(`\n### 📱 APP: **${app.name}**`);
        console.log(`- **Total Assets Found:** ${totalAssetCount}`);
        console.log(`  - 📂 JS Files: ${jsCount}`);
        console.log(`  - 🎨 CSS Files: ${cssCount}`);
        console.log(`  - 🔑 Matched Fingerprints: "${app.matchedFingerprints.join('", "')}"`);
        
        // --- NEW: Log recommendation to server console ---
        if (app.recommendation) {
            console.log(`  - 💡 TIP: ${app.recommendation}`);
        }
    }
    
    // --- NEW: Log Heavy Hitters to server console ---
    if (heavyHitters && heavyHitters.length > 0) {
        console.log('\n======================================================');
        console.log(`🏋️  **HEAVY HITTERS FOUND: ${heavyHitters.length}**`);
        console.log('(Unidentified scripts over 150 KB)');
        console.log('======================================================');
        heavyHitters.sort((a, b) => b.sizeKb - a.sizeKb); // Sort largest first
        
        for (const script of heavyHitters) {
            console.log(`- **${script.sizeKb.toFixed(2)} KB** - ${script.url}`);
        }
    }
    // --- END NEW SECTION ---
    
    console.log('======================================================');
}