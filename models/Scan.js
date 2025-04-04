const puppeteer = require('puppeteer');
const mysql = require('mysql2/promise');
const PQueue = require('p-queue').default;

const dbConfig = {
  host: 'db',
  user: 'admin',
  password: 'f1233211',
  database: 'scans_db',
};
const queue = new PQueue({ concurrency: 2 }); // Increased to 2
let db;
const EXPIRATION_SECONDS = 86400; // 24 hours for caching

let sharedBrowser = null;

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

  static async getBrowser() {
    if (!sharedBrowser || !sharedBrowser.connected) {
      console.log('Launching new shared browser');
      sharedBrowser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--no-zygote',
          '--disable-accelerated-2d-canvas',
        ],
        timeout: 120000,
      });
    }
    return sharedBrowser;
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
    let browser;
    let page;
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        console.log(`DEBUG: Starting scan for ${url}, attempt ${attempt + 1}`);
        console.log(`Puppeteer version: ${puppeteer.version || 'undefined'}`);
        console.log(`Puppeteer launch available: ${typeof puppeteer.launch === 'function'}`);

        browser = await this.getBrowser();
        console.log(`Browser in use for ${url}: ${browser.wsEndpoint()}`);
        console.log(`Browser connected: ${browser.connected}`);

        page = await browser.newPage();
        console.log(`Page created for ${url}`);
        console.log(`Page has waitForTimeout: ${typeof page.waitForTimeout === 'function'}`);

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        console.log(`Navigating to ${url}`);
        const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
        const status = response.status();
        if (!(response.ok() || status === 304)) {
          throw new Error(`Navigation failed with status ${status}`);
        }

        const currentUrl = await page.url();
        console.log(`Current URL after navigation: ${currentUrl}`);

        console.log('Waiting 2 seconds');
        await new Promise(resolve => setTimeout(resolve, 2000));

        const { default: lighthouse } = await import('lighthouse');
        console.log('Lighthouse imported');

        const runnerResult = await lighthouse(currentUrl, {
          port: new URL(browser.wsEndpoint()).port,
          output: 'json',
          logLevel: 'info',
          onlyCategories: ['performance'],
          settings: {
            maxWaitForLoad: 60000, // Reduced for efficiency
            throttlingMethod: 'provided',
          },
        });

        console.log('Lighthouse scan completed');
        const report = runnerResult.lhr;
        console.log('Lighthouse audits:', Object.keys(report.audits));

        return report;
      } catch (error) {
        console.error(`Scan error for ${url} on attempt ${attempt + 1}:`, error.message);
        attempt++;
        if (attempt < maxRetries) {
          if (browser && browser.connected) {
            console.log(`Resetting shared browser due to error: ${error.message}`);
            await browser.close().catch(err => console.error(`Browser close error: ${err.message}`));
          }
          sharedBrowser = null;
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          throw error;
        }
      } finally {
        if (page && !page.isClosed()) {
          try {
            await page.close();
            console.log(`Page closed for ${url}`);
          } catch (err) {
            console.error(`Page close error for ${url}:`, err.message);
          }
        }
      }
    }
  }

  static processLighthouseReport(report) {
    const issues = [];
    const descriptions = {
      'first-contentful-paint': 'First Contentful Paint marks the time at which the first text or image is painted. [Learn more](https://developer.chrome.com/docs/lighthouse/performance/first-contentful-paint/).',
      'speed-index': 'Speed Index shows how quickly the contents of a page are visibly populated. [Learn more](https://developer.chrome.com/docs/lighthouse/performance/speed-index/).',
      'largest-contentful-paint': 'Largest Contentful Paint marks the time at which the largest text or image is painted. [Learn more](https://developer.chrome.com/docs/lighthouse/performance/lighthouse-largest-contentful-paint/).',
      'interactive': 'The maximum potential First Input Delay that your users could experience is the duration of the longest task. [Learn more](https://developer.chrome.com/docs/lighthouse/performance/lighthouse-max-potential-fid/).',
      'total-blocking-time': 'Total Blocking Time measures the total time during which tasks block the main thread. [Learn more](https://web.dev/tbt/).',
      'cumulative-layout-shift': 'Cumulative Layout Shift measures the movement of visible elements within the viewport. [Learn more](https://web.dev/articles/cls).',
      'time-to-first-byte': 'Time to First Byte measures the time from navigation to the first byte received. [Learn more](https://web.dev/time-to-first-byte/).',
      'first-meaningful-paint': 'First Meaningful Paint measures when the primary content is visible. [Learn more](https://developer.chrome.com/docs/lighthouse/performance/first-meaningful-paint/).',
      'render-blocking-resources': 'Render-blocking resources delay the first paint of your page. [Learn more](https://web.dev/render-blocking-resources/).',
      'uses-long-cache-ttl': 'A long cache lifetime can speed up repeat visits to your page. [Learn more](https://web.dev/uses-long-cache-ttl/).',
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

    if (report.audits['uses-long-cache-ttl'] && report.audits['uses-long-cache-ttl'].score < 1) {
      issues.push({
        type: 'alert',
        title: 'Use Efficient Cache Lifetimes',
        description: descriptions['uses-long-cache-ttl'],
        suggestion: 'Review the issue and update the relevant HTML/CSS.',
        score: report.audits['uses-long-cache-ttl'].score,
        displayValue: report.audits['uses-long-cache-ttl'].displayValue || 'N/A',
      });
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