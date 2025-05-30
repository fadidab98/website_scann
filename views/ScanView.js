class ScanView {
  static success(data) {
    const { url, results, timestamp } = data;
    const { performance, accessibility } = results;

    return {
      status: 'success',
      data: {
        url,
        timestamp,
        performance: {
          score: performance.metrics.performanceScore,
          errors: performance.errors.map(({ title, description, suggestion, displayValue, element }) => ({
            title,
            description,
            suggestion,
            value: displayValue,
            element: element || 'N/A',
          })),
          alerts: performance.alerts.map(({ title, description, suggestion, score, element }) => ({
            title,
            description,
            suggestion,
            score: score || 'N/A',
            element: element || 'N/A',
          })),
          metrics: {
            firstContentfulPaint: performance.metrics.metrics.firstContentfulPaint?.displayValue || '0 s',
            largestContentfulPaint: performance.metrics.metrics.largestContentfulPaint?.displayValue || '0 s',
            speedIndex: performance.metrics.metrics.speedIndex?.displayValue || '0 s',
            totalBlockingTime: performance.metrics.metrics.totalBlockingTime?.displayValue || '0 ms',
            cumulativeLayoutShift: performance.metrics.metrics.cumulativeLayoutShift?.displayValue || '0',
            interactive: performance.metrics.metrics.interactive?.displayValue || '0 s',
          },
        },
        accessibility: {
          score: accessibility.metrics.accessibilityScore,
          errors: accessibility.errors.map(({ title, description, suggestion, displayValue, element }) => ({
            title,
            description,
            suggestion,
            value: displayValue || 'N/A',
            element: element || 'N/A',
          })),
          alerts: accessibility.alerts.map(({ title, description, suggestion, score, element }) => ({
            title,
            description,
            suggestion,
            score: score || 'N/A',
            element: element || 'N/A',
          })),
          metrics: {
            imageAltIssues: accessibility.metrics.metrics.imageAltIssues?.count || 0,
            labelIssues: accessibility.metrics.metrics.labelIssues?.count || 0,
            linkNameIssues: accessibility.metrics.metrics.linkNameIssues?.count || 0,
            contrastIssues: accessibility.metrics.metrics.contrastIssues?.count || 0,
            ariaIssues: accessibility.metrics.metrics.ariaIssues?.count || 0,
            bypassIssues: accessibility.metrics.metrics.bypassIssues?.count || 0,
          },
        },
      },
    };
  }

  static error(message) {
    return {
      status: 'error',
      message,
    };
  }
}

module.exports = ScanView;