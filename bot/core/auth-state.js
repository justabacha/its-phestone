const { MongoClient } = require('mongodb');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const logger = require('../lib/logger');

let mongoClient = null;
let mongoClientPromise = null;

async function useMongoDBAuthState(config) {
  const uri = (config && config.mongodbUri) || process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required for MongoDB auth state');
  }

  if (!mongoClient) {
    if (!mongoClientPromise) {
      mongoClientPromise = (async () => {
        const client = new MongoClient(uri);
        await client.connect();
        mongoClient = client;
        logger.info('auth-state', 'Connected to MongoDB for session auth state');
        return client;
      })();
    }

    try {
      await mongoClientPromise;
    } finally {
      mongoClientPromise = null;
    }
  }

  const db = mongoClient.db('its-phestone-auth');
  const collection = db.collection('baileys_auth');

  async function readData(id) {
    const doc = await collection.findOne({ _id: id });
    if (!doc || !doc.data) return null;
    return JSON.parse(doc.data, BufferJSON.reviver);
  }

  async function writeData(id, value) {
    if (value === null || value === undefined) {
      await collection.deleteOne({ _id: id });
    } else {
      const jsonStr = JSON.stringify(value, BufferJSON.replacer);
      await collection.updateOne(
        { _id: id },
        { $set: { data: jsonStr, updatedAt: new Date() } },
        { upsert: true }
      );
    }
  }

  const existingCreds = await readData('creds');
  const creds = existingCreds || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        await Promise.all(
          ids.map(async (id) => {
            const val = await readData(`${type}-${id}`);
            if (val) {
              data[id] = val;
            }
          })
        );
        return data;
      },
      set: async (data) => {
        const tasks = [];
        for (const category in data) {
          for (const id in data[category]) {
            const val = data[category][id];
            tasks.push(writeData(`${category}-${id}`, val));
          }
        }
        await Promise.all(tasks);
      }
    }
  };

  async function saveCreds() {
    await writeData('creds', creds);
  }

  return { state, saveCreds };
}

function getMongoClient() {
  if (!mongoClient) {
    throw new Error('MongoDB auth state is not initialized');
  }
  return mongoClient;
}

module.exports = {
  useMongoDBAuthState,
  getMongoClient
};
