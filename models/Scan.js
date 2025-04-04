const puppeteer = require('puppeteer');
const mysql = require('mysql2/promise');
const PQueue = require('p-queue').default;

const dbConfig = {
  host: 'db',
  user: 'admin',
  password: 'f1233211',
  database: 'scans_db',
};
const queue = new PQueue({ concurrency: 2 }); // Allows 2 scans at once
let db;
const EXPIRATION_SECONDS = 172800; // 48 hours

class Scan {
  static async initialize() {
    const maxRetries = 10;
    const retryDelay = 2000;

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
      'INSERT INTO scans (url, status, result, timestamp, expires_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = ?, result = ?, timestamp = ?, expires_at = ?',
      [url, status, JSON.stringify(result), timestamp, expires_at, status, JSON.stringify(result), timestamp, expires_at]
    );
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
            '--single-process',  // Reduces memory usage
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
          onlyCategories: ['performance'],
          settings: { maxWaitForLoad: 30000 },  // Reduced for efficiency
        });

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
    for (const [auditId, audit] of Object.entries(report.audits)) {
      if ((audit.score !== null && audit.score < 1) || audit.scoreDisplayMode === 'manual') {
        issues.push({
          type: audit.scoreDisplayMode === 'manual' ? 'alert' : 'error',
          title: auditId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          description: audit.description || 'Performance issue detected.',
          suggestion: 'Review and optimize.',
          score: audit.score,
          displayValue: audit.displayValue || 'N/A',
        });
      }
    }
    return issues;
  }

  static extractPerformanceMetrics(report) {
    const audits = report.audits || {};
    const safeValue = (value) => (typeof value === 'number' ? value / 1000 : 0);
    return {
      performanceScore: Math.round(report.categories?.performance?.score * 100 || 0),
      metrics: {
        firstContentfulPaint: { value: safeValue(audits['first-contentful-paint']?.numericValue) },
        speedIndex: { value: safeValue(audits['speed-index']?.numericValue) },
        largestContentfulPaint: { value: safeValue(audits['largest-contentful-paint']?.numericValue) },
        timeToInteractive: { value: safeValue(audits['interactive']?.numericValue) },
        totalBlockingTime: { value: audits['total-blocking-time']?.numericValue || 0 },
        cumulativeLayoutShift: { value: audits['cumulative-layout-shift']?.numericValue || 0 },
      },
    };
  }
}

module.exports = Scan;