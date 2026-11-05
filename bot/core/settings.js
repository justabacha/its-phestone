const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');
// Deferred to future slice: config.mongodbUri for Mongo persistence hook (see docs/03 §6)

class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsError';
  }
}

const SCHEMA = {
  antidelete:  { type: 'enum',    values: ['all', 'group', 'private', 'off'], default: 'off' },
  autopilot:   { type: 'array',   of: 'string', default: [] },
  autoView:    { type: 'boolean', default: false },
  autoReact:   { type: 'boolean', default: false },
  reactEmojis: { type: 'array',   of: 'string', default: ['😂', '❤️', '🔥'] }
};

const settingsPath = path.join(__dirname, '../settings.json');
const tmpPath = path.join(__dirname, '../settings.json.tmp');

let cache = {};

function getDefaultSettings() {
  const defaults = {};
  for (const [key, schema] of Object.entries(SCHEMA)) {
    defaults[key] = Array.isArray(schema.default) ? [...schema.default] : schema.default;
  }
  return defaults;
}

function validate(key, value) {
  if (!(key in SCHEMA)) {
    throw new SettingsError(`Unknown setting key: '${key}'`);
  }
  const schema = SCHEMA[key];

  if (schema.type === 'enum') {
    if (typeof value !== 'string' || !schema.values.includes(value)) {
      throw new SettingsError(`Invalid value '${value}' for enum setting '${key}'. Allowed: ${schema.values.join(', ')}`);
    }
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new SettingsError(`Invalid type '${typeof value}' for boolean setting '${key}'. Expected boolean.`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      throw new SettingsError(`Invalid type '${typeof value}' for array setting '${key}'. Expected array.`);
    }
    for (const item of value) {
      if (typeof item !== schema.of || (schema.of === 'string' && item.trim().length === 0)) {
        throw new SettingsError(`Invalid item '${item}' in array setting '${key}'. Expected non-empty ${schema.of}.`);
      }
    }
  }
}

function writeToDisk(data) {
  const jsonStr = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, jsonStr, 'utf8');
  const fd = fs.openSync(tmpPath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, settingsPath);
}

function loadFromDisk() {
  cache = getDefaultSettings();
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [k, v] of Object.entries(parsed)) {
        if (k in SCHEMA) {
          try {
            validate(k, v);
            cache[k] = v;
          } catch (valErr) {
            logger.warn('settings', `Corrupt or invalid setting for '${k}' on disk, using default`, { error: valErr.message });
          }
        }
      }
    } catch (err) {
      logger.warn('settings', 'Failed to read settings.json or file corrupt, using defaults', { error: err.message });
    }
  }
}

// Initial load on module load
loadFromDisk();

function get(key) {
  if (!(key in SCHEMA)) {
    throw new SettingsError(`Unknown setting key: '${key}'`);
  }
  return cache[key];
}

function set(key, value) {
  validate(key, value);
  cache[key] = value;
  writeToDisk(cache);
}

function getAll() {
  return Object.freeze(JSON.parse(JSON.stringify(cache)));
}

function reload() {
  loadFromDisk();
}

module.exports = {
  get,
  set,
  getAll,
  reload,
  SettingsError,
  SCHEMA
};
