const logger = require('../../lib/logger');
const settings = require('../settings');

let statusQueue = Promise.resolve();

function delay(min, max) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, duration));
}

async function handleStatus(sock, message) {
  try {
    await delay(30000, 90000);

    if (settings.get('autoView')) {
      await sock.readMessages([message.key]);
    }

    if (settings.get('autoReact')) {
      await delay(2000, 5000);
      const emojis = settings.get('reactEmojis');
      if (emojis.length === 0) return;

      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      await sock.sendMessage(
        'status@broadcast',
        { react: { text: emoji, key: message.key } },
        { statusJidList: [message.key.participant] }
      );
    }
  } catch (err) {
    logger.error('autoview', 'Failed to process status message', { error: err.message });
  }
}

function registerAutoview(sock) {
  sock.ev.on('messages.upsert', (m) => {
    for (const message of m.messages) {
      if (message.key.remoteJid !== 'status@broadcast') continue;
      statusQueue = statusQueue.then(() => handleStatus(sock, message));
    }
  });
}

module.exports = {
  registerAutoview
};
