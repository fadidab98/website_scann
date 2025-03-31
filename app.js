const express = require('express');
const cors = require('cors');
const cluster = require('cluster');
const os = require('os');
const Scan = require('./models/Scan');
const ScanController = require('./controllers/ScanController');

const app = express();

app.use(cors());
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