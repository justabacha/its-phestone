const config = require('../config');
const logger = require('../lib/logger');
const { getMongoClient, useMongoDBAuthState } = require('./auth-state');

class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsError';
  }
}

const SCHEMA = {
  antidelete:  { type: 'enum',    values: ['all', 'private', 'off'], default: 'off' },
  autopilot:   { type: 'array',   of: 'string', default: [] },
  autoView:    { type: 'boolean', default: false },
  autoReact:   { type: 'boolean', default: false },
  reactEmojis: { type: 'array',   of: 'string', default: ['😂', '❤️', '🔥'] }
};

let currentSettings = {};
let initialized = false;
let settingsWriteQueue = Promise.resolve();

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

async function loadFromMongo() {
  await settingsWriteQueue;
  const collection = getMongoClient().db('its-phestone-auth').collection('settings');
  const defaults = getDefaultSettings();
  const result = await collection.findOneAndUpdate(
    { _id: 'global' },
    { $setOnInsert: defaults },
    { upsert: true, returnDocument: 'after' }
  );
  const document = result?.value || result;

  if (!document) {
    throw new Error('Failed to load settings document from MongoDB');
  }

  const loadedSettings = getDefaultSettings();
  for (const key of Object.keys(SCHEMA)) {
    if (!(key in document)) continue;
    try {
      validate(key, document[key]);
      loadedSettings[key] = Array.isArray(document[key]) ? [...document[key]] : document[key];
    } catch (err) {
      logger.warn('settings', `Invalid persisted setting for '${key}', using default`, { error: err.message });
    }
  }

  currentSettings = loadedSettings;
  initialized = true;
}

async function initSettings() {
  await useMongoDBAuthState(config);
  await loadFromMongo();
}

function get(key) {
  if (!(key in SCHEMA)) {
    throw new SettingsError(`Unknown setting key: '${key}'`);
  }
  return currentSettings[key];
}

function set(key, value) {
  validate(key, value);
  if (!initialized) {
    throw new Error('Settings are not initialized. Call initSettings() first.');
  }

  currentSettings[key] = Array.isArray(value) ? [...value] : value;
  const valueToPersist = Array.isArray(value) ? [...value] : value;
  settingsWriteQueue = settingsWriteQueue
    .then(() => getMongoClient().db('its-phestone-auth').collection('settings').updateOne(
      { _id: 'global' },
      { $set: { [key]: valueToPersist } },
      { upsert: true }
    ))
    .catch((err) => {
      logger.error('settings', `Failed to persist setting '${key}'`, { error: err.message });
    });
}

function getAll() {
  return Object.freeze(JSON.parse(JSON.stringify(currentSettings)));
}

async function reload() {
  if (!initialized) {
    return initSettings();
  }
  await loadFromMongo();
}

module.exports = {
  initSettings,
  get,
  set,
  getAll,
  reload,
  SettingsError,
  SCHEMA
};
