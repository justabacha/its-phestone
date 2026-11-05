const { validateConfig } = require('./config');
const path = require('path');
const { connectToWhatsApp } = require('./core/connection');
const registry = require('./core/registry');
const logger = require('./lib/logger');
const { sink } = require('./core/errors');

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
    await connectToWhatsApp();
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
