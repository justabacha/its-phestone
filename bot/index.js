const { validateConfig } = require('./config');
const { connectToWhatsApp } = require('./core/connection');
const logger = require('./lib/logger');
const { sink } = require('./core/errors');

async function start() {
  try {
    logger.info('app', 'Starting its-phestone bot engine...');
    validateConfig('foundations');
    await connectToWhatsApp();
  } catch (err) {
    logger.fatal('app', 'Fatal error during bot initialization', { error: err.message, stack: err.stack });
    await sink(err, { category: 'connection', phase: 'startup' });
    process.exit(1);
  }
}

start();
