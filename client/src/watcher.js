'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const logger = require('./logger');
const sync = require('./sync');
const selfWrites = require('./selfWrites');

// Debounce map: relativePath → timeout handle
// 3 s quiet window before uploading — prevents flooding during active editing sessions
// where files are saved every few seconds. The upload queue deduplicates further.
const debounceMap = new Map();
const DEBOUNCE_MS = 3000;

function debounce(key, fn) {
  if (debounceMap.has(key)) clearTimeout(debounceMap.get(key));
  debounceMap.set(key, setTimeout(() => {
    debounceMap.delete(key);
    fn();
  }, DEBOUNCE_MS));
}

function startWatcher(syncFolder) {
  const { BACKUPS_DIR_NAME } = require('./backups');
  const backupsRoot = path.join(syncFolder, BACKUPS_DIR_NAME);

  const watcher = chokidar.watch(syncFolder, {
    // Ignore dotfiles and the downloaded-backups folder entirely.
    ignored: (p) => /(^|[/\\])\../.test(p) || p === backupsRoot || p.startsWith(backupsRoot + path.sep),
    persistent: true,
    ignoreInitial: true,    // don't re-upload everything on startup
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  function shouldSkipWatcherEvent(filePath) {
    const rel = path.relative(syncFolder, filePath).replace(/\\/g, '/');
    if (sync.shouldIgnoreFile(rel, undefined) === 'ignore') return true;
    // Ignore events caused by the sync engine's own writes/deletes (e.g. a file
    // we just downloaded) so we don't re-upload what we just received.
    if (selfWrites.consume(rel)) {
      logger.debug(`Watcher: ignoring self-written ${rel}`);
      return true;
    }
    return false;
  }

  watcher.on('add', filePath => {
    logger.debug(`Watcher: add ${filePath}`);
    if (shouldSkipWatcherEvent(filePath)) return;
    debounce(filePath, () => sync.syncSingleFile(filePath).catch(e =>
      logger.error(`Watcher upload error: ${e.message}`)
    ));
  });

  watcher.on('change', filePath => {
    logger.debug(`Watcher: change ${filePath}`);
    if (shouldSkipWatcherEvent(filePath)) return;
    debounce(filePath, () => sync.syncSingleFile(filePath).catch(e =>
      logger.error(`Watcher upload error: ${e.message}`)
    ));
  });

  watcher.on('unlink', filePath => {
    if (shouldSkipWatcherEvent(filePath)) return;
    logger.debug(`Watcher: unlink ${filePath}`);
    sync.syncFileDeletion(filePath).catch(e =>
      logger.error(`Watcher delete error: ${e.message}`)
    );
  });

  watcher.on('error', err => {
    logger.error(`Watcher error: ${err.message}`);
  });

  logger.info(`Watching ${syncFolder} for changes`);
  return watcher;
}

module.exports = { startWatcher };
