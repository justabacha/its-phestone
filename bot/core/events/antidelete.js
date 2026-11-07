const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const config = require('../../config');
const logger = require('../../lib/logger');
const messageStore = require('../cache/messages');
const settings = require('../settings');

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];

async function downloadMedia(mediaMessage, type) {
  const stream = await downloadContentFromMessage(mediaMessage, type);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function getText(message) {
  return message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.audioMessage?.caption ||
    '';
}

async function handleDeletion(sock, key) {
  if (!key || key.fromMe) return;

  const mode = settings.get('antidelete');
  if (mode === 'off') return;

  const remoteJid = key.remoteJid;
  if (!remoteJid || (mode === 'private' && remoteJid.endsWith('@g.us'))) return;

  const ghostMessage = messageStore.get(key);
  if (!ghostMessage) return;

  let location = remoteJid.endsWith('@g.us') ? 'Group' : 'Private DM';
  if (remoteJid.endsWith('@g.us')) {
    try {
      const metadata = await sock.groupMetadata(remoteJid);
      location = metadata.subject;
    } catch (err) {
      location = remoteJid.split('@')[0];
    }
  }

  const sender = key.participant || remoteJid;
  let report = `*🚨 SILENT LOG: ANTIDELETE 🚨*\n`;
  report += `━━━━━━━━━━━━━━━━━━━━\n`;
  report += `👤 *From:* @${sender.split('@')[0]}\n`;
  report += `📍 *Where:* ${location}\n`;

  const message = ghostMessage.message || {};
  const text = getText(message);
  const mediaType = MEDIA_TYPES.find(type => message[`${type}Message`]);
  if (text) report += `💬 *Message:* ${text}\n`;

  const ownerNumber = config.ownerNumbers && config.ownerNumbers[0];
  if (!ownerNumber) {
    logger.error('antidelete', 'Cannot forward deleted message: no owner number is configured');
    return;
  }
  const ownerDigits = ownerNumber.replace(/[^0-9]/g, '');
  if (!ownerDigits) {
    logger.error('antidelete', 'Cannot forward deleted message: configured owner number is invalid');
    return;
  }
  const ownerJid = `${ownerDigits}@s.whatsapp.net`;

  if (mediaType) {
    const mediaMessage = message[`${mediaType}Message`];
    report += `💬 *Media:* ${mediaType}\n`;

    try {
      const buffer = await downloadMedia(mediaMessage, mediaType);
      const payload = {
        [mediaType]: buffer,
        caption: report
      };
      if (mediaMessage.mimetype) payload.mimetype = mediaMessage.mimetype;
      await sock.sendMessage(ownerJid, payload, { mentions: [sender] });
    } catch (err) {
      logger.error('antidelete', 'Failed to download or forward deleted media', {
        error: err.message,
        remoteJid
      });
      await sock.sendMessage(ownerJid, { text: `${report}⚠️ Media could not be downloaded.` }, {
        mentions: [sender]
      });
    }
    return;
  }

  if (report.endsWith('\n')) report = report.slice(0, -1);
  await sock.sendMessage(ownerJid, { text: report }, { mentions: [sender] });
}

function registerAntidelete(sock) {
  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      if (update.update?.message !== null && update.update?.messageStubType !== 1) continue;

      try {
        await handleDeletion(sock, update.key);
      } catch (err) {
        logger.error('antidelete', 'Failed to process deleted message update', {
          error: err.message
        });
      }
    }
  });
}

module.exports = {
  registerAntidelete
};
