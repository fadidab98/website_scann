class ScanView {
  static success(data) {
    return data;
  }

  static error(message) {
    return {
      status: 'failed',
      error: message,
      timestamp: Date.now(),
    };
  }
}

module.exports = ScanView;