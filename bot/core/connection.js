const { randomUUID } = require('crypto');
const makeWASocket = require('queen-senaya').default;
const { fetchLatestBaileysVersion, Browsers, DisconnectReason } = require('queen-senaya');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const config = require('../config');
const logger = require('../lib/logger');
const { useMongoDBAuthState, getMongoClient } = require('./auth-state');
const { handleMessages } = require('./router');
const messageStore = require('./cache/messages');
const { registerAutoview } = require('./events/autoview');

const LEASE_ID = 'bot_lease';
const LEASE_TTL_MS = 60000;
const LEASE_HEARTBEAT_MS = 30000;
const leaseToken = randomUUID();

let reconnectAttempt = 0;
let activeClient = null;
let activeLeaseCollection = null;
let leaseHeartbeat = null;
let isConnecting = false;
let reconnectTimer = null;
let isShuttingDown = false;

function scheduleReconnect(delay) {
  if (isShuttingDown || reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp().catch((err) => {
      logger.error('connection', 'Reconnect attempt failed', { error: err.message });
    });
  }, delay);
}

async function releaseLease(collection) {
  if (!collection) return;
  await collection.updateOne(
    { _id: LEASE_ID, owner: process.pid, token: leaseToken },
    { $set: { expiresAt: 0 } }
  );
}

async function releaseLeaseSafely(collection) {
  try {
    await releaseLease(collection);
  } catch (err) {
    logger.error('connection', 'Failed to release MongoDB session lease!!', { error: err.message });
  }
}

function startLeaseHeartbeat(collection, client) {
  let heartbeatInProgress = false;

  leaseHeartbeat = setInterval(async () => {
    if (heartbeatInProgress || isShuttingDown) return;
    heartbeatInProgress = true;

    try {
      const result = await collection.updateOne(
        { _id: LEASE_ID, owner: process.pid, token: leaseToken },
        { $set: { expiresAt: Date.now() + LEASE_TTL_MS } }
      );

      if (result.matchedCount === 0) {
        logger.error('connection', 'MongoDB session lease was lost; closing WhatsApp socket');
        clearInterval(leaseHeartbeat);
        leaseHeartbeat = null;
        await client.end();
      }
    } catch (err) {
      logger.error('connection', 'Failed to renew MongoDB session lease; closing WhatsApp socket', {
        error: err.message
      });
      clearInterval(leaseHeartbeat);
      leaseHeartbeat = null;
      try {
        await client.end();
      } catch (endError) {
        logger.error('connection', 'Failed to close socket after lease renewal failure', {
          error: endError.message
        });
      }
    } finally {
      heartbeatInProgress = false;
    }
  }, LEASE_HEARTBEAT_MS);
}

async function connectToWhatsApp() {
  if (isConnecting || activeClient || isShuttingDown) return;
  isConnecting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  let leaseCollection = null;
  let leaseAcquired = false;
  let client = null;
  let keepLease = false;

  try {
    const startupDelay = Math.floor(Math.random() * 10000) + 5000;
    logger.info('connection', `Waiting ${startupDelay}ms for old container to die...`);
    await new Promise(resolve => setTimeout(resolve, startupDelay));
    if (isShuttingDown) return;

    const { state, saveCreds } = await useMongoDBAuthState(config);
    if (isShuttingDown) return;

    leaseCollection = getMongoClient().db('its-phestone-auth').collection('lease');
    const now = Date.now();
    try {
      await leaseCollection.findOneAndUpdate(
        {
          _id: LEASE_ID,
          $or: [
            { expiresAt: { $lt: now } },
            { expiresAt: { $exists: false } }
          ]
        },
        {
          $set: {
            owner: process.pid,
            token: leaseToken,
            expiresAt: now + LEASE_TTL_MS
          }
        },
        { upsert: true, returnDocument: 'after' }
      );
      leaseAcquired = true;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }

    if (!leaseAcquired) {
      logger.warn('connection', 'Another container holds the lease. Waiting...');
      isConnecting = false;
      scheduleReconnect(5000);
      return;
    }

    activeLeaseCollection = leaseCollection;
    if (isShuttingDown) return;

    const { version, isLatest } = await fetchLatestBaileysVersion();
    if (isShuttingDown) return;

    logger.info('connection', `Initializing Baileys v${version.join('.')}, isLatest=${isLatest}`);

    client = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Desktop'),
      mobile: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async (key) => {
        const msg = messageStore.get(key);
        if (msg) {
          return msg.message;
        }
        return undefined;
      }
    });

    activeClient = client;
    startLeaseHeartbeat(leaseCollection, client);

    const loggedTransientSocketErrors = new Set();
    client.ws.on('CB:error', (node) => {
      const error = node?.content?.[0]?.error;
      if (!error) return;

      const errMsg = error.toString();
      const isTransient = errMsg.includes('Bad MAC') ||
        errMsg.includes('428') ||
        errMsg.includes('Precondition');

      if (isTransient) {
        const errorType = errMsg.includes('Bad MAC')
          ? 'Bad MAC'
          : errMsg.includes('428') ? '428' : 'Precondition';
        if (loggedTransientSocketErrors.has(errorType)) return;

        loggedTransientSocketErrors.add(errorType);
        logger.warn('connection', 'Ignored transient socket error: ' + errMsg);
      }
    });

    client.ev.on('messages.upsert', async (m) => {
      for (const message of m.messages) {
        if (message.key && message.key.remoteJid) {
          messageStore.put(message.key.remoteJid, message.key, message);
        }
      }

      if (m.type === 'notify') {
        await handleMessages(client, m.messages);
      }
    });

    client.ev.on('creds.update', saveCreds);
    registerAutoview(client);

    let pairingRequested = false;
    let connectionClosed = false;

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
        isConnecting = false;
        logger.info('connection', 'WhatsApp connected successfully!');
      }

      if (connection === 'close') {
        if (connectionClosed) return;
        connectionClosed = true;

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

        if (leaseHeartbeat) {
          clearInterval(leaseHeartbeat);
          leaseHeartbeat = null;
        }
        if (activeClient === client) activeClient = null;
        if (activeLeaseCollection === leaseCollection) activeLeaseCollection = null;
        await releaseLeaseSafely(leaseCollection);
        isConnecting = false;

        if (isShuttingDown) return;

        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          logger.fatal('connection', 'Session logged out or invalid (statusCode 401). Delete MongoDB session and re-pair.');
          process.exit(1);
        } else {
          // Add a fixed 5s pause to prevent 440 loops
          await new Promise(resolve => setTimeout(resolve, 5000));
          reconnectAttempt++;
          const baseDelay = 5000 * Math.pow(2, reconnectAttempt - 1);
          const jitter = Math.floor(Math.random() * 5000);
          const delay = Math.min(baseDelay, 60000) + jitter;

          logger.warn('connection', `Reconnecting in ${delay}ms (attempt #${reconnectAttempt})...`);
          scheduleReconnect(delay);
        }
      }
    });

    keepLease = true;
    return client;
  } catch (err) {
    reconnectAttempt++;
    const baseDelay = 5000 * Math.pow(2, reconnectAttempt - 1);
    const delay = Math.min(baseDelay, 60000) + Math.floor(Math.random() * 5000);
    logger.error('connection', 'Failed to initialize WhatsApp connection', { error: err.message });
    scheduleReconnect(delay);
    throw err;
  } finally {
    isConnecting = false;
    if (!keepLease) {
      if (leaseHeartbeat) {
        clearInterval(leaseHeartbeat);
        leaseHeartbeat = null;
      }
      if (activeClient === client) activeClient = null;
      if (activeLeaseCollection === leaseCollection) activeLeaseCollection = null;
      if (client) {
        try {
          await client.end();
        } catch (err) {
          logger.error('connection', 'Failed to close incomplete WhatsApp connection', { error: err.message });
        }
      }
      if (leaseAcquired) {
        await releaseLeaseSafely(leaseCollection);
      }
    }
  }
}

function getActiveClient() {
  return activeClient;
}

async function shutdownConnection() {
  isShuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (leaseHeartbeat) {
    clearInterval(leaseHeartbeat);
    leaseHeartbeat = null;
  }

  const client = activeClient;
  const leaseCollection = activeLeaseCollection;
  activeClient = null;
  activeLeaseCollection = null;

  if (client) {
    await client.end();
  }
  await releaseLeaseSafely(leaseCollection);
}

module.exports = {
  connectToWhatsApp,
  getActiveClient,
  shutdownConnection
};
