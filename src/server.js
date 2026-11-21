const app = require('./app');
const config = require('./config');

const server = app.listen(config.port, () => {
  console.log(`TaskMaster API listening on http://localhost:${config.port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
