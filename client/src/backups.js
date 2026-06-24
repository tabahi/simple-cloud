'use strict';

// Backup download/restore + clear, used by the tray (Windows) and the CLI
// (`node src/backups.js download|clear`) on Linux.
//
// Downloaded layout, inside the sync folder:
//   <syncFolder>/simplecloud-backups/<YYYY-MM-DD>/<original/relative/path>
// so each backup sits under the date it was taken, named by the file it is a
// prior version of. The simplecloud-backups/ folder is excluded from sync.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const api = require('./api');

// Folder (inside the sync folder) where backups are downloaded. Also excluded
// from syncing — see sync.js which imports this constant.
const BACKUPS_DIR_NAME = 'simplecloud-backups';

// Make a server-provided logical path safe to use as a relative path on disk:
// strip drive letters / leading slashes and drop any ".." segments so a
// malicious/garbled path can't escape the date directory.
function safeRelative(logicalPath) {
  let p = String(logicalPath || '').replace(/\\/g, '/');
  p = p.replace(/^[a-zA-Z]:/, '');        // strip Windows drive letter
  const parts = p.split('/').filter((s) => s && s !== '.' && s !== '..');
  return parts.length ? path.join(...parts) : 'unnamed.bk';
}

function backupsRoot(syncFolder) {
  return path.join(syncFolder, BACKUPS_DIR_NAME);
}

// Download every server backup into the sync folder:
//   overwrite-backups → <syncFolder>/simplecloud-backups/<date>/<path>
//   deleted files     → <syncFolder>/simplecloud-backups/deletions/<date>/<path>
// Returns { downloaded, failed, total, root }.
async function downloadAllBackups(syncFolder) {
  const groups = await api.fetchBackups();
  const root = backupsRoot(syncFolder);
  fs.mkdirSync(root, { recursive: true });

  let downloaded = 0;
  let failed = 0;
  let total = 0;

  for (const group of groups) {
    // Recycled deletions go under a "deletions/" subfolder; the group (or its
    // entries) carry a `deleted` flag set by the server.
    const isDeleted = group.deleted === true;
    for (const b of group.files) {
      total++;
      const base = isDeleted || b.deleted ? path.join(root, 'deletions') : root;
      const destAbs = path.join(base, group.date, safeRelative(b.logicalPath));
      try {
        await api.downloadBackup(b.id, destAbs);
        downloaded++;
        logger.info(`Backup downloaded: ${isDeleted ? 'deletions/' : ''}${group.date}/${b.logicalPath}`);
      } catch (e) {
        failed++;
        logger.error(`Backup download failed for ${b.id}: ${e.message}`);
      }
    }
  }

  logger.info(`Backups: downloaded ${downloaded}/${total} into ${root}`);
  return { downloaded, failed, total, root };
}

// Clear all backups: server-side first, then the local downloaded copy.
// Returns { serverRemovedDateDirs, localRemoved }.
async function clearAllBackups(syncFolder) {
  let serverRemovedDateDirs = 0;
  try {
    const res = await api.clearServerBackups();
    serverRemovedDateDirs = res.removedDateDirs || 0;
    logger.info(`Backups: cleared ${serverRemovedDateDirs} date-dir(s) on server`);
  } catch (e) {
    logger.error(`Failed to clear server backups: ${e.message}`);
    throw e;
  }

  let localRemoved = false;
  const root = backupsRoot(syncFolder);
  if (fs.existsSync(root)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      localRemoved = true;
      logger.info(`Backups: removed local ${root}`);
    } catch (e) {
      logger.error(`Failed to remove local backups folder: ${e.message}`);
    }
  }

  return { serverRemovedDateDirs, localRemoved };
}

module.exports = { downloadAllBackups, clearAllBackups, BACKUPS_DIR_NAME, backupsRoot };

// --- CLI entry (Linux / headless) ---------------------------------------------
// Usage: node src/backups.js download   |   node src/backups.js clear
if (require.main === module) {
  const { loadConfig } = require('./config');
  const cmd = (process.argv[2] || '').toLowerCase();

  (async () => {
    let config;
    try {
      config = loadConfig();
    } catch (e) {
      console.error(`Config error: ${e.message}`);
      process.exit(1);
    }
    api.setConfig(config);

    if (cmd === 'download') {
      const r = await downloadAllBackups(config.syncFolder);
      console.log(`Done: ${r.downloaded}/${r.total} backups downloaded into ${r.root}` +
        (r.failed ? ` (${r.failed} failed)` : ''));
    } else if (cmd === 'clear') {
      const r = await clearAllBackups(config.syncFolder);
      console.log(`Done: cleared ${r.serverRemovedDateDirs} server date-dir(s)` +
        (r.localRemoved ? ' and the local simplecloud-backups folder' : ''));
    } else {
      console.error('Usage: node src/backups.js download | clear');
      process.exit(1);
    }
    process.exit(0);
  })().catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}
