const config = require('../config');
const logger = require('../lib/logger');
const registry = require('./registry');

async function handleMessages(sock, messages) {
  for (const m of messages) {
    // Ignore messages older than 60 seconds to prevent retry loops
    const msgTimestamp = m.messageTimestamp;
    if (msgTimestamp && Date.now() - (msgTimestamp * 1000) > 60000) {
      continue;
    }

    if (!m.message) continue;
    if (m.key.remoteJid === 'status@broadcast') continue;

    const sender = m.key.participant || m.key.remoteJid;
    const isOwner = m.key.fromMe || config.ownerNumbers.some(num => sender.includes(num));
    if (!isOwner) continue;

    const body = m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      m.message.imageMessage?.caption ||
      '';
    if (!body.startsWith(config.prefix)) continue;

    const args = body.slice(config.prefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();
    const command = registry.get(commandName);
    if (!command) continue;

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
