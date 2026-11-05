const logger = require('../../lib/logger');

const MAX_CHATS = 200;
const PER_CHAT = 100;

// Map<chatId, Array<{ keyStr, keyObj, message }>>
const chatMap = new Map();
// Map<keyStr, message>
const globalKeyMap = new Map();

function normalizeKey(key) {
  if (typeof key === 'string') return key;
  if (!key || typeof key !== 'object') return String(key || '');
  return `${key.remoteJid || ''}:${key.fromMe ? '1' : '0'}:${key.id || ''}`;
}

function extractText(msgObj) {
  if (!msgObj) return '[media]';
  const msg = msgObj.message || msgObj;
  if (!msg) return '[media]';
  if (typeof msg.conversation === 'string' && msg.conversation.trim().length > 0) {
    return msg.conversation;
  }
  if (msg.extendedTextMessage && typeof msg.extendedTextMessage.text === 'string' && msg.extendedTextMessage.text.trim().length > 0) {
    return msg.extendedTextMessage.text;
  }
  if (msg.imageMessage && typeof msg.imageMessage.caption === 'string' && msg.imageMessage.caption.trim().length > 0) {
    return msg.imageMessage.caption;
  }
  if (msg.videoMessage && typeof msg.videoMessage.caption === 'string' && msg.videoMessage.caption.trim().length > 0) {
    return msg.videoMessage.caption;
  }
  if (msg.documentMessage && typeof msg.documentMessage.caption === 'string' && msg.documentMessage.caption.trim().length > 0) {
    return msg.documentMessage.caption;
  }
  return '[media]';
}

function put(chatId, key, message) {
  try {
    if (!chatId || !key || !message) return;
    const keyStr = normalizeKey(key);

    let chatMsgs = chatMap.get(chatId);
    if (!chatMsgs) {
      chatMsgs = [];
    } else {
      chatMap.delete(chatId);
    }

    chatMsgs.push({ keyStr, keyObj: typeof key === 'object' ? key : null, message });
    globalKeyMap.set(keyStr, message);

    while (chatMsgs.length > PER_CHAT) {
      const evicted = chatMsgs.shift();
      globalKeyMap.delete(evicted.keyStr);
    }

    chatMap.set(chatId, chatMsgs);

    while (chatMap.size > MAX_CHATS) {
      const lruChatId = chatMap.keys().next().value;
      const evictedMsgs = chatMap.get(lruChatId) || [];
      for (const m of evictedMsgs) {
        globalKeyMap.delete(m.keyStr);
      }
      chatMap.delete(lruChatId);
    }
  } catch (err) {
    logger.warn('messages', 'Error putting message into store', { error: err.message });
  }
}

function get(key) {
  try {
    const keyStr = normalizeKey(key);
    return globalKeyMap.get(keyStr);
  } catch (err) {
    logger.warn('messages', 'Error getting message from store', { error: err.message });
    return undefined;
  }
}

function getRecent(chatId, count = 20) {
  try {
    const chatMsgs = chatMap.get(chatId) || [];
    const recent = chatMsgs.slice(-count);

    return recent.map(({ keyObj, message }) => {
      const fromMe = keyObj ? Boolean(keyObj.fromMe) : Boolean(message.key && message.key.fromMe);
      const role = fromMe ? 'assistant' : 'user';
      const name = message.pushName || (fromMe ? 'Owner' : 'User');
      const text = extractText(message);

      let ts;
      if (message.messageTimestamp) {
        const rawTs = Number(message.messageTimestamp);
        const ms = rawTs < 1e11 ? rawTs * 1000 : rawTs;
        ts = new Date(ms).toISOString();
      } else {
        ts = new Date().toISOString();
      }

      return { role, name, text, ts };
    });
  } catch (err) {
    logger.warn('messages', 'Error getting recent messages', { error: err.message });
    return [];
  }
}

function clear() {
  chatMap.clear();
  globalKeyMap.clear();
}

module.exports = {
  put,
  get,
  getRecent,
  clear
};
