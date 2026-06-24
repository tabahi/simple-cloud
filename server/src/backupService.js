'use strict';

// Backup browsing/restore support.
//
// Backups live under tempDir as: <tempDir>/<YYYY-MM-DD>/<storageId>.<YYYY-MM-DD>.bk
// (written by storage.js#backupBlob before a blob is overwritten). The filename
// is a UUID, so on its own it doesn't say which logical file it is a prior
// version of. We resolve the storageId back to a logical path using:
//   1. the DB (the path that currently owns that storage_id), else
//   2. the change log (the most recent upload/replace entry for that storageId).
// If neither resolves, we fall back to the raw `<storageId>.bk` name.

const fs = require('fs');
const path = require('path');

const { tempDir, filechangeLogs, logDir, lockedZip } = require('./config');
const { getDb } = require('./db');
const { DELETIONS_DIR } = require('./storage');

const CHANGES_LOG = filechangeLogs || path.join(logDir, 'changes.log');
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const BACKUP_FILE_RE = /^(.+)\.(\d{4}-\d{2}-\d{2})\.bk$/; // <storageId>.<date>.bk
const DELETIONS_ROOT = path.join(tempDir, DELETIONS_DIR); // <tempDir>/deletions

// Build a storageId → logical path map from the DB (current owners).
function dbPathsByStorageId() {
  const map = new Map();
  try {
    const rows = getDb().prepare('SELECT path, storage_id FROM files').all();
    for (const r of rows) map.set(r.storage_id, r.path);
  } catch (_) {
    /* DB not ready — fall back to changelog only */
  }
  return map;
}

// Build a storageId → logical path map from the change log (last write wins).
function changelogPathsByStorageId() {
  const map = new Map();
  if (!fs.existsSync(CHANGES_LOG)) return map;
  let content;
  try {
    content = fs.readFileSync(CHANGES_LOG, 'utf8');
  } catch (_) {
    return map;
  }
  for (const line of content.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if ((e.action === 'upload' || e.action === 'replace') && e.storageId && e.path) {
      map.set(e.storageId, e.path); // later lines overwrite → most recent path
    }
  }
  return map;
}

// Resolve the logical path for a storageId; falls back to "<storageId>.bk".
function resolveLogicalName(storageId, dbMap, clMap) {
  return dbMap.get(storageId) || clMap.get(storageId) || `${storageId}.bk`;
}

// Recursively list files under a directory, returning paths relative to it
// (forward-slash form).
function walkRel(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      for (const sub of walkRel(abs)) out.push(`${e.name}/${sub}`);
    } else if (e.isFile()) {
      out.push(e.name);
    }
  }
  return out;
}

// List recycled deletions, grouped by date. Each entry is a deleted file stored
// by its logical path under <tempDir>/deletions/<date>/. The `id` is
// "deletions/<date>/<path>" and `deleted: true` marks it for the client.
function listDeletions() {
  const result = [];
  if (!fs.existsSync(DELETIONS_ROOT)) return result;

  let dateDirs;
  try {
    dateDirs = fs.readdirSync(DELETIONS_ROOT, { withFileTypes: true });
  } catch (_) {
    return result;
  }

  for (const d of dateDirs) {
    if (!d.isDirectory() || !DATE_DIR_RE.test(d.name)) continue;
    const dirAbs = path.join(DELETIONS_ROOT, d.name);
    const rels = walkRel(dirAbs);
    const entries = [];
    for (const rel of rels) {
      let size = 0;
      try { size = fs.statSync(path.join(dirAbs, rel)).size; } catch (_) { /* gone */ }
      entries.push({
        id: `${DELETIONS_DIR}/${d.name}/${rel}`,
        date: d.name,
        size,
        logicalPath: rel,
        deleted: true,
      });
    }
    if (entries.length) {
      entries.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
      result.push({ date: d.name, deleted: true, files: entries });
    }
  }

  result.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

// List all backups (overwrite-backups + recycled deletions), grouped by date.
// Returns: [{ date, deleted?, files: [{ id, date, size, logicalPath, ... }] }]
function listBackups() {
  const result = [];
  if (!fs.existsSync(tempDir)) return result.concat(listDeletions());

  const dbMap = dbPathsByStorageId();
  const clMap = changelogPathsByStorageId();

  let dateDirs;
  try {
    dateDirs = fs.readdirSync(tempDir, { withFileTypes: true });
  } catch (_) {
    return result.concat(listDeletions());
  }

  for (const d of dateDirs) {
    if (!d.isDirectory() || !DATE_DIR_RE.test(d.name)) continue; // skips "deletions"
    const dirAbs = path.join(tempDir, d.name);
    let files;
    try {
      files = fs.readdirSync(dirAbs);
    } catch (_) {
      continue;
    }

    const entries = [];
    for (const f of files) {
      const m = BACKUP_FILE_RE.exec(f);
      if (!m) continue;
      const storageId = m[1];
      const date = m[2];
      let size = 0;
      try { size = fs.statSync(path.join(dirAbs, f)).size; } catch (_) { /* gone */ }
      entries.push({
        id: `${d.name}/${f}`, // opaque handle the client passes back to download
        storageId,
        date,
        size,
        logicalPath: resolveLogicalName(storageId, dbMap, clMap),
      });
    }
    if (entries.length) {
      entries.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
      result.push({ date: d.name, files: entries });
    }
  }

  // Append recycled deletions as their own dated groups (marked deleted:true).
  for (const g of listDeletions()) result.push(g);

  result.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

// Resolve an opaque backup id to an absolute path, or null if malformed /
// traversing outside tempDir. Two id shapes are accepted:
//   - overwrite backup:  "<date>/<storageId>.<date>.bk"
//   - recycled deletion: "deletions/<date>/<nested/logical/path>"
function resolveBackupPath(id) {
  if (typeof id !== 'string' || !id) return null;

  let abs;
  if (id.startsWith(`${DELETIONS_DIR}/`)) {
    const rest = id.slice(DELETIONS_DIR.length + 1);
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    const dateDir = rest.slice(0, slash);
    const relPath = rest.slice(slash + 1);
    if (!DATE_DIR_RE.test(dateDir)) return null;
    if (!relPath || relPath.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
    abs = path.join(DELETIONS_ROOT, dateDir, relPath.replace(/\//g, path.sep));
  } else {
    const parts = id.split('/');
    if (parts.length !== 2) return null;
    const [dateDir, fileName] = parts;
    if (!DATE_DIR_RE.test(dateDir)) return null;
    if (!BACKUP_FILE_RE.test(fileName)) return null;
    abs = path.join(tempDir, dateDir, fileName);
  }

  // Guard against path traversal: the resolved path must stay under tempDir.
  const rel = path.relative(tempDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

function getBackupStream(id) {
  const abs = resolveBackupPath(id);
  if (!abs) return null;
  return fs.createReadStream(abs);
}

// Return the basename of the logical file for use in Content-Disposition.
function resolveLogicalFilename(id) {
  if (typeof id !== 'string' || !id) return 'download';
  if (id.startsWith(`${DELETIONS_DIR}/`)) {
    const rest = id.slice(DELETIONS_DIR.length + 1);
    const slash = rest.indexOf('/');
    if (slash === -1) return 'download';
    return path.basename(rest.slice(slash + 1)) || 'download';
  }
  const parts = id.split('/');
  if (parts.length !== 2) return 'download';
  const m = BACKUP_FILE_RE.exec(parts[1]);
  if (!m) return 'download';
  const logicalPath = resolveLogicalName(m[1], dbPathsByStorageId(), changelogPathsByStorageId());
  return path.basename(logicalPath);
}

// Delete every backup date-dir under tempDir. Returns the count removed.
// Does NOT touch the locked archive or live storage.
function clearAllBackups(log) {
  let removed = 0;
  if (!fs.existsSync(tempDir)) return removed;

  let entries;
  try {
    entries = fs.readdirSync(tempDir, { withFileTypes: true });
  } catch (e) {
    log && log.error({ err: e.message }, 'clearAllBackups: cannot read tempDir');
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !DATE_DIR_RE.test(entry.name)) continue;
    const full = path.join(tempDir, entry.name);
    // Never delete the locked archive even if it somehow lived here.
    if (lockedZip && path.resolve(full) === path.resolve(lockedZip)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch (e) {
      log && log.error({ dir: full, err: e.message }, 'clearAllBackups: failed to remove');
    }
  }

  // Also wipe the recycle bin (deleted files).
  if (fs.existsSync(DELETIONS_ROOT)) {
    try {
      let delDates;
      try {
        delDates = fs.readdirSync(DELETIONS_ROOT, { withFileTypes: true });
      } catch (_) {
        delDates = [];
      }
      for (const d of delDates) {
        if (d.isDirectory() && DATE_DIR_RE.test(d.name)) removed++;
      }
      fs.rmSync(DELETIONS_ROOT, { recursive: true, force: true });
    } catch (e) {
      log && log.error({ dir: DELETIONS_ROOT, err: e.message }, 'clearAllBackups: failed to remove deletions');
    }
  }
  return removed;
}

module.exports = { listBackups, getBackupStream, clearAllBackups, resolveBackupPath, resolveLogicalFilename };
