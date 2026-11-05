const fs = require('fs');
const path = require('path');

// 1. Setup fake env vars BEFORE requiring config
process.env.OWNER_NUMBERS = '1234567890';
process.env.PREFIX = '!';

const config = require('./config');
const logger = require('./lib/logger');
const settings = require('./core/settings');
const messageStore = require('./core/cache/messages');
const registry = require('./core/registry');
const errors = require('./core/errors');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function runTests() {
  console.log('--- RUNNING FOUNDATIONS TESTS ---');

  const settingsFile = path.join(__dirname, 'settings.json');
  const settingsTmpFile = path.join(__dirname, 'settings.json.tmp');
  if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
  if (fs.existsSync(settingsTmpFile)) fs.unlinkSync(settingsTmpFile);

  // Test 1: Config loads and validateConfig('foundations') passes
  config.validateConfig('foundations');
  assert(config.ownerNumbers.length === 1 && config.ownerNumbers[0] === '1234567890', 'Config ownerNumbers parsed incorrectly');

  // Test 2: validateConfig('foundations') throws when OWNER_NUMBERS empty
  const oldOwners = config.ownerNumbers;
  config.ownerNumbers = [];
  let errorThrown = false;
  try {
    config.validateConfig('foundations');
  } catch (e) {
    errorThrown = true;
    assert(e.message.includes('OWNER_NUMBERS'), 'Error message should mention OWNER_NUMBERS');
  }
  config.ownerNumbers = oldOwners;
  assert(errorThrown, 'validateConfig should throw when OWNER_NUMBERS is empty');

  // Test 3: Logger info/warn/error produce output without throwing
  logger.info('test', 'Test info message', { count: 1 });
  logger.warn('test', 'Test warn message');
  logger.error('test', 'Test error message');

  // Test 4: Logger redaction check
  const { Writable } = require('stream');
  let capturedLog = '';
  const testStream = new Writable({
    write(chunk, encoding, callback) {
      capturedLog += chunk.toString();
      callback();
    }
  });

  const testPino = logger.createLogger(testStream);
  testPino.info({
    category: 'test',
    friday: { sharedSecret: 'SECRET123' },
    FRIDAY_SHARED_SECRET: 'SECRET123'
  }, 'redaction test');

  assert(!capturedLog.includes('SECRET123'), "Logger redaction failed: 'SECRET123' was found in log output");
  assert(capturedLog.includes('[REDACTED]'), "Logger redaction failed: '[REDACTED]' missing from log output");

  // Test 5: Default settings
  settings.reload();
  assert(settings.get('antidelete') === 'off', 'Default antidelete should be off');

  // Test 6: Valid settings.set succeeds
  settings.set('antidelete', 'all');
  assert(settings.get('antidelete') === 'all', 'antidelete should be updated to all');
  assert(settings.getAll().antidelete === 'all', 'getAll() should reflect antidelete all');

  // Test 7: Invalid enum value throws SettingsError
  let settingsErrThrown = false;
  try {
    settings.set('antidelete', 'garbage');
  } catch (e) {
    settingsErrThrown = true;
    assert(e.name === 'SettingsError', 'Thrown error must be SettingsError');
  }
  assert(settingsErrThrown, 'settings.set with garbage value should throw');

  // Test 8: String boolean rejected
  let boolErrThrown = false;
  try {
    settings.set('autoView', 'true');
  } catch (e) {
    boolErrThrown = true;
    assert(e.name === 'SettingsError', 'Thrown error must be SettingsError');
  }
  assert(boolErrThrown, 'settings.set autoView with string "true" should throw');

  // Test 9: settings.json exists on disk and contains 'all'
  assert(fs.existsSync(settingsFile), 'settings.json should exist on disk');
  const diskContent = fs.readFileSync(settingsFile, 'utf8');
  assert(diskContent.includes('"antidelete": "all"'), 'settings.json on disk must contain "all"');

  // Test 10: Reload settings instance reflects persisted state
  settings.reload();
  assert(settings.get('antidelete') === 'all', 'Reloaded settings should preserve "all"');

  // Test 11: Message store put/get & getRecent
  messageStore.clear();
  const testKey = { remoteJid: 'chat123@s.whatsapp.net', fromMe: false, id: 'MSG1' };
  const testMsg = { pushName: 'Alice', message: { conversation: 'Hello Bot' }, messageTimestamp: 1700000000 };
  messageStore.put('chat123@s.whatsapp.net', testKey, testMsg);

  const retrieved = messageStore.get(testKey);
  assert(retrieved && retrieved.pushName === 'Alice', 'Message store get() failed');

  const recent = messageStore.getRecent('chat123@s.whatsapp.net', 10);
  assert(recent.length === 1, 'getRecent should return 1 message');
  assert(recent[0].role === 'user', 'Role should be user');
  assert(recent[0].name === 'Alice', 'Name should be Alice');
  assert(recent[0].text === 'Hello Bot', 'Text should be Hello Bot');
  assert(typeof recent[0].ts === 'string', 'ts should be an ISO string');

  // Test 12: Message store LRU per-chat (105 msgs in a chat)
  messageStore.clear();
  const chatId = 'chat_lru@s.whatsapp.net';
  for (let i = 1; i <= 105; i++) {
    messageStore.put(chatId, { remoteJid: chatId, fromMe: true, id: `MSG_${i}` }, {
      pushName: 'Bot',
      message: { conversation: `Msg ${i}` },
      messageTimestamp: 1700000000 + i
    });
  }
  const lruRecent = messageStore.getRecent(chatId, 150);
  assert(lruRecent.length === 100, `Expected 100 recent messages, got ${lruRecent.length}`);
  assert(lruRecent[0].text === 'Msg 6', `Oldest message remaining should be Msg 6, got ${lruRecent[0].text}`);
  assert(lruRecent[99].text === 'Msg 105', `Newest message should be Msg 105, got ${lruRecent[99].text}`);

  // Test 13: Registry loadCommands on non-existent / empty dir
  registry.clear();
  const emptyMap = registry.loadCommands(path.join(__dirname, 'non-existent-dir'));
  assert(emptyMap instanceof Map && emptyMap.size === 0, 'Registry should return empty Map on missing dir');

  // Test 14: Registry loadCommands on temp dir with valid & invalid files
  const tmpCommandsDir = path.join(__dirname, 'tmp-test-commands');
  if (fs.existsSync(tmpCommandsDir)) {
    fs.rmSync(tmpCommandsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpCommandsDir, { recursive: true });

  fs.writeFileSync(path.join(tmpCommandsDir, 'ping.js'), `
    module.exports = {
      name: 'ping',
      category: 'tools',
      aliases: ['p'],
      run: async () => {}
    };
  `);
  fs.writeFileSync(path.join(tmpCommandsDir, 'broken.js'), `
    module.exports = { name: 'broken' }; // missing run
  `);
  fs.writeFileSync(path.join(tmpCommandsDir, 'mismatch.js'), `
    module.exports = { name: 'othername', run: async () => {} };
  `);

  registry.clear();
  const loadedMap = registry.loadCommands(tmpCommandsDir);
  assert(loadedMap.size === 2, `Expected 2 entries in registry map (name + alias), got ${loadedMap.size}`);
  assert(registry.get('ping') !== undefined, 'Command "ping" should be registered');
  assert(registry.get('p') !== undefined, 'Alias "p" should point to ping command');
  assert(registry.get('broken') === undefined, 'Broken command should be skipped');
  assert(registry.get('mismatch') === undefined, 'Mismatch command should be skipped');

  fs.rmSync(tmpCommandsDir, { recursive: true, force: true });

  // Test 15: errors.sink with no sock -> logs, no throw
  await errors.sink(new Error('Test sink error'), { category: 'test-cat', command: 'ping' });

  // Test 16: errors.sink called twice with 'connection' category -> populates rate-limit map without throwing
  await errors.sink(new Error('Conn error 1'), { category: 'connection' });
  await errors.sink(new Error('Conn error 2'), { category: 'connection' });
  assert(errors._lastDmMap.has('connection'), 'Rate-limit map should contain "connection" category');

  // Cleanup settings.json created during tests
  if (fs.existsSync(settingsFile)) {
    fs.unlinkSync(settingsFile);
  }
  if (fs.existsSync(settingsTmpFile)) {
    fs.unlinkSync(settingsTmpFile);
  }

  console.log('ALL FOUNDATIONS TESTS PASSED');
}

runTests().catch(err => {
  console.error('FOUNDATIONS TEST FAILED:', err);
  process.exit(1);
});
