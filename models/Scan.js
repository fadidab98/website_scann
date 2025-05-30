const puppeteer = require('puppeteer');
const mysql = require('mysql2/promise');
const PQueue = require('p-queue').default;

const dbConfig = {
  host: 'pma-db.serp24.online',
  user: 'webscan',
  password: 'webscan',
  database: 'webscan',
  port: 3306
};
const queue = new PQueue({ concurrency: 1 });
let db;
const EXPIRATION_SECONDS = 172800; // 48 hours

// Configuration for flexibility
const scanConfig = {
  performanceAudits: [
    'largest-contentful-paint',
    'first-contentful-paint',
    'speed-index',
    'total-blocking-time',
    'cumulative-layout-shift',
    'interactive'
  ],
  accessibilityAudits: [
    'image-alt',
    'label',
    'link-name',
    'color-contrast',
    'aria-allowed-attr',
    'aria-required-attr',
    'bypass',
    'heading-order',
    'tabindex'
  ],
  errorScoreThreshold: 0.5, // Errors for scores < 0.5
  alertScoreThreshold: 0.9, // Alerts for scores < 0.9 or manual checks
  maxErrorsPerCategory: 3,
  maxAlertsPerCategory: 5,
  includeCustomChecks: true,
};

class Scan {
  static async initialize() {
    const maxRetries = 10;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        db = await mysql.createConnection(dbConfig);
        await db.execute(`
          CREATE TABLE IF NOT EXISTS webscan (
            id INT AUTO_INCREMENT PRIMARY KEY,
            url VARCHAR(255) UNIQUE NOT NULL,
            status VARCHAR(50) NOT NULL,
            result JSON,
            timestamp BIGINT NOT NULL,
            expires_at BIGINT NOT NULL
          )`);
        console.log('Database initialized');
        this.startKeepAlive();
        return;
      } catch (error) {
        console.error(`DB init attempt ${attempt} failed:`, error.message);
        if (attempt === maxRetries) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  static startKeepAlive() {
    setInterval(async () => {
      try {
        if (!db) await this.connectToDatabase();
        await db.ping();
        console.log('MySQL connection kept alive');
      } catch (error) {
        console.error('Keep-alive ping failed:', error.message);
        db = null;
      }
    }, 300000);
  }

  static async connectToDatabase() {
    db = await mysql.createConnection(dbConfig);
  }

  static async getCachedResult(url) {
    if (!db) await this.connectToDatabase();
    try {
      const [rows] = await db.execute(
        'SELECT result, expires_at FROM webscan WHERE url = ? AND status = "completed"',
        [url]
      );
      if (rows.length > 0 && Date.now() < rows[0].expires_at) {
        return JSON.parse(rows[0].result); // Parse JSON string to object
      }
    } catch (error) {
      console.error(`getCachedResult failed for ${url}:`, error.message);
      db = null;
    }
    return null;
  }

  static async saveResult(url, status, result) {
    if (!db) await this.connectToDatabase();
    const timestamp = Date.now();
    const expires_at = timestamp + EXPIRATION_SECONDS * 1000;
    try {
      await db.execute(
        'INSERT INTO webscan (url, status, result, timestamp, expires_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = ?, result = ?, timestamp = ?, expires_at = ?',
        [url, status, JSON.stringify(result), timestamp, expires_at, status, JSON.stringify(result), timestamp, expires_at]
      );
    } catch (error) {
      console.error(`saveResult failed for ${url}:`, error.message);
      db = null;
      throw error;
    }
  }

  static async scanUrl(url, customAudits = {}) {
    const cachedResult = await this.getCachedResult(url);
    if (cachedResult) return cachedResult;

    // Merge custom audits with default config
    const config = {
      ...scanConfig,
      performanceAudits: customAudits.performance || scanConfig.performanceAudits,
      accessibilityAudits: customAudits.accessibility || scanConfig.accessibilityAudits,
      errorScoreThreshold: customAudits.errorScoreThreshold || scanConfig.errorScoreThreshold,
      alertScoreThreshold: customAudits.alertScoreThreshold || scanConfig.alertScoreThreshold,
      maxErrorsPerCategory: customAudits.maxErrorsPerCategory || scanConfig.maxErrorsPerCategory,
      maxAlertsPerCategory: customAudits.maxAlertsPerCategory || scanConfig.maxAlertsPerCategory,
    };

    const report = await queue.add(() => this.performScan(url, config));
    const performanceIssues = this.processLighthouseReport(report, 'performance', config);
    const accessibilityIssues = this.processLighthouseReport(report, 'accessibility', config);
    const performanceMetrics = this.extractPerformanceMetrics(report);
    const accessibilityMetrics = this.extractAccessibilityMetrics(report);

    const scanResult = {
      status: 'completed',
      url: report.finalUrl || url,
      results: {
        performance: {
          errors: performanceIssues.filter(item => item.type === 'error'),
          alerts: performanceIssues.filter(item => item.type === 'alert'),
          totalErrors: performanceIssues.filter(item => item.type === 'error').length,
          totalAlerts: performanceIssues.filter(item => item.type === 'alert').length,
          metrics: performanceMetrics,
        },
        accessibility: {
          errors: accessibilityIssues.filter(item => item.type === 'error'),
          alerts: accessibilityIssues.filter(item => item.type === 'alert'),
          totalErrors: accessibilityIssues.filter(item => item.type === 'error').length,
          totalAlerts: accessibilityIssues.filter(item => item.type === 'alert').length,
          metrics: accessibilityMetrics,
        },
      },
      totalErrors: performanceIssues.filter(item => item.type === 'error').length + accessibilityIssues.filter(item => item.type === 'error').length,
      totalAlerts: performanceIssues.filter(item => item.type === 'alert').length + accessibilityIssues.filter(item => item.type === 'alert').length,
      timestamp: Date.now(),
    };

    await this.saveResult(url, 'completed', scanResult);
    return scanResult;
  }

  static async performScan(url, config) {
    let browser, page;
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        console.log(`Starting scan for ${url}, attempt ${attempt + 1}`);
        browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
          ],
          timeout: 180000,
        });
        page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
        const status = response.status();
        if (!(response.ok() || status === 304)) {
          throw new Error(`Navigation failed with status ${status}`);
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

        const htmlContent = await page.content();

        const { default: lighthouse } = await import('lighthouse');
        const runnerResult = await lighthouse(await page.url(), {
          port: new URL(browser.wsEndpoint()).port,
          output: 'json',
          onlyCategories: ['performance', 'accessibility'],
          audits: [...new Set([...config.performanceAudits, ...config.accessibilityAudits])],
          settings: {
            maxWaitForLoad: 90000,
            throttling: {
              rttMs: 40,
              throughputKbps: 10240,
              cpuSlowdownMultiplier: 1,
            },
            emulatedFormFactor: 'desktop',
            screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1 },
          },
        });

        runnerResult.lhr.customAccessibilityIssues = config.includeCustomChecks
          ? await this.checkHtmlAccessibility(page, htmlContent, config)
          : [];
        console.log(`Lighthouse scan completed for ${url}`);
        return runnerResult.lhr;
      } catch (error) {
        console.error(`Scan failed for ${url}, attempt ${attempt + 1}: ${error.message}`);
        if (attempt === maxRetries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 5000));
      } finally {
        if (page) {
          try {
            await page.close();
          } catch (err) {
            console.error(`Page close error: ${err.message}`);
          }
        }
        if (browser) {
          try {
            await browser.close();
          } catch (err) {
            console.error(`Browser close error: ${err.message}`);
          }
        }
      }
    }
  }

  static async checkHtmlAccessibility(page, htmlContent, config) {
    const issues = [];
    try {
      // Check for images without alt attributes
      const images = await page.$$eval('img', imgs =>
        imgs.map(img => ({
          src: img.src,
          alt: img.getAttribute('alt'),
          outerHTML: img.outerHTML.length > 200 ? img.outerHTML.substring(0, 200) + '...' : img.outerHTML,
        }))
      );
      images.forEach(img => {
        if (!img.alt && img.alt !== '') {
          issues.push({
            type: 'error',
            title: 'Missing Image Alt Text',
            description: `Image is missing an alt attribute.`,
            suggestion: 'Add a descriptive alt attribute to the image.',
            element: img.outerHTML,
          });
        }
      });

      // Check for empty links
      const links = await page.$$eval('a', anchors =>
        anchors.map(a => ({
          href: a.href,
          text: a.textContent.trim(),
          outerHTML: a.outerHTML.length > 200 ? a.outerHTML.substring(0, 200) + '...' : a.outerHTML,
        }))
      );
      links.forEach(link => {
        if (!link.text && !link.href.includes('#')) {
          issues.push({
            type: 'alert',
            title: 'Empty Link Text',
            description: `Link has no visible text.`,
            suggestion: 'Provide descriptive text or an aria-label for the link.',
            element: link.outerHTML,
          });
        }
      });
    } catch (error) {
      console.error('Custom HTML accessibility check failed:', error.message);
    }
    // Limit based on config
    const errors = issues.filter(i => i.type === 'error').slice(0, config.maxErrorsPerCategory);
    const alerts = issues.filter(i => i.type === 'alert').slice(0, config.maxAlertsPerCategory);
    console.log(`Custom accessibility issues: ${errors.length} errors, ${alerts.length} alerts`);
    return [...errors, ...alerts];
  }

  static processLighthouseReport(report, category, config) {
    const issues = [];
    const criticalAudits = category === 'performance' ? config.performanceAudits : config.accessibilityAudits;
    const descriptions = {
      'first-contentful-paint': 'First Contentful Paint measures initial paint time.',
      'largest-contentful-paint': 'Largest Contentful Paint measures largest element render time.',
      'speed-index': 'Speed Index shows how quickly content is populated.',
      'total-blocking-time': 'Total Blocking Time sums up main thread blocking.',
      'cumulative-layout-shift': 'Cumulative Layout Shift measures visual stability.',
      'interactive': 'Time to Interactive measures when the page is fully interactive.',
      'image-alt': 'Images must have alternate text for screen readers.',
      'label': 'Form elements must have associated labels.',
      'link-name': 'Links must have discernible text.',
      'color-contrast': 'Text must have sufficient color contrast for readability.',
      'aria-allowed-attr': 'ARIA attributes must conform to valid usage.',
      'aria-required-attr': 'Required ARIA attributes must be provided.',
      'bypass': 'Users should be able to bypass repeated content.',
      'heading-order': 'Headings should follow a logical order.',
      'tabindex': 'Tabindex should be used correctly.',
    };

    const audits = report.audits || {};
    for (const [auditId, audit] of Object.entries(audits)) {
      if (!criticalAudits.includes(auditId)) continue;
      console.log(`Processing ${category} audit: ${auditId}, score: ${audit.score}, mode: ${audit.scoreDisplayMode}, details: ${JSON.stringify(audit.details?.items || [])}`);
      const elementDetails = audit.details?.items?.map(item => {
        const snippet = item.node?.snippet || item.selector || 'N/A';
        return snippet.length > 200 ? snippet.substring(0, 200) + '...' : snippet;
      })?.join('; ') || 'N/A';
      if (audit.score !== null && audit.score < config.errorScoreThreshold && audit.scoreDisplayMode !== 'manual') {
        issues.push({
          type: 'error',
          title: auditId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          description: descriptions[auditId] || audit.description || 'Issue detected.',
          suggestion: audit.details?.items?.length
            ? `Fix ${audit.details.items.length} instances`
            : 'Optimize based on audit recommendations.',
          score: audit.score,
          displayValue: audit.displayValue || 'N/A',
          element: elementDetails,
        });
        console.log(`Added error for ${auditId}`);
      } else if (
        (audit.scoreDisplayMode === 'manual' && category === 'accessibility') ||
        (audit.score !== null && audit.score < config.alertScoreThreshold && category === 'accessibility')
      ) {
        issues.push({
          type: 'alert',
          title: auditId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          description: descriptions[auditId] || audit.description || 'Issue requires review.',
          suggestion: audit.scoreDisplayMode === 'manual' ? 'Review manually for compliance.' : 'Check for potential improvements.',
          score: audit.score || null,
          element: elementDetails,
        });
        console.log(`Added alert for ${auditId}`);
      }
    }

    if (category === 'accessibility' && report.customAccessibilityIssues) {
      issues.push(...report.customAccessibilityIssues);
      console.log(`Added ${report.customAccessibilityIssues.length} custom accessibility issues`);
    }

    console.log(`Total issues for ${category}: ${issues.length} (errors: ${issues.filter(x => x.type === 'error').length}, alerts: ${issues.filter(x => x.type === 'alert').length})`);

    // Sort by type (errors first) and limit
    return issues
      .sort((a, b) => (a.type === 'error' && b.type !== 'error' ? -1 : 1))
      .filter((item, i) => {
        const errors = issues.filter(x => x.type === 'error').length;
        const alerts = issues.filter(x => x.type === 'alert').length;
        return (
          (item.type === 'error' && i < config.maxErrorsPerCategory && errors > 0) ||
          (item.type === 'alert' && i < config.maxErrorsPerCategory + config.maxAlertsPerCategory && alerts > 0)
        );
      })
      .slice(0, config.maxErrorsPerCategory + config.maxAlertsPerCategory);
  }

  static extractPerformanceMetrics(report) {
    const audits = report.audits || {};
    const safeValue = (value) => (typeof value === 'number' && !isNaN(value) ? value / 1000 : 0);
    const safeDisplay = (value, defaultUnit = 's') => {
      if (typeof value !== 'number' || isNaN(value)) return `0 ${defaultUnit}`;
      return defaultUnit === 's' ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
    };

    const performanceScore = Math.round(report.categories?.performance?.score * 100 || 0);
    if (performanceScore === 0) {
      console.warn('Performance score is 0, report details:', JSON.stringify(report.categories, null, 2));
    }

    return {
      performanceScore,
      metrics: {
        firstContentfulPaint: {
          value: safeValue(audits['first-contentful-paint']?.numericValue),
          displayValue: audits['first-contentful-paint']?.displayValue || safeDisplay(audits['first-contentful-paint']?.numericValue, 's'),
        },
        largestContentfulPaint: {
          value: safeValue(audits['largest-contentful-paint']?.numericValue),
          displayValue: audits['largest-contentful-paint']?.displayValue || safeDisplay(audits['largest-contentful-paint']?.numericValue, 's'),
        },
        speedIndex: {
          value: safeValue(audits['speed-index']?.numericValue),
          displayValue: audits['speed-index']?.displayValue || safeDisplay(audits['speed-index']?.numericValue, 's'),
        },
        totalBlockingTime: {
          value: audits['total-blocking-time']?.numericValue || 0,
          displayValue: audits['total-blocking-time']?.displayValue || safeDisplay(audits['total-blocking-time']?.numericValue, 'ms'),
        },
        cumulativeLayoutShift: {
          value: audits['cumulative-layout-shift']?.numericValue || 0,
          displayValue: audits['cumulative-layout-shift']?.displayValue || safeDisplay(audits['cumulative-layout-shift']?.numericValue, ''),
        },
        interactive: {
          value: safeValue(audits['interactive']?.numericValue),
          displayValue: audits['interactive']?.displayValue || safeDisplay(audits['interactive']?.numericValue, 's'),
        },
      },
    };
  }

  static extractAccessibilityMetrics(report) {
    const audits = report.audits || {};
    const accessibilityScore = Math.round(report.categories?.accessibility?.score * 100 || 0);
    return {
      accessibilityScore,
      metrics: {
        imageAltIssues: {
          count: (audits['image-alt']?.details?.items?.length || 0) + (report.customAccessibilityIssues?.filter(issue => issue.title === 'Missing Image Alt Text').length || 0),
          description: 'Number of images missing alt text.',
        },
        labelIssues: {
          count: audits['label']?.details?.items?.length || 0,
          description: 'Number of form elements missing labels.',
        },
        linkNameIssues: {
          count: audits['link-name']?.details?.items?.length || 0,
          description: 'Number of links without discernible text.',
        },
        contrastIssues: {
          count: audits['color-contrast']?.details?.items?.length || 0,
          description: 'Number of elements with insufficient color contrast.',
        },
        ariaIssues: {
          count: (audits['aria-allowed-attr']?.details?.items?.length || 0) + (audits['aria-required-attr']?.details?.items?.length || 0),
          description: 'Number of ARIA attribute issues.',
        },
        bypassIssues: {
          count: audits['bypass']?.details?.items?.length || 0,
          description: 'Number of bypass navigation issues.',
        },
      },
    };
  }
}

module.exports = Scan;