const Scan = require('../models/Scan');
const ScanView = require('../views/ScanView');

class ScanController {
  static async scan(req, res) {
    const { url } = req.body;

    if (!url || !url.match(/^https?:\/\/[^\s/$.?#].[^\s]*$/i)) {
      return res.status(400).json(ScanView.error('Invalid URL'));
    }

    console.log(`Controller: Received scan request for ${url}`);

    try {
      const result = await Scan.scanUrl(url);
      res.json(ScanView.success(result));
    } catch (error) {
      console.error(`Controller: Scan failed for ${url}:`, error);
      res.status(500).json(ScanView.error(error.message || 'Unknown error'));
    }
  }
}

module.exports = ScanController;