const logger = require('../../lib/logger');
const settings = require('../settings');

function registerAutoview(sock) {
  sock.ev.on('messages.upsert', async (m) => {
    for (const message of m.messages) {
      if (message.key.remoteJid !== 'status@broadcast') continue;

      try {
        if (settings.get('autoView')) {
          await sock.readMessages([message.key]);
        }

        if (settings.get('autoReact')) {
          const emojis = settings.get('reactEmojis');
          if (emojis.length > 0) {
            const emoji = emojis[Math.floor(Math.random() * emojis.length)];
            await sock.sendMessage(
              'status@broadcast',
              { react: { text: emoji, key: message.key } },
              { statusJidList: [message.key.participant] }
            );
          }
        }
      } catch (err) {
        logger.error('autoview', 'Failed to process status message', { error: err.message });
      }
    }
  });
}

module.exports = {
  registerAutoview
};
