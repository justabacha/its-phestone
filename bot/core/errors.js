const logger = require('../lib/logger');
const { notifyOwner } = require('../lib/owner');

const CRITICAL_CATEGORIES = ['connection', 'friday-auth', 'friday-5xx-storm'];
const lastDmMap = new Map();

async function sink(err, context = {}) {
  try {
    const { sock, category = 'general', phase, command, chatId, ...restContext } = context;
    const errMessage = (err && err.message) ? err.message : String(err || 'Unknown error');
    const stack = err && err.stack ? err.stack : undefined;

    // Filter out err.config, err.request, headers proactively per D34
    const safeContext = { ...restContext };
    delete safeContext.config;
    delete safeContext.request;
    delete safeContext.headers;

    logger.error(category, errMessage, {
      phase,
      command,
      chatId,
      stack,
      ...safeContext
    });

    if (CRITICAL_CATEGORIES.includes(category)) {
      const now = Date.now();
      const lastTs = lastDmMap.get(category) || 0;
      if (now - lastTs >= 60000) {
        lastDmMap.set(category, now);
        if (sock) {
          const alertMsg = `[CRITICAL ALERT - ${category.toUpperCase()}]\nError: ${errMessage}${command ? `\nCommand: ${command}` : ''}${chatId ? `\nChat: ${chatId}` : ''}`;
          await notifyOwner(sock, alertMsg);
        }
      }
    }
  } catch (sinkErr) {
    // Sink must never throw (per D33)
  }
}

module.exports = {
  sink,
  CRITICAL_CATEGORIES,
  _lastDmMap: lastDmMap
};
