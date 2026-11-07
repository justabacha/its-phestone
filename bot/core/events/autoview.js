const logger = require('../../lib/logger');
const settings = require('../settings');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

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

      let senderJid = message.key.participantAlt || message.key.participant || message.participant;

      // Programmatically resolve LID to a phone number JID via Baileys signalRepository mapping store
      if (senderJid && senderJid.endsWith('@lid') && sock.signalRepository?.lidMapping?.getPNForLID) {
        try {
          const resolvedPn = await sock.signalRepository.lidMapping.getPNForLID(senderJid);
          if (resolvedPn) {
            senderJid = jidNormalizedUser ? jidNormalizedUser(resolvedPn) : resolvedPn.split(':')[0] + '@s.whatsapp.net';
          }
        } catch (err) {
          logger.warn('autoview', `Could not resolve LID ${senderJid} to PN JID: ${err.message}`);
        }
      }

      logger.info(
        'autoview',
        `Attempting reaction to status. resolvedSenderJid=${senderJid}, participantAlt=${message.key.participantAlt}, key.participant=${message.key.participant}`
      );

      if (!senderJid || senderJid.endsWith('@lid')) {
        logger.warn('autoview', 'Cannot react to status: JID is still an unresolved LID or missing');
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