export async function scanStoreLogic(page, logStreamCallback, fingerprintMap) {
  const log = logStreamCallback || (() => {});
  log('[+] App Scan: Initializing network capture for file sizes...');

  const sizeMap = new Map();
  const startTime = Date.now();

  // Capture JS/CSS sizes
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
    } catch {
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

  log('[+] App Scan: Harvesting resource durations...');
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

  const scanResults = processAssets(detectedResources, page.url(), fingerprintMap);

  printSimplifiedReport(scanResults, log);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
  log(`[+] App Scan complete in ${totalTime}s.`);

  return {
    storeUrl: page.url(),
    executiveSummary: scanResults.executiveSummary,
    topCulprits: scanResults.topCulprits,
    appBreakdown: scanResults.appBreakdown,
    unidentifiedDomains: scanResults.unidentifiedDomains,
    heavyHitters: scanResults.heavyHitters
  };
}


// --------------------------------------------------
// PROCESS ASSETS
// --------------------------------------------------
function processAssets(detectedResources, storeUrl, fingerprintMap) {
  const appMap = new Map();
  const allFingerprints = new Set(fingerprintMap.keys());

  const foundHostnames = new Set();
  const unidentifiedHostnames = new Set();
  const heavyHitters = [];

  const HEAVY_THRESHOLD = 150;
  let storeHostname = '';

  try {
    storeHostname = new URL(storeUrl).hostname;
  } catch {}

  for (const resource of detectedResources) {
    let hostname;

    try {
      hostname = new URL(resource.url).hostname;
    } catch {
      continue;
    }

    foundHostnames.add(hostname);

    let matched = false;

    for (const [fingerprint, appInfo] of fingerprintMap.entries()) {
      if (resource.url.includes(fingerprint)) {
        const appName = appInfo.name;

        if (!appMap.has(appName)) {
          appMap.set(appName, {
            name: appName,
            icon: appInfo.icon,
            recommendation: appInfo.recommendation,
            totalSizeKb: 0,
            totalDurationMs: 0,
            assets: []
          });
        }

        const app = appMap.get(appName);
        app.assets.push(resource);
        app.totalSizeKb += resource.sizeKb;
        app.totalDurationMs += resource.durationMs;

        matched = true;
      }
    }

    // Heavy unidentified scripts
    if (!matched && resource.sizeKb > HEAVY_THRESHOLD) {
      if (
        !hostname.includes('shopify') &&
        !hostname.includes(storeHostname)
      ) {
        heavyHitters.push({
          url: resource.url,
          sizeKb: resource.sizeKb
        });
      }
    }
  }

  // Detect unidentified domains
  for (const hostname of foundHostnames) {
    if (
      hostname.includes(storeHostname) ||
      hostname.includes('shopify')
    ) continue;

    let known = false;

    for (const fp of allFingerprints) {
      if (hostname.includes(fp)) {
        known = true;
        break;
      }
    }

    if (!known) {
      unidentifiedHostnames.add(hostname);
    }
  }

  let totalAppSizeKb = 0;

  const formattedApps = Array.from(appMap.values()).map(app => {
    totalAppSizeKb += app.totalSizeKb;

    let impact = 'Low';

    // Improved realistic logic
    if (app.totalSizeKb > 400 || app.totalDurationMs > 1200) {
      impact = 'High';
    } else if (app.totalSizeKb > 150 || app.totalDurationMs > 500) {
      impact = 'Medium';
    }

    return {
      name: app.name,
      icon: app.icon,
      totalSizeKb: +app.totalSizeKb.toFixed(2),
      totalDurationMs: +app.totalDurationMs.toFixed(2),
      impact,
      assetCount: app.assets.length,
      recommendation: app.recommendation
    };
  });

  formattedApps.sort((a, b) => b.totalSizeKb - a.totalSizeKb);

  const topCulprits = formattedApps
    .filter(app => app.impact === 'High')
    .slice(0, 3);

  // ✅ NEW FIXES (IMPORTANT)
  const totalRequests = detectedResources.length;
  const highImpactApps = formattedApps.filter(a => a.impact === 'High').length;

  const executiveSummary = {
    totalAppsDetected: formattedApps.length,
    totalAppSizeMb: +(totalAppSizeKb / 1024).toFixed(2),
    totalRequests,
    highImpactApps
  };

  return {
    executiveSummary,
    topCulprits,
    appBreakdown: formattedApps,
    unidentifiedDomains: Array.from(unidentifiedHostnames),
    heavyHitters
  };
}


// --------------------------------------------------
// LOG REPORT (TERMINAL)
// --------------------------------------------------
function printSimplifiedReport(scanResults, log) {
  const { executiveSummary, topCulprits, appBreakdown, heavyHitters, storeUrl } = scanResults;

  log('\n================ SUMMARY =================');
  log(`Store: ${storeUrl}`);
  log(`Apps: ${executiveSummary.totalAppsDetected}`);
  log(`Size: ${executiveSummary.totalAppSizeMb} MB`);
  log(`Requests: ${executiveSummary.totalRequests}`);

  if (topCulprits.length) {
    log('\n=== HIGH IMPACT APPS ===');
    topCulprits.forEach(app => {
      log(`- ${app.name} (${app.totalSizeKb} KB, ${app.totalDurationMs} ms)`);
    });
  }

  if (heavyHitters.length) {
    log('\n=== HEAVY UNKNOWN SCRIPTS ===');
    heavyHitters
      .sort((a, b) => b.sizeKb - a.sizeKb)
      .forEach(s => log(`${s.sizeKb} KB - ${s.url}`));
  }

  log('========================================\n');
}
