'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { loadConfig } = require('./config');
const api = require('./api');
const pkg = require('../package.json');
const sync = require('./sync');
const { startWatcher } = require('./watcher');
const { startTray } = require('./tray');

// Returns true when version >= minVersion (simple numeric semver comparison).
function semverGte(version, minVersion) {
  const v = version.split('.').map(Number);
  const m = minVersion.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((v[i] || 0) > (m[i] || 0)) return true;
    if ((v[i] || 0) < (m[i] || 0)) return false;
  }
  return true;
}

// Uncaught exception safety net — log and keep running rather than crashing the service
process.on('uncaughtException', err => {
  logger.error(`Uncaught exception: ${err.stack || err.message}`);
});
process.on('unhandledRejection', reason => {
  const msg = reason instanceof Error ? reason.stack : String(reason);
  logger.error(`Unhandled rejection: ${msg}`);
});

async function main() {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
  }

  const logLevel = config.logLevel || 'info';
  logger.transports.forEach(t => { t.level = logLevel; });
  logger.info('simplecloudClient starting');
  logger.info(`Sync folder: ${config.syncFolder}`);
  logger.info(`Server: ${config.serverUrl}`);
  logger.info(`Sync interval: ${config.syncIntervalSeconds}s`);

  // Ensure sync folder exists
  fs.mkdirSync(config.syncFolder, { recursive: true });

  // Wire up API with config
  api.setConfig(config);

  // Compatibility check — fetch server's minimum required client version and
  // exit early if this client is too old, before touching any sync state.
  try {
    const health = await api.fetchHealth();
    if (health.minClientVersion && !semverGte(pkg.version, health.minClientVersion)) {
      logger.error(
        `Client version ${pkg.version} is below the server's minimum required version ` +
        `${health.minClientVersion}. Please update the client.`
      );
      process.exit(1);
    }
  } catch (err) {
    logger.warn(`Health check failed (skipping compatibility check): ${err.message}`);
  }

  // Start tray icon — returns { setStatus, setLastSynced } callbacks
  const trayCallbacks = await startTray(config);

  // Wire sync module
  sync.init(config, trayCallbacks);

  // Start file watcher for real-time uploads
  startWatcher(config.syncFolder);

  // Run first sync immediately on startup
  await sync.runSync().catch(err => logger.error(`Initial sync failed: ${err.message}`));

  // SSE listener — triggers an immediate sync whenever the server pushes a
  // change notification, so clients react within ~1s instead of waiting for
  // the next poll cycle. Reconnects with exponential backoff on disconnect.
  let reconnectDelay = 2000;
  function connectSSE() {
    api.connectEventStream(
      (_event) => {
        reconnectDelay = 2000;
        logger.info('SSE: change notification received — triggering sync');
        sync.runSync().catch(err => logger.error(`Event sync error: ${err.message}`));
      },
      (err) => {
        if (err.code === 'AUTH') {
          logger.error(`SSE auth failed: ${err.message}`);
          return; // don't retry on bad token
        }
        logger.warn(`SSE: ${err.message} — reconnecting in ${reconnectDelay}ms`);
        setTimeout(connectSSE, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
      }
    );
  }
  connectSSE();

  // Fallback poll — safety net if SSE is between reconnects or misses an event
  setInterval(() => {
    sync.runSync().catch(err => logger.error(`Sync interval error: ${err.message}`));
  }, config.syncIntervalSeconds * 1000);

  logger.info('simplecloudClient running');
}

main();
