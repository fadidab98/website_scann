const express = require('express');
const cors = require('cors');
const Scan = require('./models/Scan');
const ScanController = require('./controllers/ScanController');

const app = express();

const allowedOrigins = ['http://localhost:3030', 'https://fadilogic.serp24.online'];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

app.post('/scan', ScanController.scan);

Scan.initialize().then(() => {
  app.listen(3030, () => console.log('Server running on port 3030'));
}).catch(err => console.error('Failed to initialize:', err));