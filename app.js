const express = require('express');
const cors = require('cors');
const Scan = require('./models/Scan');
const ScanController = require('./controllers/ScanController');

const app = express();

app.use(cors({
  origin: ['http://localhost:3000', 'https://fadilogic.serp24.online'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

app.post('/scan', ScanController.scan);

Scan.initialize().then(() => {
  app.listen(3030, () => console.log('Server running on port 3030'));
}).catch(err => console.error('Failed to initialize:', err));