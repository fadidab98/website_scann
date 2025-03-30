const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json());

// POST /scan: Perform a website scan and return results directly
app.post('/scan', async (req, res) => {
  const { url } = req.body;

  // Validate the URL
  if (!url || !url.match(/^https?:\/\/[^\s/$.?#].[^\s]*$/i)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  let browser;
  try {
    console.log(`Starting scan for ${url}`);

    // Launch Puppeteer
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();

    // Set a user agent to avoid being blocked
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    console.log('Navigating to URL');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Dynamically import Lighthouse
    const { default: lighthouse } = await import('lighthouse');
    console.log('Lighthouse imported');

    // Run Lighthouse with minimal options
    const runnerResult = await lighthouse(url, {
      port: new URL(browser.wsEndpoint()).port,
      output: 'json',
      logLevel: 'info',
    });

    console.log('Lighthouse scan completed');
    const report = runnerResult.lhr;

    await browser.close();

    // Process the report
    const errorsAndAlerts = processLighthouseReport(report);

    // Send the response directly
    res.json({
      status: 'completed',
      url,
      results: {
        errors: errorsAndAlerts.filter(item => item.type === 'error'),
        alerts: errorsAndAlerts.filter(item => item.type === 'alert'),
        totalErrors: errorsAndAlerts.filter(item => item.type === 'error').length,
        totalAlerts: errorsAndAlerts.filter(item => item.type === 'alert').length,
      },
    });
  } catch (error) {
    console.error(`Scan failed: ${error.message}`);
    res.status(500).json({
      status: 'failed',
      url,
      error: error.message,
    });
    if (browser) await browser.close();
  }
});

function processLighthouseReport(report) {
  const issues = [];
  for (const [auditId, audit] of Object.entries(report.audits)) {
    if ((audit.score !== null && audit.score < 1) || audit.scoreDisplayMode === 'manual') {
      if (audit.details && audit.details.items && audit.details.items.length > 0) {
        audit.details.items.forEach(item => {
          const issue = {
            type: audit.scoreDisplayMode === 'manual' ? 'alert' : 'error',
            title: audit.title,
            description: audit.description,
            suggestion: getSuggestion(auditId),
          };
          if (item.node) {
            issue.element = {
              selector: item.node.selector || 'Unknown',
              snippet: item.node.snippet || 'No snippet available',
            };
          } else if (item.selector) {
            issue.element = { selector: item.selector, snippet: 'No snippet provided' };
          }
          issues.push(issue);
        });
      } else {
        issues.push({
          type: audit.scoreDisplayMode === 'manual' ? 'alert' : 'error',
          title: audit.title,
          description: audit.description,
          suggestion: getSuggestion(auditId),
        });
      }
    }
  }
  return issues;
}

function getSuggestion(auditId) {
  const suggestions = {
    'image-alt': 'Add a descriptive "alt" attribute to the <img> tag (e.g., alt="description").',
    'color-contrast': 'Adjust CSS to increase contrast (e.g., change text color to #000).',
    'link-name': 'Add meaningful text inside the <a> tag (e.g., <a href="#">Learn More</a>).',
    'button-name': 'Add text or an "aria-label" to the <button> (e.g., <button aria-label="Submit">).',
    'render-blocking-resources': 'Defer non-critical CSS/JS (e.g., add "defer" to <script>).',
    'document-title': 'Add a <title> tag to the <head> (e.g., <title>My Website</title>).',
  };
  console.log(auditId  )
  return suggestions[auditId] || 'Review the issue and update the relevant HTML/CSS.';
}

app.listen(3000, () => console.log('API running on port 3000'));