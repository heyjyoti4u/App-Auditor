/**
 * Main function to scan a store's PAGE
 * Optimized: Removed dead imports, fixed logging so the frontend receives the summary.
 * @param {import('puppeteer').Page} page - An already navigated Puppeteer page object.
 * @param {function(string): void} [logStreamCallback] - Optional callback to stream logs.
 * @param {Map} fingerprintMap - The pre-built fingerprint map from server.js.
 */
export async function scanStoreLogic(page, logStreamCallback, fingerprintMap) {
  const log = logStreamCallback || (() => {});
  log('[+] App Scan: Initializing network capture for file sizes...');

  const sizeMap = new Map(); 
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

      sizeMap.set(url, +(rawSize / 1024).toFixed(2)); 
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

  // Pass the log callback so the frontend UI receives the summary report
  printSimplifiedReport(
    { storeUrl: page.url(), detectedApps: detectedAppsFormatted },
    heavyHitters,
    log
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

function processAssets(detectedResources, storeUrl, fingerprintMap) { 
    const appMap = new Map();
    const allKnownFingerprints = new Set(fingerprintMap.keys()); 
    const foundHostnames = new Set();
    const unidentifiedHostnames = new Set();
    const heavyHitters = [];
    const HEAVY_HITTER_THRESHOLD_KB = 150; 
    const storeHostname = new URL(storeUrl).hostname; 

    for (const resource of detectedResources) {
        const assetUrl = resource.url;
        let hostname;
        try {
            hostname = new URL(assetUrl).hostname;
        } catch (e) {
            continue; 
        }
        
        foundHostnames.add(hostname); 
        let resourceMatched = false;

        for (const [fingerprint, appInfo] of fingerprintMap.entries()) {
            if (assetUrl.includes(fingerprint)) {
                const appName = appInfo.name;

                if (!appMap.has(appName)) {
                    appMap.set(appName, {
                        name: appName,
                        recommendation: appInfo.recommendation,
                        icon: appInfo.icon,
                        category: appInfo.category, 
                        matchedFingerprints: new Set(),
                        assets: []
                    });
                }

                appMap.get(appName).assets.push(resource); 
                appMap.get(appName).matchedFingerprints.add(fingerprint);
                resourceMatched = true; 
            }
        }
        
        if (!resourceMatched && resource.sizeKb > HEAVY_HITTER_THRESHOLD_KB) {
            if (!hostname.endsWith('myshopify.com') && !hostname.endsWith('cdn.shopify.com')) {
                heavyHitters.push({
                    url: resource.url,
                    sizeKb: resource.sizeKb
                });
            }
        }
    }

    for (const hostname of foundHostnames) {
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

    const detectedAppsFormatted = Array.from(appMap.values()).map(appData => ({
        ...appData,
        matchedFingerprints: Array.from(appData.matchedFingerprints),
        assets: appData.assets 
    }));

    return {
        detectedAppsFormatted,
        unidentifiedDomains: Array.from(unidentifiedHostnames),
        heavyHitters: heavyHitters 
    };
}

function printSimplifiedReport(report, heavyHitters, log) { 
    const apps = report.detectedApps;
    const totalApps = apps.length;

    log('======================================================');
    log(`[+] AUDIT COMPLETE for: ${report.storeUrl}`);
    log(`[+] TOTAL DETECTED APPS: ${totalApps}`);
    log('======================================================');

    if (totalApps === 0) {
        log('[!] No known third-party apps were detected based on current fingerprints.');
    }

    for (const app of apps) {
        const jsCount = app.assets.filter(a => a.type === 'JS').length;
        const cssCount = app.assets.filter(a => a.type === 'CSS').length;
        const totalAssetCount = app.assets.length;

        log(`[+] APP: ${app.name}`);
        log(`    Total Assets Found: ${totalAssetCount}`);
        log(`    JS Files: ${jsCount}`);
        log(`    CSS Files: ${cssCount}`);
        
        if (app.recommendation) {
            log(`    TIP: ${app.recommendation}`);
        }
    }
    
    if (heavyHitters && heavyHitters.length > 0) {
        log('======================================================');
        log(`[!] HEAVY HITTERS FOUND: ${heavyHitters.length}`);
        log('    (Unidentified scripts over 150 KB)');
        log('======================================================');
        heavyHitters.sort((a, b) => b.sizeKb - a.sizeKb); 
        
        for (const script of heavyHitters) {
            log(`    ${script.sizeKb.toFixed(2)} KB - ${script.url}`);
        }
    }
    log('======================================================');
}