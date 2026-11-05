const logger = require('./logger');
const config = require('../config');

function splitLong(text, maxLength = 4000) {
  if (!text) return [''];
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx <= 0) {
      splitIdx = maxLength;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

async function notifyOwner(sock, text) {
  try {
    if (!sock) {
      logger.warn('owner', 'no socket; owner DM skipped', { text });
      return false;
    }
    if (!config.ownerNumbers || config.ownerNumbers.length === 0) {
      logger.warn('owner', 'no owner numbers configured; owner DM skipped');
      return false;
    }
    const cleanNumber = config.ownerNumbers[0].replace(/[^0-9]/g, '');
    const ownerJid = `${cleanNumber}@s.whatsapp.net`;
    const chunks = splitLong(text, 4000);
    for (const chunk of chunks) {
      await sock.sendMessage(ownerJid, { text: chunk });
    }
    return true;
  } catch (err) {
    logger.error('owner', 'failed to notify owner', { error: err.message });
    return false;
  }
}

async function notifyOwnerMedia(sock, type, buffer, opts = {}) {
  try {
    if (!sock) {
      logger.warn('owner', 'no socket; owner media DM skipped', { type });
      return false;
    }
    if (!config.ownerNumbers || config.ownerNumbers.length === 0) {
      logger.warn('owner', 'no owner numbers configured; owner media DM skipped');
      return false;
    }
    const cleanNumber = config.ownerNumbers[0].replace(/[^0-9]/g, '');
    const ownerJid = `${cleanNumber}@s.whatsapp.net`;
    const messageContent = { [type]: buffer, ...opts };
    await sock.sendMessage(ownerJid, messageContent);
    return true;
  } catch (err) {
    logger.error('owner', 'failed to notify owner media', { error: err.message });
    return false;
  }
}

module.exports = {
  notifyOwner,
  notifyOwnerMedia,
  splitLong
};
