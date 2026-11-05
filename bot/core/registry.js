const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');

let registryMap = null;

function loadCommands(commandsDir = path.join(__dirname, '../commands')) {
  registryMap = new Map();
  let loadedCommandsCount = 0;
  let loadedAliasesCount = 0;
  const categoriesSet = new Set();

  if (!fs.existsSync(commandsDir)) {
    logger.info('registry', 'Commands directory does not exist, initializing empty registry', { commandsDir });
    return registryMap;
  }

  let files = [];
  try {
    files = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'));
  } catch (err) {
    logger.warn('registry', 'Failed to read commands directory', { error: err.message });
    return registryMap;
  }

  for (const file of files) {
    const fullPath = path.join(commandsDir, file);
    const expectedName = path.basename(file, '.js');

    try {
      const cmd = require(fullPath);

      if (!cmd || typeof cmd !== 'object') {
        logger.warn('registry', `Invalid command module in '${file}': not an object`, { file });
        continue;
      }

      if (typeof cmd.name !== 'string' || typeof cmd.run !== 'function') {
        logger.warn('registry', `Invalid command module in '${file}': missing string 'name' or function 'run'`, { file });
        continue;
      }

      if (cmd.name !== expectedName) {
        logger.warn('registry', `Command name mismatch in '${file}': expected '${expectedName}', got '${cmd.name}'`, { file });
        continue;
      }

      registryMap.set(cmd.name, cmd);
      loadedCommandsCount++;
      if (cmd.category) {
        categoriesSet.add(cmd.category);
      } else {
        categoriesSet.add('general');
      }

      if (Array.isArray(cmd.aliases)) {
        for (const alias of cmd.aliases) {
          if (typeof alias === 'string' && alias.trim().length > 0) {
            registryMap.set(alias, cmd);
            loadedAliasesCount++;
          }
        }
      }
    } catch (err) {
      logger.warn('registry', `Failed to load command file '${file}'`, { error: err.message });
    }
  }

  logger.info('registry', `Loaded ${loadedCommandsCount} commands, ${loadedAliasesCount} aliases across ${categoriesSet.size} categories`);
  return registryMap;
}

function getRegistry() {
  if (!registryMap) {
    throw new Error('Registry not loaded. Call loadCommands() first.');
  }
  return registryMap;
}

function get(name) {
  const reg = getRegistry();
  return reg.get(name);
}

function all() {
  const reg = getRegistry();
  const unique = new Set(reg.values());
  return Array.from(unique);
}

function categories() {
  const uniqueCmds = all();
  const catMap = new Map();

  for (const cmd of uniqueCmds) {
    const cat = cmd.category || 'general';
    if (!catMap.has(cat)) {
      catMap.set(cat, []);
    }
    catMap.get(cat).push(cmd);
  }
  return catMap;
}

function clear() {
  registryMap = null;
}

module.exports = {
  loadCommands,
  getRegistry,
  get,
  all,
  categories,
  clear
};
