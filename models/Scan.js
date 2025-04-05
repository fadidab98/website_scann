const puppeteer = require('puppeteer');
const mysql = require('mysql2/promise');
const PQueue = require('p-queue').default;

const dbConfig = {
  host: 'pma-db.serp24.online',
  user: 'webscan',
  password: 'webscan',
  database: 'webscan',
  port:3306
};
const queue = new PQueue({ concurrency: 2 }); // Allows 2 scans at once
let db;
const EXPIRATION_SECONDS = 120; // 2 minutes for testing, adjust later

class Scan {
  static async initialize() {
    const maxRetries = 10;
    const retryDelay = 2000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        db = await mysql.createConnection(dbConfig);
        console.log('Connected to MySQL database in Scan model');
        await db.execute(`CREATE TABLE IF NOT EXISTS webscan (
          id INT AUTO_INCREMENT PRIMARY KEY,
          url VARCHAR(255) UNIQUE,
          status VARCHAR(50),
          result JSON,
          timestamp BIGINT,
          expires_at BIGINT
        )`);
        return;
      } catch (error) {
        console.error(`Connection attempt ${attempt} failed:`, error.message);
        if (attempt === maxRetries) throw new Error('Failed to connect to scans_db');
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  static async getCachedResult(url) {
    const [rows] = await db.execute(
      'SELECT result, expires_at FROM scans WHERE url = ? AND status = "completed"',
      [url]
    );
    if (rows.length > 0) {
      const { result, expires_at } = rows[0];
      const now = Date.now();
      if (now < expires_at) {
        console.log(`Returning cached result for ${url}`);
        return result;
      }
    }
    return null;
  }

  static async saveResult(url, status, result) {
    const timestamp = Date.now();
    const expires_at = timestamp + EXPIRATION_SECONDS * 1000;
    await db.execute(
      'INSERT INTO webscan (url, status, result, timestamp, expires_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = ?, result = ?, timestamp = ?, expires_at = ?',
      [url, status, JSON.stringify(result), timestamp, expires_at, status, JSON.stringify(result), timestamp, expires_at]
    );
  }

  static async scanUrl(url) {
/*     const cachedResult = await this.getCachedResult(url);
    if (cachedResult) return cachedResult; */

    const report = await queue.add(() => this.performScan(url));
    const errorsAndAlerts = this.processLighthouseReport(report);
    const performanceMetrics = this.extractPerformanceMetrics(report);

    const scanResult = {
      status: 'completed',
      url: report.finalUrl || url,
      originalUrl: url,
      results: {
        errors: errorsAndAlerts.filter(item => item.type === 'error'),
        alerts: errorsAndAlerts.filter(item => item.type === 'alert'),
        totalErrors: errorsAndAlerts.filter(item => item.type === 'error').length,
        totalAlerts: errorsAndAlerts.filter(item => item.type === 'alert').length,
        performance: performanceMetrics,
      },
      timestamp: Date.now(),
    };

    await this.saveResult(url, 'completed', scanResult);
    return scanResult;
  }

  static async performScan(url) {
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
            '--single-process',
          ],
          timeout: 120000,
        });
        page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
        if (!response.ok()) throw new Error(`Navigation failed with status ${response.status()}`);

        await new Promise(resolve => setTimeout(resolve, 2000));

        const { default: lighthouse } = await import('lighthouse');
        const runnerResult = await lighthouse(await page.url(), {
          port: new URL(browser.wsEndpoint()).port,
          output: 'json',
          onlyCategories: ['performance'],  // Ensure performance category is included
          settings: {
            maxWaitForLoad: 60000,  // Increased to ensure full load
            throttlingMethod: 'simulate',  // Simulate real-world conditions for scoring
            emulatedFormFactor: 'desktop',  // Consistent device for scoring
          },
        });

        console.log('Lighthouse report categories:', JSON.stringify(runnerResult.lhr.categories, null, 2));
        return runnerResult.lhr;
      } catch (error) {
        console.error(`Scan failed for ${url}: ${error.message}`);
        if (attempt === maxRetries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 5000));
      } finally {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
      }
    }
  }

  static processLighthouseReport(report) {
    const issues = [];
    const descriptions = {
      'first-contentful-paint': 'First Contentful Paint marks the time at which the first text or image is painted.',
      'speed-index': 'Speed Index shows how quickly the contents of a page are visibly populated.',
      'largest-contentful-paint': 'Largest Contentful Paint marks the time at which the largest text or image is painted.',
      'interactive': 'The maximum potential First Input Delay that your users could experience.',
      'total-blocking-time': 'Total Blocking Time measures the total time during which tasks block the main thread.',
      'cumulative-layout-shift': 'Cumulative Layout Shift measures the movement of visible elements within the viewport.',
      'time-to-first-byte': 'Time to First Byte measures the time from navigation to the first byte received.',
      'first-meaningful-paint': 'First Meaningful Paint measures when the primary content is visible.',
      'render-blocking-resources': 'Render-blocking resources delay the first paint of your page.',
      'uses-long-cache-ttl': 'A long cache lifetime can speed up repeat visits to your page.',
    };

    for (const [auditId, audit] of Object.entries(report.audits)) {
      console.log(`Audit ${auditId}: score=${audit.score}, displayValue=${audit.displayValue || 'N/A'}`);
      if ((audit.score !== null && audit.score < 1) || audit.scoreDisplayMode === 'manual') {
        issues.push({
          type: audit.scoreDisplayMode === 'manual' ? 'alert' : 'error',
          title: auditId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          description: descriptions[auditId] || audit.description || 'Performance issue detected.',
          suggestion: 'Review the issue and update the relevant HTML/CSS.',
          score: audit.score,
          displayValue: audit.displayValue || 'N/A',
        });
      }
    }

    return issues;
  }

  static extractPerformanceMetrics(report) {
    const audits = report.audits || {};
    const safeValue = (value) => (typeof value === 'number' && !isNaN(value) ? value / 1000 : 0);
    const safeDisplay = (value, defaultUnit = 's') => {
      if (typeof value !== 'number' || isNaN(value)) return `0 ${defaultUnit}`;
      if (defaultUnit === 's') return `${(value / 1000).toFixed(1)} s`;
      if (defaultUnit === 'ms') return `${value} ms`;
      return value.toFixed(3).replace(/^0\./, '.');
    };

    const performanceScore = Math.round(report.categories?.performance?.score * 100 || 0);
    if (performanceScore === 0) {
      console.warn('Performance score is 0, check Lighthouse report:', JSON.stringify(report.categories, null, 2));
    }

    return {
      performanceScore,
      metrics: {
        firstContentfulPaint: {
          value: safeValue(audits['first-contentful-paint']?.numericValue),
          displayValue: audits['first-contentful-paint']?.displayValue || safeDisplay(audits['first-contentful-paint']?.numericValue, 's'),
        },
        speedIndex: {
          value: safeValue(audits['speed-index']?.numericValue),
          displayValue: audits['speed-index']?.displayValue || safeDisplay(audits['speed-index']?.numericValue, 's'),
        },
        largestContentfulPaint: {
          value: safeValue(audits['largest-contentful-paint']?.numericValue),
          displayValue: audits['largest-contentful-paint']?.displayValue || safeDisplay(audits['largest-contentful-paint']?.numericValue, 's'),
        },
        timeToInteractive: {
          value: safeValue(audits['interactive']?.numericValue),
          displayValue: audits['interactive']?.displayValue || safeDisplay(audits['interactive']?.numericValue, 's'),
        },
        totalBlockingTime: {
          value: audits['total-blocking-time']?.numericValue || 0,
          displayValue: audits['total-blocking-time']?.displayValue || safeDisplay(audits['total-blocking-time']?.numericValue, 'ms'),
        },
        cumulativeLayoutShift: {
          value: audits['cumulative-layout-shift']?.numericValue || 0,
          displayValue: audits['cumulative-layout-shift']?.displayValue || safeDisplay(audits['cumulative-layout-shift']?.numericValue || 0, ''),
        },
      },
    };
  }
}

module.exports = Scan;