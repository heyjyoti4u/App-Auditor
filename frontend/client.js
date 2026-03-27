// --- GLOBAL VARIABLE DECLARATION FOR ALL COMPONENTS ---
let logOutputEl;
let loadingMessageEl;
let terminalSpinner;
let unidentifiedAppsSection;
let heavyHittersSection;
let resultsWrapper;
let errorEl;
let errorMsgEl;

// --- PERFORMANCE HELPER FUNCTIONS ---

/**
 * Parses the numeric value from a metric string (e.g., "3.3 s" -> 3.3)
 */
const parseMetricValue = (metricString) => {
    if (typeof metricString !== 'string' || !metricString) return 0;
    return parseFloat(metricString.replace(/[^0-9.]/g, ''));
};

/**
 * Returns 'good', 'average', or 'poor' based on Lighthouse thresholds
 */
const getMetricRating = (value, goodMax, avgMax) => {
    if (value <= goodMax) return 'good';
    if (value <= avgMax) return 'average';
    return 'poor';
};

/**
 * Returns 'score-good', 'score-average', or 'score-poor' for a score (0-100)
 */
const getScoreRating = (score) => {
    if (score >= 90) return 'score-good';
    if (score >= 50) return 'score-average';
    return 'score-poor';
};

/**
 * Returns 'good', 'average', or 'poor' based on asset size (KB)
 */
const getSizeRating = (sizeKb) => {
    const goodMax = 200;
    const avgMax = 500;
    if (sizeKb <= goodMax) return 'good';
    if (sizeKb <= avgMax) return 'average';
    return 'poor';
};

/**
 * Returns 'good', 'average', or 'poor' based on asset duration (ms)
 */
const getDurationRating = (durationMs) => {
    const goodMax = 1000;
    const avgMax = 2000;
    if (durationMs <= goodMax) return 'good';
    if (durationMs <= avgMax) return 'average';
    return 'poor';
};

/**
 * Returns overall impact rating (text and class) based on combined size and duration
 */
const getOverallImpactRating = (sizeKb, durationMs) => {
    let score = 0;

    // Size impact
    if (sizeKb > 1000) score += 3;
    else if (sizeKb > 500) score += 2;
    else if (sizeKb > 200) score += 1;

    // Duration impact
    if (durationMs > 4000) score += 3;
    else if (durationMs > 2000) score += 2;
    else if (durationMs > 1000) score += 1;

    if (score >= 5) return { text: 'Critical', class: 'impact-critical' };
    if (score >= 3) return { text: 'High', class: 'impact-high' };
    if (score >= 1) return { text: 'Medium', class: 'impact-medium' };
    return { text: 'Low', class: 'impact-low' };
};

/**
 * Helper function for TBT parsing
 */
const parseTBT = (tbtString) => {
    if (typeof tbtString !== 'string' || !tbtString) return 0;
    return parseFloat(tbtString.replace(/[^0-9.]/g, ''));
};

  


function renderGlobalAppReport() {
    const dataString = sessionStorage.getItem('lastScanData');
    const container = document.getElementById('report-container');
    const offendersContainer = document.getElementById('top-offenders-container');
    const statsContainer = document.getElementById('overall-stats-container');
    const noDataEl = document.getElementById('no-data-placeholder');

    if (!container || !noDataEl || !offendersContainer || !statsContainer) return;

    if (!dataString || dataString === '{"appReport":null,"perfReport":null}') {
        noDataEl.style.display = 'block';
        return;
    }

    const { appReport } = JSON.parse(dataString);

    // Ye condition match hogi tabhi apps dikhenge
    if (appReport && appReport.executiveSummary && appReport.appBreakdown) {
        noDataEl.style.display = 'none';

        const exec = appReport.executiveSummary;
        const statsHtml = `
            <div class="overall-stats-grid">
                <div class="stat-card">
                    <h4>Total Frontend Apps</h4>
                    <span class="stat-value">${exec.totalAppsDetected}</span>
                </div>
                <div class="stat-card">
                    <h4>Total 3rd-Party Size</h4>
                    <span class="stat-value">${exec.totalAppSizeMb} MB</span>
                </div>
            </div>
        `;
        statsContainer.innerHTML = statsHtml;

        const culprits = appReport.topCulprits || [];
        if (culprits.length > 0) {
            let culpritsHtml = '<ol class="heavy-assets-list" style="margin: 0; padding-left: 20px;">';
            culprits.forEach(app => {
                culpritsHtml += `
                    <li style="margin-bottom: 10px;">
                        <span class="offender-name" style="font-weight: 600; font-size: 1.1em;">
                            ${app.icon ? `<img src="${app.icon}" class="app-icon-small" style="vertical-align:middle;margin-right:8px;border-radius:4px;width:24px;height:24px;">` : ''}
                            ${app.name}
                        </span>
                        <div style="margin-top: 5px; color: var(--error-color);">
                            Added Weight: ${app.totalSizeKb} KB | Delay: ${app.totalDurationMs} ms
                        </div>
                        ${app.recommendation ? `<div style="font-size: 0.9em; margin-top: 5px; color: #555;">Tip: ${app.recommendation}</div>` : ''}
                    </li>`;
            });
            culpritsHtml += '</ol>';

            offendersContainer.innerHTML = `
                <div class="card offenders-summary-card" style="border-left: 4px solid var(--error-color);">
                    <h3 style="color: var(--error-color); margin-bottom: 15px;"> The Culprits (High Impact Apps)</h3>
                    ${culpritsHtml}
                </div>
            `;
        } else {
            offendersContainer.innerHTML = '';
        }

        const appBreakdown = appReport.appBreakdown || [];
        let html = '';

        appBreakdown.forEach(app => {
            let impactClass = 'impact-low';
            if (app.impact === 'High') impactClass = 'impact-critical';
            else if (app.impact === 'Medium') impactClass = 'impact-medium';

            html += `
                <div class="card app-card animated-card" style="margin-bottom: 20px; padding-bottom: 20px;">
                    <div class="impact-badge ${impactClass}">${app.impact} Impact</div>
                    <div class="app-card-content-wrapper">
                        <div class="app-card-header">
                            ${app.icon ? `<img src="${app.icon}" class="app-icon" alt="${app.name}">` : '<span class="app-icon-placeholder"></span>'}
                            <div class="app-card-title-wrapper">
                                <h4>${app.name}</h4>
                            </div>
                        </div>
                        <p><strong>Total Assets Loaded:</strong> ${app.assetCount}</p>
                        <hr style="border-top: 1px solid var(--border-color); margin: 15px 0;">
                        <div class="app-card-body">
                            <div class="asset-impact-summary">
                                <p><strong>Total Resource Size:</strong> <strong>${app.totalSizeKb} KB</strong></p>
                                <p><strong>Total Load Duration:</strong> <strong>${app.totalDurationMs} ms</strong></p>
                            </div>
                        </div>
                    </div>
                    ${app.recommendation ? `
                        <div class="recommendation-box" style="margin-top: 15px;">
                            <strong>Optimization Tip:</strong>
                            <p>${app.recommendation}</p>
                        </div>
                    ` : ''}
                </div>
            `;
        });

        container.innerHTML = html;
        const sortContainer = document.getElementById('sort-controls-container');
        if (sortContainer) sortContainer.style.display = 'none'; 

    } else {
        noDataEl.style.display = 'block';
    }
}





// --- NEW: Attach listeners for the heavy asset accordions ---
function attachHeavyAssetListeners() {
  const headers = document.querySelectorAll('.heavy-assets-header');
  if (!headers.length) return; // No headers found

  headers.forEach(header => {
    header.addEventListener('click', () => {
      const content = header.nextElementSibling;
      if (!content) return; // Prevent error if missing
      const icon = header.querySelector('i.fas');

      const isOpen = header.classList.contains('open');

      if (isOpen) {
        // Collapse
        content.style.maxHeight = null;
        header.classList.remove('open');
        if (icon) {
          icon.classList.remove('fa-chevron-down');
          icon.classList.add('fa-chevron-right');
        }
      } else {
        // Expand
        content.style.maxHeight = content.scrollHeight + 'px';
        header.classList.add('open');
        if (icon) {
          icon.classList.remove('fa-chevron-right');
          icon.classList.add('fa-chevron-down');
        }
      }
    });
  });
}

/**
 * Builds an HTML list for a top-offenders column.
 * @param {Array} apps - The sorted array of app metric objects.
 * @param {string} metricKey - The key to get the value (e.g., 'totalSizeKb').
 * @param {string} unit - The unit to display (e.g., 'KB' or 'ms').
 */
function buildOffendersList(apps, metricKey, unit) {
    // Check if apps exist and the top app has a value > 0
    if (!apps || apps.length === 0 || apps[0][metricKey] <= 0.01) {
        return '<p class="no-offenders">No significant offenders found.</p>';
    }
    
    let html = '<ol>';
    apps.forEach(app => {
        const value = app[metricKey];
        html += `
            <li>
                <span class="offender-name" title="${app.name}">
                    ${app.icon ? `<img src="${app.icon}" class="app-icon-small">` : '<span class="app-icon-placeholder-small"></span>'}
                    ${app.name}
                </span>
                <span class="offender-value">${value.toFixed(unit === 'KB' ? 2 : 0)} ${unit}</span>
            </li>`;
    });
    html += '</ol>';
    return html;
}

// --- (FINAL CLEANED & FIXED) Functionality for Global Performance Report Page ---
function renderGlobalPerfReport() {
    const dataString = sessionStorage.getItem('lastScanData');
    const container = document.getElementById('report-container');
    const noDataEl = document.getElementById('no-data-placeholder');

    if (!container || !noDataEl) {
        console.error("Report containers not found on this page.");
        return;
    }

    if (!dataString || dataString === '{"appReport":null,"perfReport":null}') {
        console.log("No scan data found in session.");
        noDataEl.style.display = 'block';
        return;
    }

    // Extract perfReport from stored session data
    const { perfReport } = JSON.parse(dataString);

    // Check if the main performance report data exists
    if (perfReport && perfReport.metrics && perfReport.categories && perfReport.audits && perfReport.culprits) {
        console.log("Performance Report Data Found. Rendering...");
        noDataEl.style.display = 'none';

        // 1. Render your existing report HTML
        container.innerHTML = createDetailedPerfReport(
            perfReport.metrics,
            perfReport.categories,
            perfReport.audits,
            perfReport.culprits
        );

        // 2. Add event listeners for your accordions (if function exists)
        if (typeof attachAccordionListeners === 'function') {
            attachAccordionListeners();
        } else {
            console.warn("attachAccordionListeners() not found — skipping accordion setup.");
        }

        // 3. Logic to render all charts
        if (perfReport.audits) {
            // Load BOTH Google Charts packages
            google.charts.load('current', { packages: ['timeline', 'corechart'] });

            // Callback after library is loaded
            google.charts.setOnLoadCallback(() => {
                // --- Find containers INSIDE the callback ---
                const waterfallContainer = document.getElementById('waterfall-chart-container');
                const mainThreadContainer = document.getElementById('main-thread-chart-container');

                // --- Draw Waterfall Chart ---
                if (
                    perfReport.audits['network-requests'] &&
                    perfReport.audits['network-requests'].details &&
                    perfReport.audits['network-requests'].details.items
                ) {
                    const networkRequests = perfReport.audits['network-requests'].details.items;
                    drawWaterfallChart(networkRequests, waterfallContainer);
                } else if (waterfallContainer) {
                    console.warn("Network request data not found in the report.");
                    waterfallContainer.innerHTML = `
                        <p style="text-align: center; padding: 20px; color: var(--error-color);">
                            Network request data is not available in the report.
                        </p>`;
                }

                // --- Draw Main Thread Chart ---
                if (
                    perfReport.audits['mainthread-work-breakdown'] &&
                    perfReport.audits['mainthread-work-breakdown'].details &&
                    perfReport.audits['mainthread-work-breakdown'].details.items
                ) {
                    const mainThreadData = perfReport.audits['mainthread-work-breakdown'].details.items;
                    drawMainThreadChart(mainThreadData, mainThreadContainer);
                } else if (mainThreadContainer) {
                    console.warn("Main-thread breakdown data not found in the report.");
                    mainThreadContainer.innerHTML = `
                        <p style="text-align: center; padding: 20px; color: var(--error-color);">
                            Main-thread data is not available.
                        </p>`;
                }
            });
        } else {
            // Fallback if perfReport.audits is missing
            console.error("No audits object found in the performance report.");
            const waterfallContainer = document.getElementById('waterfall-chart-container');
            const mainThreadContainer = document.getElementById('main-thread-chart-container');

            if (waterfallContainer)
                waterfallContainer.innerHTML = '<p>Error loading chart data.</p>';
            if (mainThreadContainer)
                mainThreadContainer.innerHTML = '<p>Error loading chart data.</p>';
        }

    } else {
        console.log("No Performance Report data in session. Please run a scan with 'Performance Report' enabled.");
        noDataEl.style.display = 'block';
    }
}



/**
 * Draws the Main-Thread Activity pie chart using Google Charts.
 * @param {Array} mainThreadData - The array of items from the mainthread-work-breakdown audit.
 * @param {HTMLElement} container - The element to draw the chart in.
 */
function drawMainThreadChart(mainThreadData, container) {
    console.log("--- RUNNING 'drawMainThreadChart' ---");

    if (!container) {
        console.error("Main thread chart container not found!");
        return;
    }

    const dataTable = new google.visualization.DataTable();
    dataTable.addColumn('string', 'Activity');
    dataTable.addColumn('number', 'Time (ms)');

    // Process the data
    const rows = mainThreadData
        .map(item => {
            // Only include valid durations
            if (item.duration > 0.1) {
                return [item.groupLabel || 'Unknown', item.duration];
            }
            return null;
        })
        .filter(Boolean); // Remove null entries

    if (rows.length === 0) {
        container.innerHTML = `
            <p style="text-align: center; padding: 20px;">
                No main-thread activity was recorded.
            </p>`;
        return;
    }

    dataTable.addRows(rows);

    // Chart options
    const options = {
        title: 'Breakdown of CPU Time (ms)',
        pieHole: 0.4, // Donut chart
        backgroundColor: 'transparent',
        chartArea: { left: 10, top: 50, width: '90%', height: '80%' },
        legend: {
            position: 'right',
            alignment: 'center',
            textStyle: { color: '#333', fontSize: 13 }
        },
        titleTextStyle: {
            color: '#333',
            fontSize: 16,
            bold: false,
            alignment: 'center'
        },
        tooltip: {
            text: 'value',
            showColorCode: true,
            textStyle: { color: '#000' }
        },
        fontName: 'Inter',
        pieSliceTextStyle: {
            color: '#111',
            fontSize: 12
        },
        colors: [
            '#8AB4F8', '#F28B82', '#FDD663',
            '#80C995', '#C58AF9', '#FD9A4F', '#AECBFA'
        ]
    };

    // Draw the chart
    const chart = new google.visualization.PieChart(container);
    chart.draw(dataTable, options);
}



// --- NEW: Functionality for History Page (history.html) ---
function renderHistoryPage() {
    // Check if Chart.js is loaded
    if (typeof Chart === 'undefined') {
        console.error('Chart.js is not loaded. Cannot render history charts.');
        document.getElementById('no-data-placeholder').innerHTML = '<p>Error: Chart.js library is not loaded. Please check your HTML file.</p>';
        document.getElementById('no-data-placeholder').style.display = 'block';
        return;
    }

    const historyDataString = localStorage.getItem('appAuditorHistory');
    const noDataEl = document.getElementById('no-data-placeholder');
    const chartsContainerEl = document.getElementById('charts-container');
    const kpiContainerEl = document.getElementById('kpi-container'); // Get new KPI container

    // Check for all required elements
    if (!noDataEl || !chartsContainerEl || !kpiContainerEl) {
        console.error('History page HTML elements not found (missing no-data-placeholder, charts-container, or kpi-container).');
        return;
    }

    const history = historyDataString ? JSON.parse(historyDataString) : [];

    // --- Check if data exists ---
    if (!history || history.length === 0) {
        noDataEl.style.display = 'block';
        chartsContainerEl.style.display = 'none';
        kpiContainerEl.style.display = 'none'; // Hide KPIs if no data
        return;
    }

    // --- Data exists, show the content ---
    noDataEl.style.display = 'none';
    chartsContainerEl.style.display = 'grid'; // Use 'grid' to match CSS
    kpiContainerEl.style.display = 'grid'; // Use 'grid' to match CSS

    // --- 1. Process Data for KPIs and Charts ---
    const labels = history.map(entry => new Date(entry.date).toLocaleString());
    const perfScores = history.map(entry => entry.performanceScore);
    const accScores = history.map(entry => entry.accessibilityScore);
    const bpScores = history.map(entry => entry.bestPracticesScore);
    const seoScores = history.map(entry => entry.seoScore);
    const lcpData = history.map(entry => entry.lcp);
    const tbtData = history.map(entry => entry.tbt);
    const clsData = history.map(entry => entry.cls);

    // --- 2. Calculate and Populate KPIs ---
    const totalScans = history.length;
    const avgPerf = (perfScores.reduce((a, b) => a + b, 0) / totalScans).toFixed(0);
    const avgLCP = (lcpData.reduce((a, b) => a + b, 0) / totalScans).toFixed(2);
    const avgTBT = (tbtData.reduce((a, b) => a + b, 0) / totalScans).toFixed(0);

    const kpiPerfEl = document.getElementById('kpi-avg-perf');
    kpiPerfEl.textContent = avgPerf;
    kpiPerfEl.className = `kpi-value ${getScoreRating(avgPerf)}`; // Add color
    
    document.getElementById('kpi-avg-lcp').textContent = avgLCP;
    document.getElementById('kpi-avg-tbt').textContent = avgTBT;
    document.getElementById('kpi-total-scans').textContent = totalScans;

    // Add color ratings for LCP and TBT KPIs
    document.getElementById('kpi-avg-lcp').className = `kpi-value ${getMetricRating(avgLCP, 2.5, 4.0)}`;
    document.getElementById('kpi-avg-tbt').className = `kpi-value ${getMetricRating(avgTBT, 200, 600)}`;


    // --- 3. Render Scores Chart ---
    const scoresCtx = document.getElementById('scoresChart');
    if (scoresCtx) {
        // Fix for LIGHT mode text
        Chart.defaults.color = '#6c757d'; // Standard grey for axes/text
        Chart.defaults.borderColor = '#e0e0e0'; // Light grey grid lines

        new Chart(scoresCtx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    { label: 'Performance', data: perfScores, borderColor: '#10b981', tension: 0.1, pointBackgroundColor: '#10b981' },
                    { label: 'Accessibility', data: accScores, borderColor: '#3b82f6', tension: 0.1, pointBackgroundColor: '#3b82f6' },
                    { label: 'Best Practices', data: bpScores, borderColor: '#eab308', tension: 0.1, pointBackgroundColor: '#eab308' },
                    { label: 'SEO', data: seoScores, borderColor: '#ef4444', tension: 0.1, pointBackgroundColor: '#ef4444' }
                ]
            },
            options: {
                responsive: true, 
                maintainAspectRatio: false,
                plugins: { 
                    title: { display: false }, 
                    legend: { labels: { color: '#333' } } // Dark legend text
                },
                scales: { 
                    y: { 
                        beginAtZero: true, max: 100,
                        ticks: { color: '#333' }, // Dark number labels
                        title: { display: false }
                    },
                    x: { 
                        ticks: { color: '#333' }, // Dark date labels
                        grid: { display: false }
                    }
                }
            }
        });
    }

    // --- 4. Render Core Vitals Chart (with Dual-Axis FIX) ---
    const vitalsCtx = document.getElementById('vitalsChart');
    if (vitalsCtx) {
        new Chart(vitalsCtx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'LCP (s)',
                        data: lcpData,
                        borderColor: '#3b82f6',
                        tension: 0.1,
                        yAxisID: 'yS', // Assign to 's' axis
                        pointBackgroundColor: '#3b82f6'
                    },
                    {
                        label: 'TBT (ms)',
                        data: tbtData,
                        borderColor: '#ef4444',
                        tension: 0.1,
                        yAxisID: 'yMs', // Assign to 'ms' axis
                        pointBackgroundColor: '#ef4444'
                    },
                    {
                        label: 'CLS',
                        data: clsData,
                        borderColor: '#eab308',
                        tension: 0.1,
                        yAxisID: 'yS', // Assign to 's' axis (same as LCP)
                        pointBackgroundColor: '#eab308'
                    }
                ]
            },
            options: {
                responsive: true, 
                maintainAspectRatio: false,
                plugins: { 
                    title: { display: false },
                    legend: { labels: { color: '#333' } } // Dark legend text
                },
                scales: {
                    yS: { // Axis for LCP (s) and CLS (unitless)
                        type: 'linear', 
                        position: 'left',
                        beginAtZero: true,
                        title: { display: true, text: 'LCP (s) / CLS', color: '#333' },
                        ticks: { color: '#333' }
                    },
                    yMs: { // Axis for TBT (ms)
                        type: 'linear', 
                        position: 'right', 
                        beginAtZero: true,
                        title: { display: true, text: 'TBT (ms)', color: '#333' },
                        ticks: { color: '#333' },
                        grid: { display: false } // Hide grid for this axis
                    },
                    x: { 
                        ticks: { color: '#333' }, // Dark date labels
                        grid: { display: false }
                    }
                }
            }
        });
    }

    // --- 5. Add Clear History Button Listener ---
    const clearBtn = document.getElementById('clearHistoryBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to delete all scan history? This cannot be undone.')) {
                localStorage.removeItem('appAuditorHistory');
                location.reload(); // Reload the page
            }
        });
    }
}


// --- NEW: Attach listeners for the collapsible accordions ---
function attachAccordionListeners() {
    document.querySelectorAll('.audit-accordion-header').forEach(header => {
        // Auto-expand 'open' sections on load
        if (header.classList.contains('open')) {
            const content = header.nextElementSibling;
            if (content) content.style.maxHeight = content.scrollHeight + "px";
        }

        header.addEventListener('click', () => {
            const content = header.nextElementSibling;
            const icon = header.querySelector('i.fas');
            
            if (content.style.maxHeight) {
                // Collapse
                content.style.maxHeight = null;
                if (icon) {
                    icon.classList.remove('fa-chevron-down');
                    icon.classList.add('fa-chevron-right');
                }
                header.classList.remove('open');
            } else {
                // Expand
                content.style.maxHeight = content.scrollHeight + "px";
                if (icon) {
                    icon.classList.remove('fa-chevron-right');
                    icon.classList.add('fa-chevron-down');
                }
                header.classList.add('open');
            }
        });
    });
}

// --- (NEW) DETAILED PERFORMANCE REPORT BUILDER ---
function createDetailedPerfReport(metrics, categories, audits, culprits) {
    return `
        <div class="perf-report-detailed-layout">
            <div class="perf-report-sidebar">
                ${createPerfGauge(metrics.performanceScore)}
                ${createCategoryScores(categories)}
            </div>
            <div class="perf-report-main">
                <h3 class="section-title">Core Metrics</h3>
                <div class="perf-metrics-grid">
                    ${createCoreMetricCard('lcp', metrics.lcp)}
                    ${createCoreMetricCard('tbt', metrics.tbt)}
                    ${createCoreMetricCard('cls', metrics.cls)}
                    ${createCoreMetricCard('fcp', metrics.fcp)}
                    ${createCoreMetricCard('speedIndex', metrics.speedIndex)}
                </div>
                
                ${createShopifyChecklist(audits, metrics)}

                <h3 class="section-title" style="margin-top: 25px;">Main-Thread Activity Breakdown</h3>
                <div class="card" style="padding: 20px;">
                    <p style="font-size: 0.9em; color: #666; margin-top: 5px; margin-bottom: 20px;">
                        A breakdown of all CPU activity, showing what's responsible for blocking time.
                    </p>
                    <div id="main-thread-chart-container" style="width: 100%; height: 400px;">
                        <p style="text-align: center; padding: 20px;">Loading chart data...</p>
                    </div>
                </div>

                ${createCulpritSection(culprits)}

                <h3 class="section-title" style="margin-top: 25px;">Lighthouse Audits</h3>
                ${createAuditSection(audits, categories.performance.auditRefs, 'Performance Opportunities', false)}
                ${createAuditSection(audits, categories.accessibility.auditRefs, 'Accessibility Issues', false)}
                ${createAuditSection(audits, categories['best-practices'].auditRefs, 'Best Practices Issues', false)}
                ${createAuditSection(audits, categories.seo.auditRefs, 'SEO Issues', false)}
                
                <h3 class="section-title">Advanced Diagnostics</h3>
                ${createMainThreadWorkSection(audits)}
                ${createFontAuditSection(audits)}
                ${createImageAuditSection(audits)}
                ${createUnusedCodeSection(audits)}

                <h3 class="section-title">Passed Audits</h3>
                ${createAuditSection(audits, categories.performance.auditRefs, 'Performance Passed Audits', true)}
                ${createAuditSection(audits, categories.accessibility.auditRefs, 'Accessibility Passed Audits', true)}
                ${createAuditSection(audits, categories['best-practices'].auditRefs, 'Best Practices Passed Audits', true)}
                ${createAuditSection(audits, categories.seo.auditRefs, 'SEO Passed Audits', true)}

                <div id="waterfall-card">
                    <h3 class="section-title">Network Request Waterfall</h3>
                    <p style="font-size: 0.9em; color: #666;">
                        This chart shows a timeline of every file loaded by the page.
                        Long bars represent slow resources, while gaps represent browser idle or blocked time.
                    </p>
                    <div id="waterfall-chart-container" style="width: 100%; height: 800px;">
                        <p style="text-align: center; padding: 20px;">Loading chart data...</p>
                    </div>
                </div>
            </div>
        </div>
    `;
}



// --- NEW HELPER: Builds the big gauge ---
function createPerfGauge(score) {
    const scoreNum = parseInt(score, 10);
    const scoreClass = getScoreRating(scoreNum);
    const circumference = 2 * Math.PI * 54; 
    const offset = circumference - (scoreNum / 100) * circumference;

    return `
        <div class="perf-score-gauge-wrapper card">
            <svg class="perf-score-gauge" viewBox="0 0 120 120">
                <circle class="gauge-bg" cx="60" cy="60" r="54"></circle>
                <circle class="gauge-fg ${scoreClass}" cx="60" cy="60" r="54"
                    stroke-dasharray="${circumference}"
                    stroke-dashoffset="${offset}"
                ></circle>
            </svg>
            <div class="gauge-content">
                <div class="gauge-value ${scoreClass}">${scoreNum}</div>
                <div class="gauge-label">Performance Score</div>
            </div>
        </div>
    `;
}

// --- NEW HELPER: Builds the 4 summary score cards ---
function createCategoryScores(categories) {
    return `
        <div class="category-scores-grid">
            ${createCategoryCard(categories.performance)}
            ${createCategoryCard(categories.accessibility)}
            ${createCategoryCard(categories['best-practices'])}
            ${createCategoryCard(categories.seo)}
        </div>
    `;
}

// --- NEW HELPER: Builds a single category score card ---
function createCategoryCard(category) {
    if (!category) return '';
    const score = Math.round(category.score * 100);
    const rating = getScoreRating(score);
    
    let icon = 'fa-rocket';
    if (category.id === 'accessibility') icon = 'fa-universal-access';
    if (category.id === 'best-practices') icon = 'fa-check-circle';
    if (category.id === 'seo') icon = 'fa-search';

    return `
        <div class="category-card card ${rating}">
            <i class="fas ${icon} category-icon"></i>
            <div class="category-card-content">
                <div class="category-card-title">${category.title}</div>
                <div class="category-card-score">${score}</div>
            </div>
        </div>
    `;
}


// --- NEW HELPER: Builds a Core Web Vital metric card ---
function createCoreMetricCard(metricKey, displayValue) {
    const definitions = {
        lcp: { title: 'Largest Contentful Paint (LCP)', good: 2.5, avg: 4.0, desc: 'Measures loading performance.' },
        tbt: { title: 'Total Blocking Time (TBT)', good: 200, avg: 600, desc: 'Measures load responsiveness.' },
        cls: { title: 'Cumulative Layout Shift (CLS)', good: 0.1, avg: 0.25, desc: 'Measures visual stability.' },
        fcp: { title: 'First Contentful Paint (FCP)', good: 1.8, avg: 3.0, desc: 'Measures first paint time.' },
        speedIndex: { title: 'Speed Index', good: 3.4, avg: 5.8, desc: 'Measures how quickly content is populated.' }
    };
    
    const definition = definitions[metricKey];
    if (!definition) return '';

    const value = parseMetricValue(displayValue);
    
    let rating;
    if (metricKey === 'cls') {
        rating = getMetricRating(value, definition.good, definition.avg);
    } else if (metricKey === 'tbt') {
        rating = getMetricRating(value, definition.good, definition.avg); // TBT is in ms
    } else {
        // LCP, FCP, SI are in 's'
        rating = getMetricRating(value, definition.good, definition.avg); 
    }

    return `
        <div class="metric-card card">
            <div class="metric-header">
                <span class="metric-rating-dot ${rating}"></span>
                <h4 class="metric-title">${definition.title}</h4>
            </div>
            <div class="metric-value ${rating}">${displayValue}</div>
            <p class="metric-description">${definition.desc}</p>
        </div>
    `;
}

// --- NEW HELPER: Builds the detailed, collapsible audit sections ---
function createAuditSection(allAudits, auditRefs, sectionTitle, showPassed) {
    
    // --- THIS IS THE FIX ---
    // Filter the refs to only include relevant ones
    const relevantAuditRefs = auditRefs.filter(ref => {
        // ALWAYS exclude metrics from these lists.
        if (ref.group === 'metrics') {
            return false;
        }
        // For the "Performance Opportunities" list, only show specific groups.
        if (sectionTitle === 'Performance Opportunities') {
            return ref.group === 'load-opportunities' || ref.group === 'diagnostics';
        }
        // For all other sections (SEO, Accessibility, etc.), just show everything that isn't a metric.
        return true;
    });
    // --- END OF FIX ---
    
    const relevantAuditIds = relevantAuditRefs.map(ref => ref.id);

    let auditRowsHtml = '';
    let count = 0;
    
    for (const auditId of relevantAuditIds) {
        const audit = allAudits[auditId];
        
        // Skip audits that are not relevant
        if (!audit || audit.scoreDisplayMode === 'manual' || audit.scoreDisplayMode === 'notApplicable') {
            continue;
        }

        const passed = audit.score === 1;

        // If we are building the "Passed" list, skip failed/neutral audits
        if (showPassed && !passed) continue;
        // If we are building the "Failed" list, skip passed audits
        if (!showPassed && passed) continue;
            
        // Only show audits that have items OR are a simple pass/fail
        // (but for failed, don't show if it has no items)
        if (!showPassed && audit.details && (audit.details.type === 'table' || audit.details.type === 'list') && audit.details.items.length === 0) {
            continue; // Don't show empty failed audits
        }

        count++;
        auditRowsHtml += `
            <div class="audit-row">
                <div class="audit-row-header">
                    <span class="audit-row-score ${getScoreRating(audit.score * 100)}"></span>
                    <span class="audit-row-title">${audit.title}</span>
                    <span class="audit-row-value">${audit.displayValue || ''}</span>
                </div>
                <div class="audit-row-description">${audit.description.replace(/\[Learn more\]\(.*\)/, '')}</div>
            </div>
        `;
    }

    if (count === 0) {
        // If we are showing passed audits and none were found (which is bad), show nothing.
        if (showPassed) return '';

        // If we are showing failed audits and none were found, show the "Passed" message
        return `
            <div class="audit-section">
                <div class="audit-accordion-header passed"> 
                    <i class="fas fa-chevron-right"></i>
                    <h3>${sectionTitle}</h3>
                </div>
                <div class="audit-accordion-content" style="max-height: 0;">
                    <div class="audit-row-passed">
                        <i class="fas fa-check-circle"></i>
                        All checks passed!
                    </div>
                </div>
            </div>
        `;
    }

    // Default to closed for "Passed" lists, open for "Failed" lists
    const startOpen = !showPassed;
    const openClass = ''; // <-- FIX: Default to closed
    const iconClass = 'fa-chevron-right'; // <-- FIX: Default to closed
    const initialHeight = '0'; // <-- FIX: Default to closed
    
    const sectionClass = showPassed ? 'passed-section' : '';

    return `
        <div class="audit-section ${sectionClass}">
            <div class="audit-accordion-header ${openClass}">
                <i class="fas ${iconClass}"></i>
                <h3>${sectionTitle} <span class="audit-count">(${count} items)</span></h3>
            </div>
            <div class="audit-accordion-content" style="max-height: ${initialHeight};">
                ${auditRowsHtml}
            </div>
        </div>
    `;
}

// --- (NEW) HELPER: Builds the "Culprit" Report ---
function createCulpritSection(culprits) {
    // This new function now checks for the .identified and .unidentified arrays
    if (!culprits || (culprits.identified.length === 0 && culprits.unidentified.length === 0)) {
        return ''; // Don't show the section if no culprits were found
    }

    let itemsHtml = '';
    let totalItems = 0;
    
    // Add identified culprits first
    culprits.identified.forEach(culprit => {
        totalItems++;
        itemsHtml += `
            <tr class="adv-table-row">
                <td>
                    <div class="culprit-app-name">
                        ${culprit.icon ? `<img src="${culprit.icon}" class="app-icon-small">` : '<span class="app-icon-placeholder-small"></span>'}
                        ${culprit.appName}
                    </div>
                </td>
                <td class="numeric">${culprit.duration.toFixed(1)} ms</td>
            </tr>
        `;
    });

    // --- MODIFICATION START ---
    // Add unidentified offenders next, but clean up the URL
    culprits.unidentified.forEach(culprit => {
        totalItems++;
        
        let displayName = culprit.url;
        const fullUrl = culprit.url; // Keep the full URL for the hover title

        try {
            // Try to parse the URL to get a clean hostname
            const urlObj = new URL(fullUrl);
            displayName = urlObj.hostname; // e.g., "cdn.dynamicyield.com"
        } catch (e) {
            // If it fails (e.g., not a full URL), just truncate the original
            displayName = displayName.length > 50 ? '...' + displayName.slice(-50) : displayName;
        }

        itemsHtml += `
            <tr class="adv-table-row">
                <td>
                    <div class="culprit-app-name">
                        <span class="app-icon-placeholder-small"><i class="fas fa-question"></i></span>
                        <div class="adv-table-url" title="${fullUrl}">${displayName}</div>
                    </div>
                </td>
                <td class="numeric">${culprit.duration.toFixed(1)} ms</td>
            </tr>
        `;
    });
    // --- MODIFICATION END ---

    return `
    <h3 class="section-title">Main-Thread Culprits</h3>
    <div class="audit-section">
        <div class="audit-accordion-header">
            <i class="fas fa-chevron-right"></i>
            <h3>Top 3rd-Party & Unknown Scripts 
                <span class="audit-count">(${totalItems} items)</span>
            </h3>
        </div>
        <div class="audit-accordion-content" style="max-height: 0;">
            <div class="adv-table-container">
                <table class="adv-table">
                    <thead>
                        <tr>
                            <th>App Name / Script Domain</th>
                            <th class="numeric">CPU Time</th>
                        </tr>
                    </thead>
                    <tbody>${itemsHtml}</tbody>
                </table>
            </div>
        </div>
    </div>
`;

}



// --- NEW HELPER: Builds Font Report ---
function createFontAuditSection(allAudits) {
    const audit = allAudits['font-display'];
    if (!audit || audit.score === 1 || !audit.details.items || audit.details.items.length === 0) return '';

    let itemsHtml = audit.details.items.map(item => `
        <tr class="adv-table-row">
            <td><div class="adv-table-url">${item.url}</div></td>
        </tr>
    `).join('');

    return `
        <div class="audit-section">
            <div class="audit-accordion-header">
                <i class="fas fa-chevron-right"></i>
                <h3>Fonts Lacking \`font-display: swap\` <span class="audit-count">(${audit.details.items.length} fonts)</span></h3>
            </div>
            <div class="audit-accordion-content" style="max-height: 0;">
                <div class="adv-table-container">
                    <table class="adv-table">
                        <thead>
                            <tr>
                                <th>Font URL</th>
                            </tr>
                        </thead>
                        <tbody>${itemsHtml}</tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}

// --- NEW HELPER: Builds Image Report ---
function createImageAuditSection(allAudits) {
    const imageAudits = [
        allAudits['uses-optimized-images'],
        allAudits['modern-image-formats'],
        allAudits['efficient-animated-content']
    ].filter(Boolean); // Filter out any undefined audits

    let itemsHtml = '';
    let totalSavings = 0;
    let count = 0;

    imageAudits.forEach(audit => {
        if (audit.details && audit.details.items) {
            audit.details.items.forEach(item => {
                count++;
                totalSavings += item.wastedBytes || 0;
                itemsHtml += `
                    <tr class="adv-table-row">
                        <td><div class="adv-table-url">${item.url}</div></td>
                        <td class="numeric">${(item.totalBytes / 1024).toFixed(1)} KB</td>
                        <td class="numeric">${(item.wastedBytes / 1024).toFixed(1)} KB</td>
                    </tr>
                `;
            });
        }
    });

    if (count === 0) return '';

    return `
        <div class="audit-section">
            <div class="audit-accordion-header">
                <i class="fas fa-chevron-right"></i>
                <h3>Image Optimization <span class="audit-count">(${count} images)</span></h3>
            </div>
            <div class="audit-accordion-content" style="max-height: 0;">
                <div class="adv-table-container">
                    <table class="adv-table">
                        <thead>
                            <tr>
                                <th>Image URL</th>
                                <th class="numeric">Size</th>
                                <th class="numeric">Potential Savings</th>
                            </tr>
                        </thead>
                        <tbody>${itemsHtml}</tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}

// --- NEW HELPER: Builds Unused Code Report ---
function createUnusedCodeSection(allAudits) {
    const jsAudit = allAudits['unused-javascript'];
    const cssAudit = allAudits['unused-css-rules'];
    let itemsHtml = '';
    let count = 0;

    if (jsAudit && jsAudit.details && jsAudit.details.items) {
        jsAudit.details.items.forEach(item => {
            count++;
            itemsHtml += `
                <tr class="adv-table-row">
                    <td><div class="adv-table-url">${item.url}</div></td>
                    <td class="numeric">JS</td>
                    <td class="numeric">${(item.wastedBytes / 1024).toFixed(1)} KB</td>
                </tr>
            `;
        });
    }
    if (cssAudit && cssAudit.details && cssAudit.details.items) {
        cssAudit.details.items.forEach(item => {
            count++;
            // --- THIS IS THE FIX for the syntax error ---
            itemsHtml += `
                <tr class="adv-table-row">
                    <td><div class="adv-table-url">${item.url}</div></td>
                    <td class="numeric">CSS</td>
                    <td class="numeric">${(item.wastedBytes / 1024).toFixed(1)} KB</td>
                </tr>
            `;
            // --- END OF FIX ---
        });
    }

    if (count === 0) return '';

    return `
        <div class="audit-section">
            <div class="audit-accordion-header">
                <i class="fas fa-chevron-right"></i>
                <h3>Unused JavaScript & CSS <span class="audit-count">(${count} files)</span></h3>
            </div>
            <div class="audit-accordion-content" style="max-height: 0;">
                <div class="adv-table-container">
                    <table class="adv-table">
                        <thead>
                            <tr>
                                <th>File URL</th>
                                <th class="numeric">Type</th>
                                <th class="numeric">Unused Bytes</th>
                            </tr>
                        </thead>
                        <tbody>${itemsHtml}</tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}

// --- NEW HELPER: Builds Main-Thread Work Report ---
function createMainThreadWorkSection(allAudits) {
    const audit = allAudits['mainthread-work-breakdown'];
    if (!audit || audit.score === 1 || !audit.details.items || audit.details.items.length === 0) return '';

    let itemsHtml = audit.details.items.map(item => `
        <tr class="adv-table-row">
            <td>${item.groupLabel}</td>
            <td class="numeric">${item.duration.toFixed(1)} ms</td>
        </tr>
    `).join('');

    return `
        <div class="audit-section">
            <div class="audit-accordion-header">
                <i class="fas fa-chevron-right"></i>
                <h3>Main-Thread Work Breakdown <span class="audit-count">(${audit.details.items.length} categories)</span></h3>
            </div>
            <div class="audit-accordion-content" style="max-height: 0;">
                <div class="adv-table-container">
                    <table class="adv-table">
                        <thead>
                            <tr>
                                <th>Activity</th>
                                <th class="numeric">Time Spent</th>
                            </tr>
                        </thead>
                        <tbody>${itemsHtml}</tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}
// --- END OF NEW REPORT BUILDERS ---


// --- NEW: "COPIED" TOAST HELPER ---
let toastTimer;
function showCopyToast() {
    let toast = document.getElementById('copy-toast');
    // Create it if it doesn't exist
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'copy-toast';
        toast.className = 'copy-toast';
        document.body.appendChild(toast);
    }

    // Show the toast
    toast.textContent = 'Copied to clipboard!';
    toast.classList.add('show');

    // Clear previous timer
    if (toastTimer) {
        clearTimeout(toastTimer);
    }

    // Hide after 2 seconds
    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, 2000);
}
// --- END TOAST HELPER ---


// --- CORE DASHBOARD SETUP (Runs only on server.html) ---
function setupDashboardLogic() {
    // --- Get All Elements ---
    const protectedRadio = document.getElementById('protectedStore');
    const liveRadio = document.getElementById('liveStore');
    const passwordGroup = document.getElementById('passwordGroup');
    const storePasswordInput = document.getElementById('storePassword');

    // --- BUG FIX: These need to be accessible by showAppModal ---
    // We declare them here so they are in the setupDashboardLogic scope.
    const appModal = document.getElementById('appModal');
    const closeModal = document.getElementById('closeModal');
    const modalBody = document.getElementById('modalBody');

    const scanButton = document.getElementById('scanButton');
    const storeUrlInput = document.getElementById('storeUrl');

    // Assign global variables
    resultsWrapper = document.getElementById('results-wrapper');
    errorEl = document.getElementById('error-placeholder');
    errorMsgEl = errorEl.querySelector('p'); // Assign global

    const performanceSection = document.getElementById('performance-container');
    const appsSection = document.getElementById('apps-container');

    const togglePerformance = document.getElementById('togglePerformance');
    const toggleApps = document.getElementById('toggleApps');

    const appReportLinkContainer = document.getElementById('globalAppReportLink').parentElement;
    const perfReportLinkContainer = document.getElementById('globalPerformanceReportLink').parentElement;

    const loadingEl = document.getElementById('loading-placeholder');

    // Assign global log elements
    logOutputEl = document.getElementById('log-output');
    const spinnerContainerEl = document.getElementById('spinner-container');
    loadingMessageEl = document.getElementById('loading-message');
    terminalSpinner = spinnerContainerEl.querySelector('.spinner');
    unidentifiedAppsSection = document.getElementById('unidentified-apps-section'); // Assign global
    heavyHittersSection = document.getElementById('heavy-hitters-section'); // NEW: Assign global

    // --- (MODIFIED) Global state for streaming ---
    let eventSource; // MODIFIED: Only one event source needed now
    let scanState = {
        runPerfScan: false,
        runAppScan: false,
        perfReport: null,
        appReport: null,
        hasError: false
    };
    let hasFinalized = false; // --- FIX: Add this flag ---

    /**
     * (MODIFIED) Helper function to log messages to the terminal with colors.
     */
    const logMessage = (message, type = 'info') => {
        // Use global logOutputEl
        if (logOutputEl) {
            const logLine = document.createElement('span');
            logLine.className = `log-line log-${type}`;
            logLine.textContent = message;

            logOutputEl.appendChild(logLine);

            // Auto-scroll to the bottom
            logOutputEl.parentElement.scrollTop = logOutputEl.parentElement.scrollHeight;
        }
    };


    // --- (FIX) UPDATED TOGGLE HANDLERS (Visibility & Centering) ---
    const updateReportVisibility = () => {
        const perfChecked = togglePerformance.checked;
        const appsChecked = toggleApps.checked;

        performanceSection.style.display = perfChecked ? 'block' : 'none';
        appsSection.style.display = appsChecked ? 'block' : 'none';

        appReportLinkContainer.style.display = appsChecked ? 'block' : 'none';
        perfReportLinkContainer.style.display = perfChecked ? 'block' : 'none';

        // Use global resultsWrapper
        const layoutGrid = resultsWrapper.querySelector('.results-layout');
        if (layoutGrid) {
            if (perfChecked && appsChecked) {
                layoutGrid.style.gridTemplateColumns = 'minmax(300px, 1fr) 2fr';
            } else if (perfChecked || appsChecked) {
                layoutGrid.style.gridTemplateColumns = 'minmax(300px, 2fr)';
            }

            layoutGrid.style.display = (perfChecked || appsChecked) ? 'grid' : 'none';

            // Use global unidentifiedAppsSection
            if (unidentifiedAppsSection) { // Check before accessing
                unidentifiedAppsSection.style.display = appsChecked ? 'block' : 'none';
            }
            // NEW: Toggle Heavy Hitters section
            if (heavyHittersSection) {
                heavyHittersSection.style.display = appsChecked ? 'block' : 'none';
            }
        }
    };

    if (togglePerformance && toggleApps) {
        togglePerformance.addEventListener('change', updateReportVisibility);
        toggleApps.addEventListener('change', updateReportVisibility);
    }
    // --- END NEW TOGGLE LOGIC ---


    // --- MODAL EVENT LISTENERS ---
    if (closeModal && appModal) {
        closeModal.onclick = () => appModal.style.display = "none";
        window.onclick = (event) => {
            if (event.target == appModal) {
                appModal.style.display = "none";
            }
        };
    }

    // --- Store Type Selector Toggle ---
    const handleStoreTypeChange = () => {
        // This function now also toggles the 'selected' class for CSS
        document.querySelectorAll('.store-type-selector .radio-label').forEach(label => {
            const input = label.querySelector('input[type="radio"]');
            if (input && input.checked) {
                label.classList.add('selected');
            } else {
                label.classList.remove('selected');
            }
        });

        if (protectedRadio.checked) {
            passwordGroup.style.opacity = '1';
            passwordGroup.style.pointerEvents = 'auto';
            storePasswordInput.setAttribute('required', 'true');
        } else {
            passwordGroup.style.opacity = '0.5';
            passwordGroup.style.pointerEvents = 'none';
            storePasswordInput.removeAttribute('required');
            storePasswordInput.value = '';
        }
    };

    protectedRadio.addEventListener('change', handleStoreTypeChange);
    liveRadio.addEventListener('change', handleStoreTypeChange);
    handleStoreTypeChange(); // Run on init


    // --- Scan Button Listener ---
    scanButton.addEventListener('click', () => {
        const storeUrl = storeUrlInput.value;
        const storePassword = protectedRadio.checked ? storePasswordInput.value : '';

        if (!storeUrl) {
            alert('Please enter a store URL.');
            return;
        }

        // Disable button to prevent multiple scans
        scanButton.disabled = true;
        scanButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning...';

        handleScan(storeUrl, storePassword);
    });

    /**
     * (MODIFIED) handleScan function for new /scan-all endpoint
     */
    function handleScan(storeUrl, storePassword) {
        showLoading(); // This resets the terminal
        logMessage('Scan initialized...', 'info');
        hasFinalized = false; // --- FIX: Reset the flag ---

        // Reset scan state
        scanState = {
            runPerfScan: togglePerformance.checked,
            runAppScan: toggleApps.checked,
            perfReport: null, // Will hold the final report object
            appReport: null, // Will hold the final report object
            hasError: false
        };

        if (!scanState.runPerfScan && !scanState.runAppScan) {
            showError("Please select at least one report type to display.");
            // Re-enable scan button
            scanButton.disabled = false;
            scanButton.innerHTML = '<i class="fas fa-search"></i> Scan Store';
            return;
        }

        // Build base URL with query parameters
        const params = new URLSearchParams();
        params.append('storeUrl', storeUrl);
        params.append('runPerfScan', scanState.runPerfScan); // Pass toggle state
        params.append('runAppScan', scanState.runAppScan); // Pass toggle state
        if (storePassword) {
            params.append('storePassword', storePassword);
        }

        const baseUrl = window.location.origin;
        const url = `${baseUrl}/scan-all?${params.toString()}`; // Call the single endpoint

        // --- Start ONE Unified Scan ---
        eventSource = new EventSource(url);

        eventSource.onopen = () => {
            logMessage('[System] Connection established. Starting unified scan...', 'info');
            loadingMessageEl.textContent = 'Scan in progress... This may take a minute.';
        };

        // 'log' event listener
        eventSource.addEventListener('log', (e) => {
            const data = JSON.parse(e.data);
            logMessage(data.message, data.type);
        });

        // 'perfResult' event listener
        eventSource.addEventListener('perfResult', (e) => {
            logMessage('[System] Performance report received.', 'success');
            scanState.perfReport = JSON.parse(e.data); // Store the result
        });

        // 'scanResult' event listener
        eventSource.addEventListener('scanResult', (e) => {
            logMessage('[System] App report received.', 'success');
            scanState.appReport = JSON.parse(e.data); // Store the result
        });

        // --- NEW: 'scanComplete' listener ---
        eventSource.addEventListener('scanComplete', (e) => {
            if (hasFinalized) return;
            logMessage('[System] Server sent completion signal.', 'success');
            if (eventSource) eventSource.close();
            finalizeScan(); // This is the new, correct success path.
        });

        // 'scanError' event listener
        eventSource.addEventListener('scanError', (e) => {
            if (hasFinalized) return; // Don't run if already finalized
            const data = JSON.parse(e.data);
            logMessage(`[System] ERROR: ${data.details}`, 'error');
            scanState.hasError = true;
            if (eventSource) eventSource.close();
            finalizeScan(); // Call finalize to show error message
        });

        // General 'error' listener (handles connection close)
        eventSource.onerror = (err) => {
            if (hasFinalized) return; // Don't run if already finalized

            // This block now *only* handles unexpected connection drops
            // (or if the server fails to send 'scanComplete')
            if (eventSource.readyState !== EventSource.CLOSED) {
                console.error('EventSource error:', err);
                logMessage('[System] A critical connection error occurred.', 'error');
                scanState.hasError = true;
                if (eventSource) eventSource.close();
                finalizeScan();
            }
        };
    }

    // --- (REMOVED) startAppScanStream, startPerfScanStream, checkIfAllScansComplete ---


    /** (MODIFIED) Finalizes the scan, displays results, and hides loading */
    /** (MODIFIED) Finalizes the scan, displays results, and hides loading */
function finalizeScan() {
    if (hasFinalized) return; // --- FIX: Prevent this from running twice ---
    hasFinalized = true;

    // Stop any streams that might still be open
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }

    // Re-enable scan button
    scanButton.disabled = false;
    scanButton.innerHTML = '<i class="fas fa-search"></i> Scan Store';

    if (scanState.hasError) {
        logMessage('One or more scans failed. See log for details.', 'error');
        if (loadingMessageEl) loadingMessageEl.textContent = 'Scan failed. Please check logs.';
        if (terminalSpinner) terminalSpinner.style.display = 'none';
        if (unidentifiedAppsSection) unidentifiedAppsSection.innerHTML = '';
        if (heavyHittersSection) heavyHittersSection.innerHTML = '';
        return;
    }

    // --- All successful ---
    const { appReport, perfReport } = scanState;

    // Save combined results to session storage
    sessionStorage.setItem('lastScanData', JSON.stringify({ appReport, perfReport }));

    // --- (NEW) SAVE TO HISTORY IN LOCALSTORAGE ---
    if (scanState.runPerfScan && perfReport && perfReport.metrics && perfReport.categories) {
        try {
            const historyEntry = {
                date: new Date().toISOString(),
                performanceScore: parseInt(perfReport.metrics.performanceScore, 10),
                accessibilityScore: Math.round(perfReport.categories.accessibility.score * 100),
                bestPracticesScore: Math.round(perfReport.categories['best-practices'].score * 100),
                seoScore: Math.round(perfReport.categories.seo.score * 100),
                lcp: parseMetricValue(perfReport.metrics.lcp),
                tbt: parseMetricValue(perfReport.metrics.tbt),
                cls: parseMetricValue(perfReport.metrics.cls)
            };

            const history = JSON.parse(localStorage.getItem('appAuditorHistory')) || [];
            history.push(historyEntry);
            localStorage.setItem('appAuditorHistory', JSON.stringify(history));

            logMessage('[System] Scan results saved to history.', 'success');
        } catch (e) {
            console.error('Failed to save scan to history:', e);
            logMessage('[System] Failed to save scan results to history.', 'error');
        }
    }
    // --- (END) SAVE TO HISTORY ---

    // Clear previous results
    document.getElementById('performance-card-content').innerHTML = '';
    document.getElementById('apps-grid-content').innerHTML = '';
    if (unidentifiedAppsSection) unidentifiedAppsSection.innerHTML = '';
    if (heavyHittersSection) heavyHittersSection.innerHTML = '';

    // --- Populate Dashboard ---
    if (scanState.runPerfScan && perfReport && perfReport.metrics) {
        displayPerformanceReport(perfReport);
    } else if (scanState.runPerfScan) {
        document.getElementById('performance-card-content').innerHTML =
            '<p class="card">Performance scan did not return valid metrics.</p>';
    }

    if (scanState.runAppScan && appReport) {
        const tbt = (scanState.runPerfScan && perfReport && perfReport.metrics) ? perfReport.metrics.tbt : null;
        displayReport(appReport, tbt);
    }

    // --- Display Unidentified Domains ---
    if (scanState.runAppScan && appReport.unidentifiedDomains && appReport.unidentifiedDomains.length > 0) {
        logMessage('------------------------------------------------', 'info');
        logMessage('[System] Found unidentified domains (potential new fingerprints):', 'warning');
        appReport.unidentifiedDomains.forEach(domain => {
            logMessage(`[Potential] ${domain}`, 'info');
        });
        logMessage('------------------------------------------------', 'info');

        if (unidentifiedAppsSection) {
            const tableHtml = appReport.unidentifiedDomains.map(domain => `
                <tr class="adv-table-row">
                    <td><div class="adv-table-url" title="${domain}">${domain}</div></td>
                    <td class="numeric">
                        <button class="secondary-button" style="padding:5px 10px;font-size:0.9em;" onclick="navigator.clipboard.writeText('${domain}'); showCopyToast();">
                            <i class="fas fa-copy" style="margin-right:5px;"></i> Copy
                        </button>
                    </td>
                </tr>
            `).join('');

            unidentifiedAppsSection.innerHTML = `
                <div class="card unidentified-apps-card animated-card">
                    <h3>Found Unidentified Domains: <strong style="color:var(--warning-color);">${appReport.unidentifiedDomains.length} Potential Fingerprints</strong></h3>
                    <div class="adv-table-container" style="padding:0;max-height:300px;overflow-y:auto;">
                        <table class="adv-table">
                            <thead>
                                <tr>
                                    <th>Unidentified Domain</th>
                                    <th class="numeric" style="width:100px;">Action</th>
                                </tr>
                            </thead>
                            <tbody>${tableHtml}</tbody>
                        </table>
                    </div>
                    <p style="margin-top:15px;font-size:0.9em;color:var(--muted-text-color);">Note: These are unique hostnames that did not match any known app. Use this list to update 'fingerprintDatabase.json'.</p>
                </div>
            `;
        }
    }

    // --- Display Heavy Hitters ---
    if (scanState.runAppScan && appReport.heavyHitters && appReport.heavyHitters.length > 0) {
        if (heavyHittersSection) {
            appReport.heavyHitters.sort((a, b) => b.sizeKb - a.sizeKb);

            const listHtml = appReport.heavyHitters.map(script => {
                const urlPath = script.url.length > 80 ? '...' + script.url.slice(-80) : script.url;
                return `
                    <li title="Click to copy URL" onclick="navigator.clipboard.writeText('${script.url}'); showCopyToast();">
                        <strong>${script.sizeKb.toFixed(2)} KB</strong> - <span>${urlPath}</span>
                    </li>
                `;
            }).join('');

            heavyHittersSection.innerHTML = `
                <div class="card heavy-hitters-card animated-card">
                    <h3>Heavy Hitters: <strong style="color:var(--error-color);">${appReport.heavyHitters.length} Large Unidentified Scripts</strong></h3>
                    <ul class="heavy-hitters-list">
                        ${listHtml}
                    </ul>
                    <p style="margin-top:15px;font-size:0.9em;color:var(--muted-text-color);">Note: These are scripts over 150 KB that are not recognized. They are prime candidates for optimization.</p>
                </div>
            `;
        }
    }

    logMessage('All tasks finished. Rendering dashboard.', 'success');

    if (loadingMessageEl) loadingMessageEl.textContent = 'All tasks finished. Rendering dashboard...';
    if (terminalSpinner) terminalSpinner.style.display = 'none';

    // Wait 1 second, then hide loading and update UI
    setTimeout(() => {
        hideLoading();
        updateReportVisibility();
    }, 1000);
}



    /** * (MODIFIED) This function now renders the SIMPLE LIST for the dashboard.
     */
    function displayPerformanceReport(report) {
        const container = document.getElementById('performance-card-content');

        if (!report || !report.metrics) { // Simplified check
            console.warn('Performance report metrics are missing.');
            container.innerHTML = '<p>Performance report was not requested or failed.</p>';
            return;
        }

        const metrics = report.metrics;
        const score = parseInt(metrics.performanceScore, 10); // Ensure score is a number
        let scoreClass = getScoreRating(score); 

        // This is the SIMPLE LIST you wanted
        container.innerHTML = `
            <div class="performance-score">
                <strong>Overall Score:</strong> <span class="${scoreClass}">${score}</span> / 100
            </div>
            <ul class="metrics-list">
                <li><strong>Largest Contentful Paint (LCP):</strong> ${metrics.lcp}</li>
                <li><strong>Cumulative Layout Shift (CLS):</strong> ${metrics.cls}</li>
                <li><strong>Total Blocking Time (TBT):</strong> ${metrics.tbt}</li>
                <li><strong>First Contentful Paint (FCP):</strong> ${metrics.fcp}</li>
                <li><strong>Speed Index:</strong> ${metrics.speedIndex}</li>
            </ul>
        `;
    }













    // --- (MODIFIED) Function to display the app report (Dashboard Grid) ---
 function displayReport(report, currentTBT) {
    const container = document.getElementById('apps-grid-content');
    container.innerHTML = '';

    if (!report || !report.appBreakdown || report.appBreakdown.length === 0) {
        container.innerHTML = '<p class="card">No known third-party apps were detected.</p>';
        return;
    }

    report.appBreakdown.forEach(app => {
        const card = document.createElement('div');
        card.className = 'card app-card animated-card';

        let impactClass = 'impact-low';
        if (app.impact === 'High') impactClass = 'impact-critical';
        else if (app.impact === 'Medium') impactClass = 'impact-medium';

        card.innerHTML = `
            <div class="impact-badge ${impactClass}">${app.impact} Impact</div>
            <div class="app-card-content-wrapper">
                <div class="app-card-header">
                    ${app.icon ? `<img src="${app.icon}" class="app-icon" alt="${app.name}">` : '<span class="app-icon-placeholder"></span>'}
                    <h4>${app.name}</h4>
                </div>
                <p><strong>Total Assets:</strong> ${app.assetCount}</p>
                <p><strong>Size Impact:</strong> <strong>${app.totalSizeKb} KB</strong></p>
                <p><strong>Load Delay:</strong> <strong>${app.totalDurationMs} ms</strong></p>
            </div>
            ${app.recommendation ? `
                <div class="recommendation-box" style="margin-top: 10px;">
                    <strong>Optimization Tip:</strong>
                    <p>${app.recommendation}</p>
                </div>
            ` : ''}
        `;
        container.appendChild(card);
    });
}









    // --- MODAL DISPLAY FUNCTION (Restructured for better visual flow) ---
    function showAppModal(appData, tbtContr, currentTbt) {
        const modal = document.getElementById('appModal');
        const body = document.getElementById('modalBody');

        if (!modal || !body) {
            console.error('Modal HTML elements (appModal, modalBody) not found.');
            return;
        }

        const predictedTBTms = Math.max(0, currentTbt - tbtContr).toFixed(0);
        const improvement = tbtContr.toFixed(0);

        // 1. Prediction Analysis
        let analysisMessage = '';

        if (currentTbt > 0) {
            if (currentTbt > 250) {
                analysisMessage = '⚠️ **HIGH IMPACT:** Optimization is strongly recommended.';
            } else if (tbtContr > 50) {
                analysisMessage = '🟡 **MODERATE IMPACT:** Consider optimizing the load sequence.';
            } else {
                analysisMessage = '🟢 **LOW IMPACT:** Minimal contribution to page responsiveness.';
            }
        } else {
            analysisMessage = 'Run a Performance Scan to see TBT impact analysis.';
        }

        const summarySection = `
            <div class="modal-summary-section">
                <div>
                    <h4 style="font-size: 1.2em; font-weight: 600;">Performance Context</h4>
                    <p style="margin-top: 5px;">Total Blocking Time (TBT): <strong class="${getScoreRating(currentTBTms)}">${currentTBTms > 0 ? currentTBTms.toFixed(0) + ' ms' : 'N/A'}</strong></p>
                    <p style="color: var(--muted-text-color); margin-top: 5px;">${analysisMessage}</p>
                </div>

                ${currentTBTms > 0 ? `
                <div class="prediction-box ${getScoreRating(predictedTBTms)}">
                    <span class="prediction-value">${predictedTBTms} ms</span>
                    <span class="prediction-label">Predicted TBT if Removed</span>
                    <span style="font-size: 0.8em; margin-top: 5px;">(Improvement of ${improvement} ms)</span>
                </div>` : ''}
            </div>
        `;

        // 2. Asset Table Generation
        let tableHtml = `
            <h3 style="margin-top: 25px; margin-bottom: 15px; font-weight: 600;">Detailed Asset List (${appData.assets.length} Resources)</h3>
            <div class="detailed-asset-list-container">
            <table class="asset-detail-table">
                <thead>
                    <tr>
                        <th style="width: 55%;">Resource URL</th>
                        <th style="width: 15%;">Type</th>
                        <th style="width: 15%;">Size (KB)</th>
                        <th style="width: 15%;">Load Time (ms)</th>
                    </tr>
                </thead>
                <tbody>
        `;

        appData.assets.forEach(asset => {
            const loadTime = asset.durationMs ? Math.round(asset.durationMs) : 'N/A';
            const rowClass = (asset.sizeKb > 50 || asset.durationMs > 500) ? 'asset-flagged' : '';

            tableHtml += `
                <tr class="${rowClass}">
                    <td title="${asset.url}"><span class="asset-url">${asset.url.substring(asset.url.lastIndexOf('/') + 1)}</span></td>
                    <td>${asset.type}</td>
                    <td>${asset.sizeKb.toFixed(2)}</td>
                    <td>${loadTime}</td>
                </tr>
            `;
        });
        tableHtml += `
                </tbody>
            </table>
            </div>
        `;

        // 3. Render Modal Content
        body.innerHTML = `
            <h2 style="color: var(--primary-color); border-bottom: 1px solid var(--border-color); padding-bottom: 10px; margin-bottom: 15px;">${appData.name} Analysis</h2>
            ${summarySection}
            ${tableHtml}
        `;

        // 4. Show Modal
        modal.style.display = "flex";
    }


    // --- UI State Management (MODIFIED) ---
    function showLoading() {
        // (NEW) Reset terminal window
        if (logOutputEl) {
            logOutputEl.innerHTML = ''; // Use innerHTML to clear all span elements
        }
        if (loadingMessageEl) {
            loadingMessageEl.textContent = 'Connecting to server...';
        }
        if (terminalSpinner) {
            terminalSpinner.style.display = 'block';
        }
        if (spinnerContainerEl) {
            spinnerContainerEl.style.display = 'flex';
        }

        // Clear old results
        document.getElementById('performance-card-content').innerHTML = '';
        document.getElementById('apps-grid-content').innerHTML = '';
        if (unidentifiedAppsSection) unidentifiedAppsSection.innerHTML = ''; // Safely clear the new section on new scan
        if (heavyHittersSection) heavyHittersSection.innerHTML = ''; // NEW: Clear heavy hitters on new scan

        // Hide other views
        if (resultsWrapper) resultsWrapper.style.display = 'none';
        if (errorEl) errorEl.style.display = 'none';

        // Show loading terminal
        loadingEl.style.display = 'flex'; // 'flex' to align terminal correctly
    }

    function hideLoading() {
        loadingEl.style.display = 'none';
        resultsWrapper.style.display = 'block';
    }

    function showError(message) {
        // This function is now ONLY for pre-scan validation errors
        loadingEl.style.display = 'none';
        resultsWrapper.style.display = 'none';
        // Use global errorMsgEl
        if (typeof errorMsgEl !== 'undefined') {
            errorMsgEl.textContent = `Scan failed: ${message}`;
        }
        errorEl.style.display = 'flex';
    }

    // --- FIX: Return the function so it can be called from the DOMContentLoaded listener ---
    return {
        updateReportVisibility
    };
}


/**
 * Draws the network waterfall chart using Google Charts.
 * @param {Array} networkRequests - The array of items from the Lighthouse audit.
 * @param {HTMLElement} container - The element to draw the chart in.
 */
function drawWaterfallChart(networkRequests, container) {
    console.log("--- RUNNING 'drawWaterfallChart' (Standard Timing) ---");

    if (!container) {
        console.error("Waterfall chart container not found!");
        return;
    }

    // Check if Google Charts is loaded
    if (typeof google === 'undefined' || !google.visualization || !google.visualization.Timeline) {
        console.error("Google Charts Timeline package is not loaded.");
        container.innerHTML = "<p>Error: Google Charts library failed to load.</p>";
        return;
    }

    const chart = new google.visualization.Timeline(container);
    const dataTable = new google.visualization.DataTable();

    // Define the columns for the DataTable
    dataTable.addColumn({ type: 'string', id: 'ResourceName' });
    dataTable.addColumn({ type: 'string', id: 'BarLabel' });
    dataTable.addColumn({ type: 'string', role: 'tooltip' }); // Custom tooltip
    dataTable.addColumn({ type: 'string', role: 'style' });   // Column for color
    dataTable.addColumn({ type: 'number', id: 'Start' });
    dataTable.addColumn({ type: 'number', id: 'End' });

    // Map resource types to colors
    const resourceColors = {
        'Script': '#8AB4F8',     // Blue
        'Stylesheet': '#C58AF9', // Purple
        'Image': '#F28B82',      // Red
        'Font': '#FDD663',       // Yellow
        'Document': '#80C995',   // Green
        'Fetch': '#FD9A4F',      // Orange (for API calls)
        'XHR': '#FD9A4F',        // Orange
        'Other': '#AECBFA'       // Light Blue
    };

    const rows = networkRequests
        .map(item => {
            if (typeof item.startTime === 'undefined' || typeof item.endTime === 'undefined') {
                return null;
            }

            const url = item.url || 'Unknown URL';
            const shortUrl = url.substring(url.lastIndexOf('/') + 1) || url;
            const resourceType = item.resourceType || 'Other';
            const color = resourceColors[resourceType] || resourceColors['Other'];

            const startTime = parseFloat(item.startTime);
            const endTime = parseFloat(item.endTime);

            if (isNaN(startTime) || isNaN(endTime) || endTime <= startTime) {
                return null;
            }

            const transferSize = parseFloat(item.transferSize) || 0;
            const duration = (endTime - startTime).toFixed(2);

            const tooltip = 
                `URL: ${url}\n` +
                `Type: ${resourceType}\n` +
                `Size: ${(transferSize / 1024).toFixed(1)} KB\n` +
                `Duration: ${duration} ms`;

            return [
                shortUrl,   // Resource name
                shortUrl,   // Bar label
                tooltip,    // Tooltip text
                color,      // Bar color
                startTime,  // Start
                endTime     // End
            ];
        })
        .filter(Boolean); // Removes all the null rows

    // Sort rows by start time
    rows.sort((a, b) => a[4] - b[4]);

    console.log(`drawWaterfallChart: Processed ${rows.length} valid network requests.`);

    if (rows.length === 0) {
        container.innerHTML = `
            <p style="text-align: center; padding: 20px;">
                No valid network requests were found to display.
            </p>`;
        return;
    }

    dataTable.addRows(rows);

    // Set chart options
    const options = {
        height: rows.length * 35 + 80, // Dynamic height
        timeline: {
            showRowLabels: false,
            barLabelStyle: { fontName: 'Inter', fontSize: 12 }
        },
        tooltip: { isHtml: false },
        avoidOverlappingGridLines: true,
        hAxis: {
            title: 'Time (ms)',
            minValue: 0,
            textStyle: { fontName: 'Inter', fontSize: 12 }
        },
        vAxis: {
            textStyle: { fontName: 'Inter', fontSize: 12 }
        }
    };

    // Draw the chart
    chart.draw(dataTable, options);
}

/**
 * Renders all app pie charts after the main report is built.
 * @param {Array} chartData - An array of objects { id, data }
 */
function renderAppCharts(chartData) {
    if (typeof Chart === 'undefined') {
        console.error('Chart.js is not loaded. Skipping pie chart rendering.');
        return;
    }

    Chart.defaults.color = '#333';
    Chart.defaults.plugins.legend.labels.color = '#333';

    chartData.forEach(chartItem => {
        const ctx = document.getElementById(chartItem.id);
        const total = chartItem.data.reduce((a, b) => a + b, 0);

        if (!ctx || total === 0) {
            if (ctx) {
                ctx.parentElement.innerHTML = '<p style="text-align:center; font-size:0.9em; color:#777;">No asset data to display.</p>';
            }
            return;
        }

        new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['JavaScript (KB)', 'CSS (KB)', 'Other (KB)'],
                datasets: [{
                    data: chartItem.data,
                    backgroundColor: [
                        'rgb(244,180,0)',
                        'rgb(118,93,221)',
                        'rgb(204,204,204)'
                    ],
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'right',
                        labels: { boxWidth: 12 }
                    },
                    title: {
                        display: false,
                        text: 'Asset Size Breakdown (KB)'
                    }
                }
            }
        });
    });
}


// --- NEW HELPER: Shopify-Specific Checklist ---
function createShopifyChecklist(allAudits, metrics) {
    // Helper function to determine Pass (true) or Fail (false) status
    const getStatus = (audit, threshold, metricValue) => {
        // 1. Check Audits by Score/Pass
        if (audit && typeof audit.score === 'number') {
            const passed = audit.score === 1;
            if (passed) return { passed: true };
            return { passed: false, reason: audit.title };
        }

        // 2. Check Metrics (e.g., Server Response Time)
        if (metricValue !== undefined) {
            const numericValue = parseMetricValue(metricValue);
            if (isNaN(numericValue)) return { passed: false, reason: 'Metric not run.' };

            const passed = numericValue <= threshold;
            if (passed) return { passed: true };
            return { passed: false, reason: `Value: ${metricValue}` };
        }

        return { passed: false, reason: 'N/A' };
    };

    // 1. Uses Shopify's CDN for images (Proxy check via modern-image-formats)
    const modernImageFormat = getStatus(allAudits['modern-image-formats']);

    // 2. Server Response Time is fast (< 600 ms is Lighthouse standard)
    const srt = getStatus(allAudits['server-response-time'], 600, allAudits['server-response-time']?.numericValue);

    // 3. First Contentful Paint (FCP) is healthy (< 1.8 s)
    const fcp = getStatus(allAudits['first-contentful-paint'], 1800, allAudits['first-contentful-paint']?.numericValue);

    // 4. No large layout shifts
    const cls = getStatus(allAudits['cumulative-layout-shift'], 0.1, allAudits['cumulative-layout-shift']?.numericValue);

    const checklistItems = [
        {
            label: "Serves Images in Modern Formats (e.g., WebP)",
            status: modernImageFormat
        },
        {
            label: "Server Response Time (TTFB) is fast (< 600ms)",
            status: srt
        },
        {
            label: "First Contentful Paint (FCP) is fast (< 1.8s)",
            status: fcp
        },
        {
            label: "No Large Cumulative Layout Shifts (< 0.1)",
            status: cls
        }
    ];

    let html = checklistItems.map(item => {
        const iconClass = item.status.passed ? 'fa-check-circle check-pass' : 'fa-times-circle check-fail';
        const statusText = item.status.passed ? 'PASS' : `FAIL (${item.status.reason})`;
        const itemClass = item.status.passed ? 'checklist-item-pass' : 'checklist-item-fail';

        return `
            <div class="checklist-item ${itemClass}">
                <i class="fas ${iconClass}"></i>
                <span>${item.label}</span>
                <span class="checklist-status">${statusText}</span>
            </div>
        `;
    }).join('');

    return `
        <h3 class="section-title" style="margin-top: 25px;">Shopify Optimization Checklist</h3>
        <div class="card" style="padding: 20px;">
            <div class="shopify-checklist-container">
                ${html}
            </div>
            <p class="muted-text-color" style="font-size:0.9em; margin-top:15px;">
                *Scores based on standard Lighthouse audits.
            </p>
        </div>
    `;
}

// ---- ADD THIS CODE TO YOUR client.js FILE ----

const ghostScanBtn = document.getElementById('scan-ghost-code-btn');
const ghostLog = document.getElementById('ghost-log');
const ghostLoading = document.getElementById('ghost-loading');

if (ghostScanBtn) {
    ghostScanBtn.addEventListener('click', () => {
        ghostLog.textContent = 'Starting Ghost Code scan...\n';
        ghostLog.style.display = 'block';
        ghostLoading.style.display = 'block';
        ghostScanBtn.disabled = true;
        ghostScanBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning...';

        // Use EventSource to listen for streamed logs
        const evtSource = new EventSource('/scan-ghost-code');

        evtSource.addEventListener('log', (event) => {
            const data = JSON.parse(event.data);
            if (data.message) {
                // Check if the message is the final JSON report
                if (data.message.startsWith('--- DETAILED REPORT ---')) {
                    ghostLog.textContent += '\n'; // Add a space before the report
                }
                ghostLog.textContent += `${data.message}\n`;
            }
            // Auto-scroll
            ghostLog.scrollTop = ghostLog.scrollHeight; 
        });

        evtSource.addEventListener('scanComplete', (event) => {
            const data = JSON.parse(event.data);
            ghostLog.textContent += `\n--- SCAN COMPLETE ---\n${data.message}\n`;
            evtSource.close();
            ghostScanBtn.disabled = false;
            ghostLoading.style.display = 'none';
            ghostScanBtn.innerHTML = '<i class="fas fa-search"></i> Start Ghost Code Scan';
        });

        evtSource.addEventListener('scanError', (event) => {
            const data = JSON.parse(event.data);
            ghostLog.textContent += `\n--- ERROR ---\n${data.details}\n`;
            evtSource.close();
            ghostScanBtn.disabled = false;
            ghostLoading.style.display = 'none';
            ghostScanBtn.innerHTML = '<i class="fas fa-search"></i> Start Ghost Code Scan';
        });
    });
}
// ---- END OF NEW CODE FOR client.js ----

document.addEventListener('DOMContentLoaded', () => {
    // Check which page we are on
    const url = document.URL;

    if (url.includes('server.html') || url.endsWith('/')) {
        // --- Main Dashboard Page (server.html) ---
        const dashboard = setupDashboardLogic(); // This line runs your setup
        if (dashboard && dashboard.updateReportVisibility) {
            dashboard.updateReportVisibility();
        }
    } else if (url.includes('global-app-report.html')) {
        // --- Global App Report Page ---
        renderGlobalAppReport();
    } else if (url.includes('global-performance-report.html')) {
        // --- Global Performance Report Page ---
        renderGlobalPerfReport();
    } else if (url.includes('history.html')) {
        // --- History Page ---
        renderHistoryPage();
    }
});
