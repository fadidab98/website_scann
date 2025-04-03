const express = require('express');
const cors = require('cors');
const cluster = require('cluster');
const os = require('os');
const Scan = require('./models/Scan');
const ScanController = require('./controllers/ScanController');

const app = express();

// Define allowed origins
const allowedOrigins = [
  'http://localhost:3000', // Adjust port if your frontend runs on a different one
  'https://fadilogic.serp24.online/' 
];

// Configure CORS to allow only specific origins
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g., curl, Postman) or if origin is in allowed list
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST'], // Restrict to allowed methods
  allowedHeaders: ['Content-Type'], // Restrict to allowed headers
}));
app.use(express.json());

const numCPUs = os.cpus().length;

if (cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  cluster.on('exit', (worker) => {
    console.log(`Worker ${worker.process.pid} died, restarting...`);
    cluster.fork();
  });
} else {
  app.post('/scan', ScanController.scan);

  Scan.initialize().then(() => {
    app.listen(3030, () => {
      console.log(`Worker ${process.pid} running on port 3000`);
    });
  }).catch(err => {
    console.error(`Worker ${process.pid} failed to initialize database:`, err);
    process.exit(1);
  });
}