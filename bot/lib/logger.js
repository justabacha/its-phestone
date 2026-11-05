const pino = require('pino');
const config = require('../config');

// see docs/03 §7 for redaction paths
function createLogger(dest) {
  return pino({
    level: config.logLevel || 'info',
    redact: {
      paths: [
        'friday.sharedSecret',
        'supabase.serviceKey',
        'mongodbUri',
        'err.config.headers.Authorization',
        'FRIDAY_SHARED_SECRET'
      ],
      censor: '[REDACTED]'
    },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`
  }, dest);
}

const pinoInstance = createLogger();

function log(level, category, msg, meta = {}) {
  const payload = (meta && typeof meta === 'object') ? { category, ...meta } : { category, meta };
  pinoInstance[level](payload, msg);
}

const logger = {
  info: (category, msg, meta) => log('info', category, msg, meta),
  warn: (category, msg, meta) => log('warn', category, msg, meta),
  error: (category, msg, meta) => log('error', category, msg, meta),
  fatal: (category, msg, meta) => log('fatal', category, msg, meta),
  createLogger,
  _pino: pinoInstance
};

module.exports = logger;
