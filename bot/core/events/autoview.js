const logger = require('../../lib/logger');
const settings = require('../settings');

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
      await delay(10000, 30000);

      if (Math.random() < 0.5) {
        logger.info('autoview', 'Skipping reaction for natural UX');
        return;
      }

      const emojis = settings.get('reactEmojis') || [];
      if (emojis.length === 0) return;

      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      const senderJid = message.key.participant || message.participant;

      logger.info(
        'autoview',
        `Attempting reaction to status. senderJid=${senderJid}, key.participant=${message.key.participant}, participant=${message.participant}`
      );

      if (!senderJid) {
        logger.warn('autoview', 'Cannot react to status: missing sender JID');
      } else {
        try {
          await sock.sendMessage(
            'status@broadcast',
            { react: { text: emoji, key: message.key } },
            { statusJidList: [senderJid] }
          );
          logger.info('autoview', `Reacted ${emoji} to status from ${senderJid}`);
        } catch (err) {
          logger.error('autoview', `Failed to react to status: ${err.message}`, {
            senderJid,
            error: err.stack
          });
        }
      }
    }
  } catch (err) {
    logger.error('autoview', 'Failed to process status message', { error: err.message });
  }
}

function registerAutoview(sock) {
  sock.ev.on('messages.upsert', (m) => {
    for (const message of m.messages) {
      if (message.key.remoteJid === 'status@broadcast') {
        handleStatus(sock, message).catch(err => logger.error('autoview', err.message));
      }
    }
  });
}

module.exports = {
  registerAutoview
};
