export async function scanStoreLogic(page, logStreamCallback, fingerprintMap) {
  const log = logStreamCallback || (() => {});
  log('[+] App Scan: Initializing network capture for file sizes...');

  const sizeMap = new Map(); 
  const startTime = Date.now();

  page.on('response', async (response) => {
    const url = response.url();
    if (!/\.(js|css)(\?|$)/i.test(url) || sizeMap.has(url)) return;

    try {
      const headers = response.headers();
      let rawSize = parseInt(headers['content-length'] || 0, 10);
      if (!rawSize) {
          const buffer = await response.buffer();
          rawSize = buffer.length;
      }
      sizeMap.set(url, +(rawSize / 1024).toFixed(2)); 
    } catch (e) {
      sizeMap.set(url, 0);
    }
  });

  try {
    log('[+] Reloading page for network capture...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 90000 });
  } catch {
    log('[!] Warning: Page reload timeout. Using partial data.');
  }

  page.removeAllListeners('response');
  log('[+] Network size capture complete.');

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

  const detectedResources = performanceEntries.map(entry => ({
    url: entry.url,
    durationMs: +entry.durationMs.toFixed(2),
    type: entry.type,
    sizeKb: sizeMap.get(entry.url) || 0
  }));

  // Process data into hierarchical levels
  const scanResults = processAssets(detectedResources, page.url(), fingerprintMap);

  printSimplifiedReport(scanResults, log);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
  log(`[+] App Scan: Analysis complete in ${totalTime}s.`);

  return {
    storeUrl: page.url(),
    executiveSummary: scanResults.executiveSummary,
    topCulprits: scanResults.topCulprits,
    appBreakdown: scanResults.appBreakdown,
    unidentifiedDomains: scanResults.unidentifiedDomains,
    heavyHitters: scanResults.heavyHitters
  };
}

function processAssets(detectedResources, storeUrl, fingerprintMap) { 
    const appMap = new Map();
    const allKnownFingerprints = new Set(fingerprintMap.keys()); 
    const foundHostnames = new Set();
    const unidentifiedHostnames = new Set();
    const heavyHitters = [];
    const HEAVY_HITTER_THRESHOLD_KB = 150; 
    let storeHostname = '';
    
    try {
        storeHostname = new URL(storeUrl).hostname; 
    } catch(e) {}

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
                        totalSizeKb: 0,
                        totalDurationMs: 0,
                        assets: []
                    });
                }

                const appData = appMap.get(appName);
                appData.assets.push(resource); 
                appData.totalSizeKb += resource.sizeKb;
                appData.totalDurationMs += resource.durationMs;
                resourceMatched = true; 
            }
        }
        
        if (!resourceMatched && resource.sizeKb > HEAVY_HITTER_THRESHOLD_KB) {
            if (!hostname.endsWith('myshopify.com') && !hostname.endsWith('cdn.shopify.com') && !hostname.endsWith(storeHostname)) {
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

    let totalAppSizeKb = 0;
    
    const formattedApps = Array.from(appMap.values()).map(appData => {
        totalAppSizeKb += appData.totalSizeKb;
        
        let impact = 'Low';
        if (appData.totalSizeKb > 500 || appData.totalDurationMs > 1000) {
            impact = 'High';
        } else if (appData.totalSizeKb > 150 || appData.totalDurationMs > 400) {
            impact = 'Medium';
        }

        return {
            name: appData.name,
            icon: appData.icon,
            totalSizeKb: +appData.totalSizeKb.toFixed(2),
            totalDurationMs: +appData.totalDurationMs.toFixed(2),
            impact: impact,
            assetCount: appData.assets.length,
            recommendation: appData.recommendation
        };
    });

    formattedApps.sort((a, b) => b.totalSizeKb - a.totalSizeKb);
    const topCulprits = formattedApps.filter(app => app.impact === 'High').slice(0, 3);
    
    const executiveSummary = {
        totalAppsDetected: formattedApps.length,
        totalAppSizeMb: +(totalAppSizeKb / 1024).toFixed(2)
    };

    return {
        executiveSummary,
        topCulprits,
        appBreakdown: formattedApps,
        unidentifiedDomains: Array.from(unidentifiedHostnames),
        heavyHitters
    };
}

function printSimplifiedReport(scanResults, log) { 
    const { executiveSummary, topCulprits, appBreakdown, heavyHitters, storeUrl } = scanResults;
    log('\n======================================================');
    log(`LEVEL 1: EXECUTIVE SUMMARY (${storeUrl})`);
    log('======================================================');
    log(`Total Frontend Apps Detected: ${executiveSummary.totalAppsDetected}`);
    log(`Total Third-Party Script Size: ${executiveSummary.totalAppSizeMb} MB`);

    if (topCulprits.length > 0) {
        log('\n======================================================');
        log('LEVEL 2: THE CULPRITS (HIGH IMPACT APPS)');
        log('======================================================');
        for (const app of topCulprits) {
            log(`- ${app.name} | Added Weight: ${app.totalSizeKb} KB | Delay: ${app.totalDurationMs} ms`);
            if (app.recommendation) log(`  Tip: ${app.recommendation}`);
        }
    }

    log('\n======================================================');
    log('LEVEL 3: APP-BY-APP BREAKDOWN');
    log('======================================================');
    if (appBreakdown.length === 0) {
        log('No known third-party apps were detected.');
    } else {
        for (const app of appBreakdown) {
            log(`[${app.impact.toUpperCase()}] ${app.name} - ${app.totalSizeKb} KB (${app.assetCount} assets)`);
        }
    }
    
    if (heavyHitters && heavyHitters.length > 0) {
        log('\n======================================================');
        log('LEVEL 4: UNIDENTIFIED HEAVY SCRIPTS (>150KB)');
        log('======================================================');
        heavyHitters.sort((a, b) => b.sizeKb - a.sizeKb); 
        for (const script of heavyHitters) {
            log(`${script.sizeKb.toFixed(2)} KB - ${script.url}`);
        }
    }
    log('======================================================\n');
}
