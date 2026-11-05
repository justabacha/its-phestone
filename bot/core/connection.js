const makeWASocket = require('@whiskeysockets/baileys').default;
const { fetchLatestBaileysVersion, Browsers, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const config = require('../config');
const logger = require('../lib/logger');
const { useMongoDBAuthState } = require('./auth-state');

let reconnectAttempt = 0;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMongoDBAuthState(config);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  logger.info('connection', `Initializing Baileys v${version.join('.')}, isLatest=${isLatest}`);

  const client = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'),
    mobile: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    getMessage: async (key) => {
      // Hooked to messageStore in future slice (5C)
      return undefined;
    }
  });

  client.ev.on('creds.update', saveCreds);

  let pairingRequested = false;

  client.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR terminal generation disabled to avoid console clutter
    // if (qr) {
    //   qrcode.generate(qr, { small: true });
    // }

    if (qr && !state.creds.registered && !pairingRequested) {
      pairingRequested = true;
      if (config.ownerNumbers && config.ownerNumbers[0]) {
        const ownerNumber = config.ownerNumbers[0].replace(/[^0-9]/g, '');
        if (ownerNumber) {
          try {
            logger.info('connection', `Requesting pairing code for owner number: ${ownerNumber}...`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const code = await client.requestPairingCode(ownerNumber);
            logger.info('connection', `PAIRING CODE: ${code}`);

            console.log('\n==================================================');
            console.log(`  YOUR WHATSAPP PAIRING CODE: ${code}`);
            console.log('==================================================\n');
          } catch (err) {
            logger.error('connection', 'Failed to request pairing code', { error: err.message });
          }
        } else {
          logger.warn('connection', 'Owner number format invalid for pairing code');
        }
      } else {
        logger.warn('connection', 'No owner number provided for pairing code');
      }
    }

    if (connection === 'open') {
      reconnectAttempt = 0;
      logger.info('connection', 'WhatsApp connected successfully!');
    }

    if (connection === 'close') {
      let statusCode = null;
      if (lastDisconnect && lastDisconnect.error) {
        if (lastDisconnect.error instanceof Boom) {
          statusCode = lastDisconnect.error.output.statusCode;
        } else if (lastDisconnect.error.output && lastDisconnect.error.output.statusCode) {
          statusCode = lastDisconnect.error.output.statusCode;
        }
      }

      logger.warn('connection', `Connection closed with statusCode=${statusCode || 'unknown'}`, {
        error: lastDisconnect && lastDisconnect.error ? lastDisconnect.error.message : undefined
      });

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        logger.fatal('connection', 'Session logged out or invalid (statusCode 401). Delete MongoDB session and re-pair.');
        process.exit(1);
      } else {
        reconnectAttempt++;
        const baseDelay = 5000 * Math.pow(2, reconnectAttempt - 1);
        const jitter = Math.floor(Math.random() * 5000);
        const delay = Math.min(baseDelay, 60000) + jitter;

        logger.warn('connection', `Reconnecting in ${delay}ms (attempt #${reconnectAttempt})...`);
        setTimeout(() => {
          connectToWhatsApp();
        }, delay);
      }
    }
  });

  return client;
}

module.exports = {
  connectToWhatsApp
};
