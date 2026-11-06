const config = require('../config');
const logger = require('../lib/logger');
const registry = require('./registry');

// Deduplication cache — prevents double-processing sync copies
const processedMessages = new Set();

// Clear cache hourly to prevent memory leaks
setInterval(() => {
  processedMessages.clear();
}, 60 * 60 * 1000);

async function handleMessages(sock, messages) {
  for (const m of messages) {
    // Skip empty messages
    if (!m.message) continue;

    // Skip protocol/sync messages (receipts, history sync, etc.)
    if (m.message.protocolMessage || m.message.receiptMessage) continue;

    // Skip status broadcasts
    if (m.key.remoteJid === 'status@broadcast') continue;

    // Skip messages older than 5 minutes (prevents old queued messages on reconnect)
    const msgTimestamp = m.messageTimestamp;
    if (msgTimestamp && Date.now() - (msgTimestamp * 1000) > 300000) {
      continue;
    }

    // Deduplicate by message ID (handles multi-device sync duplicates)
    const msgId = m.key.id;
    if (processedMessages.has(msgId)) continue;
    processedMessages.add(msgId);

    // Owner check
    const sender = m.key.participant || m.key.remoteJid;
    const isOwner = m.key.fromMe || config.ownerNumbers.some(num => sender.includes(num));
    if (!isOwner) continue;

    // Extract command text
    const body = m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      m.message.imageMessage?.caption ||
      '';
    if (!body.startsWith(config.prefix)) continue;

    // Parse command
    const args = body.slice(config.prefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();
    const command = registry.get(commandName);
    if (!command) continue;

    // Build context
    const ctx = {
      sock,
      msg: m,
      chatId: m.key.remoteJid,
      sender,
      isGroup: m.key.remoteJid.endsWith('@g.us'),
      isOwner,
      args,
      rawText: body,
      commandName,
      reply: async (text) => {
        await sock.sendMessage(m.key.remoteJid, { text }, { quoted: m });
      }
    };

    // Execute
    try {
      await command.run(ctx);
    } catch (err) {
      logger.error('router', `Command ${commandName} failed`, { error: err.message });
    }
  }
}

module.exports = {
  handleMessages
};