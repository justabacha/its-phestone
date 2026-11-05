require('dotenv').config();

const config = {
  prefix: process.env.PREFIX || '!',
  ownerNumbers: (process.env.OWNER_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean),
  branding: process.env.BRANDING || '',
  mongodbUri: process.env.MONGODB_URI || null,
  supabase: {
    url: process.env.SUPABASE_URL || null,
    serviceKey: process.env.SUPABASE_SERVICE_KEY || null
  },
  friday: {
    url: process.env.FRIDAY_URL || null,
    sharedSecret: process.env.FRIDAY_SHARED_SECRET || null
  },
  autopilot: {
    timerMs: parseInt(process.env.AUTOPILOT_TIMER_MS, 10) || 120000,
    maxExchanges: parseInt(process.env.AUTOPILOT_MAX_EXCHANGES, 10) || 10,
    sessionCapMs: 4 * 60 * 60 * 1000
  },
  fridayContextWindow: parseInt(process.env.FRIDAY_CONTEXT_WINDOW, 10) || 20,
  logLevel: process.env.LOG_LEVEL || 'info'
};

function validateConfig(stage) {
  const missing = [];

  if (stage === 'foundations' || stage === 'connection' || stage === 'friday') {
    if (!config.ownerNumbers || config.ownerNumbers.length === 0) {
      missing.push('OWNER_NUMBERS');
    }
    if (!config.prefix || config.prefix.length < 1) {
      missing.push('PREFIX');
    }
  }

  if (stage === 'connection' || stage === 'friday') {
    if (!config.mongodbUri) {
      missing.push('MONGODB_URI');
    }
  }

  if (stage === 'friday') {
    if (!config.supabase.url) missing.push('SUPABASE_URL');
    if (!config.supabase.serviceKey) missing.push('SUPABASE_SERVICE_KEY');
    if (!config.friday.url) missing.push('FRIDAY_URL');
    if (!config.friday.sharedSecret) missing.push('FRIDAY_SHARED_SECRET');
  }

  if (missing.length > 0) {
    throw new Error(`Invalid configuration for stage '${stage}'. Missing/invalid variables: ${missing.join(', ')}`);
  }
}

config.validateConfig = validateConfig;

module.exports = config;
