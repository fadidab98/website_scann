const puppeteer = require('puppeteer');
const mysql = require('mysql2/promise');
const PQueue = require('p-queue').default;

const dbConfig = {
  host: 'db',
  user: 'admin',
  password: 'f1233211',
  database: 'scans_db',
};

let db;
const queue = new PQueue({ concurrency: 2 });
const EXPIRATION_SECONDS = 7200;

class Scan {
  static async initialize() {
    const maxRetries = 10;
    const retryDelay = 2000;

    const baseConfig = {
      host: 'db',
      user: 'admin',
      password: 'f1233211',
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let baseConnection;
      try {
        baseConnection = await mysql.createConnection(baseConfig);
        console.log('Connected to MySQL server');
        await baseConnection.execute(`CREATE DATABASE IF NOT EXISTS scans_db`);
        console.log('Database scans_db ensured');
        break;
      } catch (error) {
        console.error(`Database check attempt ${attempt} failed:`, error.message);
        if (attempt === maxRetries) throw new Error('Failed to connect to MySQL server after maximum retries');
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } finally {
        if (baseConnection) await baseConnection.end();
      }
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        db = await mysql.createConnection(dbConfig);
        console.log('Connected to MySQL database in Scan model');
        await db.execute(`CREATE TABLE IF NOT EXISTS scans (
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
        if (attempt === maxRetries) throw new Error('Failed to connect to scans_db after maximum retries');
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
        console.log(`Returning cached result for ${url} (expires at ${new Date(expires_at)})`);
        return result;
      }
      console.log(`Cached result for ${url} expired at ${new Date(expires_at)}`);
    }
    return null;
  }

  static async saveResult(url, status, result) {
    const timestamp = Date.now();
    const expires_at = timestamp + EXPIRATION_SECONDS * 1000;
    const resultString = JSON.stringify(result);
    console.log('Saving result for', url, 'with data:', resultString);
    await db.execute(
      'INSERT INTO scans (url, status, result, timestamp, expires_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = ?, result = ?, timestamp = ?, expires_at = ?',
      [url, status, resultString, timestamp, expires_at, status, resultString, timestamp, expires_at]
    );
    console.log(`Saved result for ${url} with expiration at ${new Date(expires_at)}`);
  }

  static async scanUrl(url) {
    const cachedResult = await this.getCachedResult(url);
    if (cachedResult) return cachedResult;

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
    let browser;
    let page;
    try {
      console.log(`Starting Puppeteer for ${url}`);
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        timeout: 60000,
      });
      console.log(`Browser launched for ${url}: ${browser.wsEndpoint()}`);

      page = await browser.newPage();
      console.log(`Page created for ${url}`);

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      console.log(`Navigating to ${url}`);
      const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      if (!response.ok()) {
        throw new Error(`Navigation failed with status ${response.status()}`);
      }

      const currentUrl = await page.url();
      console.log(`Current URL after navigation: ${currentUrl}`);

      // Ensure page is stable before Lighthouse
      await page.waitForTimeout(2000);

      const { default: lighthouse } = await import('lighthouse');
      console.log('Lighthouse imported');

      const runnerResult = await lighthouse(currentUrl, {
        port: new URL(browser.wsEndpoint()).port,
        output: 'json',
        logLevel: 'info',
        onlyCategories: ['performance'],
        settings: {
          maxWaitForLoad: 60000,
          throttlingMethod: 'provided', // Use Puppeteer’s throttling
        },
      });

      console.log('Lighthouse scan completed');
      const report = runnerResult.lhr;
      console.log('Lighthouse audits:', Object.keys(report.audits));

      return report;
    } catch (error) {
      console.error(`Scan error for ${url}:`, error.message);
      throw error;
    } finally {
      // Close resources only after ensuring no operations are pending
      if (page) {
        try {
          await page.close();
          console.log(`Page closed for ${url}`);
        } catch (err) {
          console.error(`Page close error for ${url}:`, err.message);
        }
      }
      if (browser) {
        try {
          await browser.close();
          console.log(`Browser closed for ${url}`);
        } catch (err) {
          console.error(`Browser close error for ${url}:`, err.message);
        }
      }
    }
  }

  static processLighthouseReport(report) {
    const issues = [];
    const descriptions = {
      'first-contentful-paint': 'First Contentful Paint marks the time at which the first text or image is painted. [Learn more about the First Contentful Paint metric](https://developer.chrome.com/docs/lighthouse/performance/first-contentful-paint/).',
      'speed-index': 'Speed Index shows how quickly the contents of a page are visibly populated. [Learn more about the Speed Index metric](https://developer.chrome.com/docs/lighthouse/performance/speed-index/).',
      'largest-contentful-paint': 'Largest Contentful Paint marks the time at which the largest text or image is painted. [Learn more about the Largest Contentful Paint metric](https://developer.chrome.com/docs/lighthouse/performance/lighthouse-largest-contentful-paint/).',
      'interactive': 'The maximum potential First Input Delay that your users could experience is the duration of the longest task. [Learn more about the Maximum Potential First Input Delay metric](https://developer.chrome.com/docs/lighthouse/performance/lighthouse-max-potential-fid/).',
      'total-blocking-time': 'Total Blocking Time measures the total time during which tasks block the main thread. [Learn more](https://web.dev/tbt/).',
      'cumulative-layout-shift': 'Cumulative Layout Shift measures the movement of visible elements within the viewport. [Learn more about the Cumulative Layout Shift metric](https://web.dev/articles/cls).',
      'time-to-first-byte': 'Time to First Byte measures the time from navigation to the first byte received. [Learn more](https://web.dev/time-to-first-byte/).',
      'first-meaningful-paint': 'First Meaningful Paint measures when the primary content is visible. [Learn more](https://developer.chrome.com/docs/lighthouse/performance/first-meaningful-paint/).',
      'render-blocking-resources': 'Render-blocking resources delay the first paint of your page. [Learn more](https://web.dev/render-blocking-resources/).',
      'uses-long-cache-ttl': 'A long cache lifetime can speed up repeat visits to your page. [Learn more](https://web.dev/uses-long-cache-ttl/).',
    };

    for (const [auditId, audit] of Object.entries(report.audits)) {
      console.log(`Audit ${auditId}: ${audit.numericValue || audit.score || 'N/A'}`);
      issues.push({
        type: 'error',
        title: auditId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        description: descriptions[auditId] || audit.description || 'Performance issue detected.',
        suggestion: 'Review the issue and update the relevant HTML/CSS.',
      });
    }

    issues.push({
      type: 'alert',
      title: 'Use Efficient Cache Lifetimes',
      description: descriptions['uses-long-cache-ttl'],
      suggestion: 'Review the issue and update the relevant HTML/CSS.',
    });

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

    return {
      performanceScore: Math.round(report.categories?.performance?.score * 100 || 0),
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