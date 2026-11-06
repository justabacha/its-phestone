process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message);
  // Keep the process alive for transient runtime errors.
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
});

const http = require('http');
const { validateConfig } = require('./config');
const path = require('path');
const connection = require('./core/connection');
const registry = require('./core/registry');
const { initSettings } = require('./core/settings');
const logger = require('./lib/logger');
const { sink } = require('./core/errors');

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('app', 'Shutting down gracefully...', { signal });
  setTimeout(() => process.exit(0), 2000);
  if (healthServer.listening) {
    healthServer.close();
  }

  try {
    await connection.shutdownConnection();
  } catch (err) {
    logger.error('app', 'Failed to close WhatsApp connection cleanly', { error: err.message });
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const port = process.env.PORT || 3000;
const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('its-phestone is alive\n');
});
healthServer.listen(port, '0.0.0.0', () => {
  console.log(`[Health Check] Dummy HTTP server listening on port ${port}`);
});

async function start() {
  try {
    logger.info('app', 'Starting its-phestone bot engine...');
    validateConfig('foundations');
  } catch (err) {
    logger.fatal('app', 'Fatal error during bot initialization', { error: err.message, stack: err.stack });
    await sink(err, { category: 'connection', phase: 'startup' });
    process.exit(1);
  }

  try {
    const commandsDir = path.join(__dirname, 'commands');
    registry.loadCommands(commandsDir);
    await initSettings();
    await connection.connectToWhatsApp();
  } catch (err) {
    console.error('Fatal error in connectToWhatsApp():', err);
    if (err && err.stack) {
      console.error(err.stack);
    }
    logger.fatal('app', 'Fatal error connecting to WhatsApp', { error: err.message, stack: err.stack });
    await sink(err, { category: 'connection', phase: 'startup' });
    console.error('Process exit prevented for debugging in console.');
    // Prevent process from exiting immediately
    setInterval(() => {}, 3600000);
  }
}

start();
