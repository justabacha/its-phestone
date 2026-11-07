const { downloadContentFromMessage } = require('queen-senaya');

async function toBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function downloadMedia(mediaMessage, type) {
  const stream = await downloadContentFromMessage(mediaMessage, type);
  return {
    buffer: await toBuffer(stream),
    type,
    mime: mediaMessage.mimetype
  };
}

async function downloadQuotedMedia(msg) {
  const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quotedMessage) return null;

  for (const type of ['image', 'video', 'audio', 'document']) {
    const mediaMessage = quotedMessage[`${type}Message`];
    if (mediaMessage) {
      return downloadMedia(mediaMessage, type);
    }
  }

  return null;
}

async function downloadFromStatus(statusMsg) {
  const message = statusMsg.message;

  for (const type of ['image', 'video']) {
    const mediaMessage = message?.[`${type}Message`];
    if (mediaMessage) {
      return downloadMedia(mediaMessage, type);
    }
  }

  return null;
}

module.exports = {
  downloadQuotedMedia,
  downloadFromStatus
};
