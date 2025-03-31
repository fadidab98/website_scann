class ScanView {
    static success(data) {
      return data; // Already in the desired JSON format from the Model
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