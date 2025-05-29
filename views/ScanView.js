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
          errors: performance.errors.map(({ title, description, suggestion, displayValue }) => ({
            title,
            description,
            suggestion,
            value: displayValue,
          })),
          alerts: performance.alerts.map(({ title, description, suggestion }) => ({
            title,
            description,
            suggestion,
          })),
          metrics: {
            firstContentfulPaint: performance.metrics.metrics.firstContentfulPaint.displayValue,
            largestContentfulPaint: performance.metrics.metrics.largestContentfulPaint.displayValue,
            totalBlockingTime: performance.metrics.metrics.totalBlockingTime.displayValue,
            cumulativeLayoutShift: performance.metrics.metrics.cumulativeLayoutShift.displayValue,
          },
        },
        accessibility: {
          score: accessibility.metrics.accessibilityScore,
          errors: accessibility.errors.map(({ title, description, suggestion, displayValue }) => ({
            title,
            description,
            suggestion,
            value: displayValue || 'N/A',
          })),
          alerts: accessibility.alerts.map(({ title, description, suggestion }) => ({
            title,
            description,
            suggestion,
          })),
          metrics: {
            imageAltIssues: accessibility.metrics.metrics.imageAltIssues.count,
            labelIssues: accessibility.metrics.metrics.labelIssues.count,
            contrastIssues: accessibility.metrics.metrics.contrastIssues.count,
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