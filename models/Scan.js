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

class Scan {
  static async initialize() {
    const maxRetries = 10;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        db = await mysql.createConnection(dbConfig);
        await db.execute(`CREATE TABLE IF NOT EXISTS webscan (
          id INT AUTO_INCREMENT PRIMARY KEY,
          url VARCHAR(255) UNIQUE,
          status VARCHAR(50),
          result JSON,
          timestamp BIGINT,
          expires_at BIGINT
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
        return rows[0].result;
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

  static async scanUrl(url) {
    // Re-enable caching if desired
    const cachedResult = await this.getCachedResult(url);
    if (cachedResult) return cachedResult;

    const report = await queue.add(() => this.performScan(url));
    const performanceIssues = this.processLighthouseReport(report, 'performance');
    const accessibilityIssues = this.processLighthouseReport(report, 'accessibility');
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

        // Extract HTML for custom accessibility checks
        const htmlContent = await page.content();

        const { default: lighthouse } = await import('lighthouse');
        const runnerResult = await lighthouse(await page.url(), {
          port: new URL(browser.wsEndpoint()).port,
          output: 'json',
          onlyCategories: ['performance', 'accessibility'], // Added accessibility
          audits: [
            // Performance audits
            'first-contentful-paint',
            'speed-index',
            'largest-contentful-paint',
            'interactive',
            'total-blocking-time',
            'cumulative-layout-shift',
            // Accessibility audits
            'accesskeys',
            'aria-allowed-attr',
            'aria-hidden-body',
            'aria-required-attr',
            'image-alt',
            'label',
            'link-name',
            'color-contrast',
          ],
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

        // Add custom HTML accessibility checks
        const customAccessibilityIssues = await this.checkHtmlAccessibility(page, htmlContent);
        runnerResult.lhr.customAccessibilityIssues = customAccessibilityIssues;

        console.log('Full Lighthouse report:', JSON.stringify(runnerResult.lhr, null, 2));
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

  static async checkHtmlAccessibility(page, htmlContent) {
    // Custom HTML accessibility checks to mimic WAVE
    const issues = [];
    try {
      // Check for images without alt attributes
      const images = await page.$$eval('img', imgs =>
        imgs.map(img => ({
          src: img.src,
          alt: img.getAttribute('alt'),
        }))
      );
      images.forEach(img => {
        if (!img.alt && img.alt !== '') {
          issues.push({
            type: 'error',
            title: 'Missing Image Alt Text',
            description: `Image with src "${img.src}" is missing an alt attribute.`,
            suggestion: 'Add a descriptive alt attribute to the image.',
          });
        }
      });

      // Check for form inputs without labels
      const inputs = await page.$$eval('input:not([type="hidden"])', inputs =>
        inputs.map(input => ({
          id: input.id,
          hasLabel: !!document.querySelector(`label[for="${input.id}"]`),
        }))
      );
      inputs.forEach(input => {
        if (!input.hasLabel && input.id) {
          issues.push({
            type: 'error',
            title: 'Missing Form Label',
            description: `Input with id "${input.id}" lacks an associated label.`,
            suggestion: 'Add a <label> element with a for attribute matching the input’s id.',
          });
        }
      });

      // Check for empty links
      const links = await page.$$eval('a', anchors =>
        anchors.map(a => ({
          href: a.href,
          text: a.textContent.trim(),
        }))
      );
      links.forEach(link => {
        if (!link.text && !link.href.includes('#')) {
          issues.push({
            type: 'alert',
            title: 'Empty Link Text',
            description: `Link with href "${link.href}" has no visible text.`,
            suggestion: 'Provide descriptive text or an aria-label for the link.',
          });
        }
      });
    } catch (error) {
      console.error('Custom HTML accessibility check failed:', error.message);
    }
    return issues;
  }

  static processLighthouseReport(report, category) {
    const issues = [];
    const descriptions = {
      // Performance descriptions
      'first-contentful-paint': 'First Contentful Paint measures initial paint time.',
      'speed-index': 'Speed Index shows how quickly content is populated.',
      'largest-contentful-paint': 'Largest Contentful Paint measures largest element render time.',
      'interactive': 'Time to Interactive measures when the page is fully interactive.',
      'total-blocking-time': 'Total Blocking Time sums up main thread blocking.',
      'cumulative-layout-shift': 'Cumulative Layout Shift measures visual stability.',
      // Accessibility descriptions
      'image-alt': 'Images must have alternate text for screen readers.',
      'aria-allowed-attr': 'ARIA attributes must conform to valid usage.',
      'aria-hidden-body': 'Body element must not have aria-hidden="true".',
      'aria-required-attr': 'Required ARIA attributes must be provided.',
      'accesskeys': 'Accesskey attributes should be unique and meaningful.',
      'label': 'Form elements must have associated labels.',
      'link-name': 'Links must have discernible text.',
      'color-contrast': 'Text must have sufficient color contrast for readability.',
    };

    const audits = report.audits || {};
    for (const [auditId, audit] of Object.entries(audits)) {
      if (
        (audit.score !== null && audit.score < 0.9 && report.categories[category].auditRefs.some(ref => ref.id === auditId)) ||
        audit.scoreDisplayMode === 'manual' ||
        audit.scoreDisplayMode === 'notApplicable'
      ) {
        issues.push({
          type: audit.scoreDisplayMode === 'manual' || audit.scoreDisplayMode === 'notApplicable' ? 'alert' : 'error',
          title: auditId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          description: descriptions[auditId] || audit.description || 'Issue detected.',
          suggestion: audit.details?.items?.length
            ? `Review ${audit.details.items.length} specific instances: ${JSON.stringify(audit.details.items)}`
            : 'Optimize based on audit recommendations.',
          score: audit.score,
          displayValue: audit.displayValue || 'N/A',
        });
      }
    }

    // Add custom accessibility issues if present
    if (category === 'accessibility' && report.customAccessibilityIssues) {
      issues.push(...report.customAccessibilityIssues);
    }

    return issues;
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

  static extractAccessibilityMetrics(report) {
    const accessibilityScore = Math.round(report.categories?.accessibility?.score * 100 || 0);
    const audits = report.audits || {};
    return {
      accessibilityScore,
      metrics: {
        imageAltIssues: {
          count: audits['image-alt']?.details?.items?.length || 0,
          description: 'Number of images missing alt text.',
        },
        ariaIssues: {
          count: (audits['aria-allowed-attr']?.details?.items?.length || 0) + (audits['aria-required-attr']?.details?.items?.length || 0),
          description: 'Number of ARIA attribute issues.',
        },
        labelIssues: {
          count: audits['label']?.details?.items?.length || 0,
          description: 'Number of form elements missing labels.',
        },
        contrastIssues: {
          count: audits['color-contrast']?.details?.items?.length || 0,
          description: 'Number of elements with insufficient color contrast.',
        },
      },
    };
  }
}

module.exports = Scan;