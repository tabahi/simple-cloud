'use strict';

const fs = require('fs');
const path = require('path');
const { tempDir, backupRetentionDays } = require('./config');
const { DELETIONS_DIR } = require('./storage');

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

// Remove date-named (YYYY-MM-DD) subdirectories of `dir` older than `cutoff`.
function purgeDateDirsIn(dir, cutoff, log) {
  if (!fs.existsSync(dir)) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    log.error({ dir, err: e.message }, 'cleanup: cannot read dir');
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !DATE_DIR_RE.test(entry.name)) continue;

    const dirDate = new Date(entry.name);
    if (isNaN(dirDate.getTime())) continue;

    if (dirDate < cutoff) {
      const fullPath = path.join(dir, entry.name);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        log.info({ action: 'cleanup', dir: fullPath }, 'purged old backup directory');
      } catch (e) {
        log.error({ action: 'cleanup', dir: fullPath, err: e.message }, 'cleanup failed');
      }
    }
  }
}

// Delete expired overwrite-backups (tempDir/<date>/) AND recycled deletions
// (tempDir/deletions/<date>/) older than backupRetentionDays.
function purgeOldBackups(log) {
  if (!fs.existsSync(tempDir)) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - backupRetentionDays);

  purgeDateDirsIn(tempDir, cutoff, log);
  purgeDateDirsIn(path.join(tempDir, DELETIONS_DIR), cutoff, log);
}

// Schedule daily cleanup. Runs once immediately on startup, then every 24 hours.
function scheduleCleanup(log) {
  const run = () => {
    log.info('Running backup cleanup');
    purgeOldBackups(log);
  };

  run();
  setInterval(run, 24 * 60 * 60 * 1000);
}

module.exports = { scheduleCleanup, purgeOldBackups };
