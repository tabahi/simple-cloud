'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { hashFile } = require('./hasher');
const api = require('./api');
const selfWrites = require('./selfWrites');
const uploadQueue = require('./uploadQueue');
const deleteQueue = require('./deleteQueue');
const { BACKUPS_DIR_NAME } = require('./backups');

// Downloaded backups live in <syncFolder>/simplecloud-backups/ and must never
// be synced back to the server. Matched as a top-level folder prefix.
const BACKUPS_PREFIX = BACKUPS_DIR_NAME + '/';
function isBackupsPath(rel) {
  const r = rel.replace(/\\/g, '/');
  return r === BACKUPS_DIR_NAME || r.startsWith(BACKUPS_PREFIX);
}

// --- .ignore file support ---

let _ignorePatterns = [];      // compiled patterns from <syncFolder>/.ignore
let _ignoreMtime = 0;          // mtime of the .ignore file last time we loaded it

// Convert a single .ignore glob pattern to a RegExp.
// Supports: * (any chars except /), ** (any chars including /), ? (one non-/ char),
// leading / (anchored to root), trailing / (directory match — treated as prefix).
function patternToRegExp(pattern) {
  // Strip leading slash — we'll anchor to start anyway when it was present
  const anchored = pattern.startsWith('/');
  let p = anchored ? pattern.slice(1) : pattern;

  // Trailing slash means "match this directory and everything inside"
  const dirMatch = p.endsWith('/');
  if (dirMatch) p = p.slice(0, -1);

  // Escape regex special chars except * and ?
  let re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&')
             .replace(/\*\*/g, '\x00')   // placeholder for **
             .replace(/\*/g, '[^/]*')    // * → any non-slash chars
             .replace(/\?/g, '[^/]')     // ? → one non-slash char
             .replace(/\x00/g, '.*');    // ** → anything

  if (anchored || p.includes('/')) {
    // Pattern is anchored to the root of the sync folder
    re = '^' + re;
  } else {
    // Unanchored — match anywhere in the path (any path segment or suffix)
    re = '(^|/)' + re;
  }

  if (dirMatch) {
    re = re + '(/|$)';
  } else {
    re = re + '$';
  }

  return new RegExp(re);
}

function loadIgnorePatterns() {
  const ignoreFile = path.join(_config.syncFolder, '.ignore');
  let mtime = 0;
  try {
    mtime = fs.statSync(ignoreFile).mtimeMs;
  } catch (_) {
    // No .ignore file — clear patterns if we previously had some
    if (_ignorePatterns.length) {
      logger.info('.ignore file removed, clearing ignore patterns');
      _ignorePatterns = [];
      _ignoreMtime = 0;
    }
    return;
  }

  if (mtime === _ignoreMtime) return; // unchanged

  try {
    const lines = fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/);
    _ignorePatterns = lines
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(patternToRegExp);
    _ignoreMtime = mtime;
    logger.info(`.ignore loaded: ${_ignorePatterns.length} pattern(s) from ${ignoreFile}`);
  } catch (e) {
    logger.warn(`Could not read .ignore file: ${e.message}`);
  }
}

function matchesIgnorePatterns(rel) {
  return _ignorePatterns.some(re => re.test(rel));
}

// --- secure locked-folder support ---
// Files under the locked prefix are managed by the server's lock/unlock
// (Discord) commands. When the server locks them they vanish from the manifest;
// this client must then DELETE its local copies without recording them in
// deleted.json (so a later unlock re-downloads them cleanly) and must never
// re-upload them as if they were brand-new local files.
//
// The SERVER is the ONLY source of truth for the folder name: /api/lock-status
// returns its `prefix`, which we cache below. There is no client-side setting —
// until the server has reported a prefix at least once, the client treats no
// path as "locked" and skips all secure-folder logic. This makes a
// client/server name mismatch impossible.

let _serverLockedPrefix = null; // e.g. ".simplecloud_locked/" — set from lock-status

function normalizePrefix(name) {
  return name.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
}

// The locked prefix, or null if the server hasn't reported it yet.
function lockedPrefix() {
  return _serverLockedPrefix;
}

function isLockedPath(rel) {
  if (!_serverLockedPrefix) return false; // unknown until server responds
  return rel.replace(/\\/g, '/').startsWith(lockedPrefix());
}

// Returns 'ignore' | 'lazy' | null
// 'ignore' — file must be skipped entirely
// 'lazy'   — file should only sync via the polling loop, not real-time watcher
// null     — file is fine to sync normally
function shouldIgnoreFile(rel, sizeBytes) {
  // Downloaded backups are never synced.
  if (isBackupsPath(rel)) {
    return 'ignore';
  }

  if (_ignorePatterns.length && matchesIgnorePatterns(rel)) {
    return 'ignore';
  }

  if (sizeBytes !== undefined) {
    const cfg = _config;
    const sizeMb = sizeBytes / (1024 * 1024);
    if (cfg.largeFileIgnoreMb > 0 && sizeMb >= cfg.largeFileIgnoreMb) {
      return 'ignore';
    }
    if (cfg.largeFileLazySyncMb > 0 && sizeMb >= cfg.largeFileLazySyncMb) {
      return 'lazy';
    }
  }

  return null;
}

let _config = null;
let _trayCallbacks = null; // { setStatus, setLastSynced }

// deleted.json tracks files this client deleted, so server-deletions of those aren't re-downloaded
let deletedSet = new Set();
let deletedFilePath = null;

function init(config, trayCallbacks) {
  _config = config;
  _trayCallbacks = trayCallbacks;
  deletedFilePath = path.join(
    require('os').homedir(),
    'AppData', 'Roaming', 'simplecloud', 'deleted.json'
  );
  loadDeletedSet();

  // Reflect the upload queue's rate-limit backoff in the tray status.
  uploadQueue.onPauseChange((paused) => {
    if (!_trayCallbacks) return;
    if (paused) {
      _trayCallbacks.setStatus('Paused (rate-limited)');
    } else {
      // Resuming — show activity if files remain queued, otherwise idle.
      _trayCallbacks.setStatus(uploadQueue.pendingCount() > 0 ? 'Syncing...' : 'Idle');
    }
  });

  // When the upload queue fully drains, return the tray to Idle.
  uploadQueue.onDrain(() => {
    if (_trayCallbacks && !deleteQueue.isPaused()) _trayCallbacks.setStatus('Idle');
  });

  // The delete queue's rate-limit backoff mirrors the upload queue.
  deleteQueue.onPauseChange((paused) => {
    if (!_trayCallbacks) return;
    if (paused) {
      _trayCallbacks.setStatus('Paused (rate-limited)');
    } else {
      _trayCallbacks.setStatus(deleteQueue.pendingCount() > 0 ? 'Syncing...' : 'Idle');
    }
  });
  deleteQueue.onDrain(() => {
    if (_trayCallbacks && !uploadQueue.isPaused()) _trayCallbacks.setStatus('Idle');
  });
}

// Set a transient tray status (Syncing/Idle). Suppressed while either queue is
// in its rate-limit backoff so a completing op's "Idle" doesn't clobber the
// "Paused (rate-limited)" indicator.
function setTrayStatus(status) {
  if (!_trayCallbacks) return;
  if (uploadQueue.isPaused() || deleteQueue.isPaused()) return;
  _trayCallbacks.setStatus(status);
}

function loadDeletedSet() {
  try {
    if (fs.existsSync(deletedFilePath)) {
      const arr = JSON.parse(fs.readFileSync(deletedFilePath, 'utf8'));
      deletedSet = new Set(Array.isArray(arr) ? arr : []);
    }
  } catch (e) {
    logger.warn(`Could not load deleted.json: ${e.message}`);
    deletedSet = new Set();
  }
}

function saveDeletedSet() {
  fs.writeFileSync(deletedFilePath, JSON.stringify([...deletedSet]), 'utf8');
}

function markDeleted(relativePath) {
  deletedSet.add(relativePath);
  saveDeletedSet();
}

function unmarkDeleted(relativePath) {
  deletedSet.delete(relativePath);
  saveDeletedSet();
}

// Walk the sync folder and return a Map of relativePath → { hash, size, mtime }
async function buildLocalManifest() {
  const syncFolder = _config.syncFolder;
  const result = new Map();

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      logger.warn(`Cannot read dir ${dir}: ${e.message}`);
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const relDir = path.relative(syncFolder, abs).replace(/\\/g, '/') + '/';
        if (isBackupsPath(relDir)) continue; // never descend into downloaded backups
        if (_ignorePatterns.length && matchesIgnorePatterns(relDir)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        const rel = path.relative(syncFolder, abs).replace(/\\/g, '/');
        if (shouldIgnoreFile(rel, undefined) === 'ignore') continue;
        result.set(rel, abs);
      }
    }
  }

  walk(syncFolder);

  // Hash all local files (in series to avoid overwhelming the disk)
  const manifest = new Map();
  for (const [rel, abs] of result) {
    try {
      const stat = fs.statSync(abs);
      if (shouldIgnoreFile(rel, stat.size) === 'ignore') continue;
      const hash = await hashFile(abs);
      manifest.set(rel, { hash, size: stat.size, mtime: stat.mtimeMs, abs });
    } catch (e) {
      // File locked or vanished — skip this cycle
      logger.warn(`Skipping locked/unavailable file ${rel}: ${e.message}`);
    }
  }
  return manifest;
}

// Remove the local secure folder (and any empty subdirs) when it has no files
// left — i.e. after a lock removed them. Only deletes empty directories, so an
// unlocked/in-use folder with files is never touched.
function pruneEmptyLockedFolder() {
  const prefix = lockedPrefix();
  if (!prefix) return; // server prefix not known yet
  const root = path.join(
    _config.syncFolder,
    prefix.replace(/\/$/, '').replace(/\//g, path.sep)
  );
  if (!fs.existsSync(root)) return;

  const removeIfEmpty = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) removeIfEmpty(path.join(dir, entry.name));
    }
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        return true;
      }
    } catch (_) {
      /* not empty or vanished — leave it */
    }
    return false;
  };

  if (removeIfEmpty(root)) {
    logger.info(`Locked: removed empty secure folder ${lockedPrefix()}`);
  }
}

// Grace period after a local upload during which we will NOT download the same
// file from the server. The server's modified_at reflects receive time (always
// slightly after the local save time), so without this guard, every upload is
// immediately followed by a spurious download that overwrites active edits.
const UPLOAD_GRACE_MS = 60_000;
// rel → timestamp of last uploadSafe/syncSingleFile enqueue for that path
const _recentUploads = new Map();

let syncPaused = false;
let authErrorPaused = false;
let _isSyncing = false;
let _syncPending = false;

// Last-known secure-folder lock state from the most recent runSync(). The
// watcher consults this to tell a lock-induced deletion (don't propagate) from
// a genuine user deletion in an unlocked folder (propagate normally).
let _secureFolderLocked = false;

function setPaused(val) { syncPaused = val; }
function isPaused() { return syncPaused; }

// Main sync routine — bidirectional diff + conflict resolution
async function runSync() {
  if (syncPaused || authErrorPaused) return;
  if (_isSyncing) { _syncPending = true; return; }
  _isSyncing = true;
  _syncPending = false;

  loadIgnorePatterns();

  setTrayStatus('Syncing...');
  logger.info('Sync started');

  try {
    // Fetch manifest and build local manifest in parallel (local walk has no
    // network cost), then fetch deletions and lock-status serially to keep the
    // peak connection count at 1 active HTTP request at a time.
    const [serverManifest, localManifest] = await Promise.all([
      api.fetchManifest(),
      buildLocalManifest(),
    ]);
    const serverDeleted = await api.fetchDeletions();
    const lockState = await api.fetchLockStatus();

    // The server is authoritative for the locked-folder name. Adopt the prefix
    // it reports so the client always agrees with the server (no mismatch).
    if (lockState && lockState.prefix) {
      _serverLockedPrefix = normalizePrefix(lockState.prefix);
    }

    // Only when the server reports the secure folder is LOCKED do we remove
    // local plaintext copies. On first run / unlocked state this is false, so
    // new secret files upload normally instead of being deleted.
    const secureFolderLocked = lockState && lockState.locked === true;
    _secureFolderLocked = secureFolderLocked; // cache for the watcher

    // Index server manifest by path
    const serverMap = new Map(serverManifest.map(f => [f.path, f]));

    // When the secure folder is unlocked AND the server holds nothing under the
    // prefix (nothing locked), make sure the folder exists locally so the user
    // has a place to drop files to lock. Only create when empty/unlocked — never
    // recreate it while locked (it's meant to disappear then). Requires the
    // server to have reported its prefix (no guessing).
    const prefix = lockedPrefix();
    if (prefix && !secureFolderLocked) {
      const serverHasLockedFiles = serverManifest.some(f => f.path.startsWith(prefix));
      if (!serverHasLockedFiles) {
        const lockedDirAbs = path.join(
          _config.syncFolder,
          prefix.replace(/\/$/, '').replace(/\//g, path.sep)
        );
        try {
          if (!fs.existsSync(lockedDirAbs)) {
            fs.mkdirSync(lockedDirAbs, { recursive: true });
            logger.info(`Created secure folder: ${prefix}`);
          }
        } catch (e) {
          logger.warn(`Could not create secure folder ${prefix}: ${e.message}`);
        }
      }
    }

    // Apply server-side deletions: if a peer deleted a file and we still have it locally,
    // delete it locally so the deletion propagates to all clients.
    for (const rel of serverDeleted) {
      if (localManifest.has(rel) && !serverMap.has(rel)) {
        const localAbs = path.join(_config.syncFolder, rel.replace(/\//g, path.sep));
        try {
          selfWrites.mark(rel); // suppress the watcher unlink we're about to cause
          fs.unlinkSync(localAbs);
          markDeleted(rel);
          logger.info(`Deleted locally (propagated from server): ${rel}`);
        } catch (e) {
          logger.warn(`Could not delete local file ${rel}: ${e.message}`);
        }
        localManifest.delete(rel);
      }
    }

    // --- UPLOAD phase ---
    // Local files that are new or locally-modified-and-newer than server version
    for (const [rel, local] of localManifest) {
      const server = serverMap.get(rel);

      if (!server) {
        if (secureFolderLocked && isLockedPath(rel)) {
          // The server reports the secure folder is LOCKED. Remove our local
          // plaintext copy WITHOUT recording it as a deletion (unlock must be
          // able to re-download it). Never re-upload.
          try {
            selfWrites.mark(rel); // suppress the watcher unlink we're about to cause
            fs.unlinkSync(local.abs);
            logger.info(`Locked: removed local secure file ${rel}`);
          } catch (e) {
            logger.warn(`Could not remove locked file ${rel}: ${e.message}`);
          }
          localManifest.delete(rel);
          continue;
        }
        if (serverDeleted.has(rel)) {
          // Server deleted this file (peer deletion) — don't re-upload
          continue;
        }
        // File exists locally but not on server → upload
        // (includes new files in the secure folder while it is unlocked).
        uploadSafe(rel, local.abs);
      } else if (local.hash !== server.hash) {
        // Hash mismatch → compare modification times to resolve conflict
        const serverMtime = new Date(server.modified_at).getTime();
        if (local.mtime >= serverMtime) {
          // Local is same-age or newer → local wins, upload
          uploadSafe(rel, local.abs);
        }
        // else server is newer → download handled in download phase
      }
    }

    // After processing locked-folder removals, prune the now-empty secure
    // folder so it visually "disappears" while locked. Only when locked — never
    // touch the folder during normal (unlocked) use.
    if (secureFolderLocked) pruneEmptyLockedFolder();

    // --- DELETE propagation phase ---
    // Files tracked in deletedSet that still exist on server → delete from server
    for (const rel of [...deletedSet]) {
      if (secureFolderLocked && isLockedPath(rel)) {
        // While LOCKED, secure-folder files are governed by the server's
        // lock/unlock — not by client-side delete propagation. Drop any stray
        // tracking entry. While unlocked, deletions propagate normally below.
        deletedSet.delete(rel);
        continue;
      }
      if (serverMap.has(rel) && !localManifest.has(rel)) {
        // Queue (batched, rate-limit-aware) rather than deleting inline.
        deleteQueue.enqueue(rel);
      } else if (!serverMap.has(rel)) {
        // Already gone from server — clean up our tracking
        deletedSet.delete(rel);
      }
    }
    saveDeletedSet();

    // --- DOWNLOAD phase ---
    // Server files missing locally or server-newer than local
    for (const [rel, server] of serverMap) {
      const local = localManifest.get(rel);
      const localAbs = path.join(_config.syncFolder, rel.replace(/\//g, path.sep));

      if (!local) {
        if (deletedSet.has(rel)) {
          // We deleted this — already handled above; skip re-download
          continue;
        }
        if (uploadQueue.hasPending(rel) || deleteQueue.hasPending(rel)) {
          // A client operation for this file is still in flight; the next sync
          // cycle (after SSE confirms the op) will resolve the final state.
          continue;
        }
        // File is on server but not local (and we didn't delete it) → download
        await downloadSafe(rel, localAbs);
        unmarkDeleted(rel);
      } else if (local.hash !== server.hash) {
        const serverMtime = new Date(server.modified_at).getTime();
        if (serverMtime > local.mtime) {
          if (uploadQueue.hasPending(rel) || deleteQueue.hasPending(rel)) {
            // Our pending op will produce the authoritative version — don't overwrite it.
            continue;
          }
          const lastUpload = _recentUploads.get(rel);
          if (lastUpload && Date.now() - lastUpload < UPLOAD_GRACE_MS) {
            // We uploaded this file recently; the server's newer timestamp is
            // upload-receive lag, not a change from another client. Skip to
            // avoid overwriting an actively-edited file.
            continue;
          }
          // Server version is strictly newer → download
          await downloadSafe(rel, localAbs);
        }
      }
    }

    const now = new Date().toLocaleString();
    _trayCallbacks && _trayCallbacks.setLastSynced(now);
    setTrayStatus('Idle');
    logger.info('Sync completed');
  } catch (err) {
    if (err.code === 'AUTH') {
      logger.error(`Authentication error: ${err.message}`);
      authErrorPaused = true;
      _trayCallbacks && _trayCallbacks.setStatus('Error: bad token');
    } else {
      logger.error(`Sync error: ${err.message}`);
      _trayCallbacks && _trayCallbacks.setStatus('Error');
    }
  } finally {
    _isSyncing = false;
    if (_syncPending) {
      _syncPending = false;
      setImmediate(() => runSync().catch(err => logger.error(`Deferred sync error: ${err.message}`)));
    }
  }
}

// Enqueue an upload on the shared serial queue. Returns immediately; the queue
// processes files one at a time and backs off 30s on rate-limit.
// Any pending delete for this file is cancelled — uploading supersedes deleting.
function uploadSafe(rel, abs) {
  deleteQueue.cancel(rel);  // stale pending delete would clobber this upload
  unmarkDeleted(rel);       // file is being (re)created; treat as present now
  _recentUploads.set(rel, Date.now());
  uploadQueue.enqueue(rel, abs, (ok) => {
    if (ok) unmarkDeleted(rel); // idempotent — keeps the success path explicit
  });
}

async function downloadSafe(rel, localAbs) {
  try {
    // Mark before writing so the watcher ignores the add/change event this
    // download triggers (prevents re-uploading what we just downloaded).
    selfWrites.mark(rel);
    await api.downloadFile(rel, localAbs);
    // Re-mark after the write completes to keep the suppression window fresh,
    // since chokidar's awaitWriteFinish can delay the event well past the start.
    selfWrites.mark(rel);
  } catch (e) {
    logger.error(`Download failed for ${rel}: ${e.message}`);
  }
}

// Called by watcher when a file is added/changed
async function syncSingleFile(localAbs) {
  if (syncPaused || authErrorPaused) return;
  const rel = path.relative(_config.syncFolder, localAbs).replace(/\\/g, '/');

  loadIgnorePatterns();

  // Check filters before stat so pattern ignores don't need a syscall
  const earlyFilter = shouldIgnoreFile(rel, undefined);
  if (earlyFilter === 'ignore') return;

  let sizeBytes;
  try {
    sizeBytes = fs.statSync(localAbs).size;
  } catch (_) {
    // File may have vanished; let the upload attempt surface the real error
  }
  if (sizeBytes !== undefined) {
    const sizeFilter = shouldIgnoreFile(rel, sizeBytes);
    if (sizeFilter === 'ignore') return;
    if (sizeFilter === 'lazy') {
      logger.debug(`Skipping real-time upload for large file (will sync at next poll): ${rel}`);
      return;
    }
  }

  logger.info(`Immediate sync triggered for: ${rel}`);
  setTrayStatus('Syncing...');
  // Drop any pending delete so it doesn't clobber the upload that follows.
  deleteQueue.cancel(rel);
  unmarkDeleted(rel); // file is being (re)created; treat as present immediately
  _recentUploads.set(rel, Date.now());
  // Route through the shared serial queue so watcher uploads never run
  // concurrently with sync-loop uploads and the rate-limit backoff applies.
  uploadQueue.enqueue(rel, localAbs, (ok) => {
    if (ok) unmarkDeleted(rel); // idempotent
    setTrayStatus('Idle');
  });
}

// Called by watcher when a file is removed
async function syncFileDeletion(localAbs) {
  if (syncPaused || authErrorPaused) return;
  const rel = path.relative(_config.syncFolder, localAbs).replace(/\\/g, '/');
  loadIgnorePatterns();
  if (shouldIgnoreFile(rel, undefined) === 'ignore') return;
  if (_secureFolderLocked && isLockedPath(rel)) {
    // While LOCKED, secure-folder removals are driven by the server's
    // lock/unlock (these unlink events are the lock itself emptying the folder).
    // Don't propagate them — that would delete the server copy and block a later
    // unlock from restoring the file. While unlocked, deletions propagate below.
    logger.debug(`Ignoring watcher deletion for locked secure path: ${rel}`);
    return;
  }
  logger.info(`Deletion detected, queuing for server: ${rel}`);
  markDeleted(rel);
  // Batched + rate-limit-aware. Deleting a whole folder fires many unlinks;
  // the queue collects them (5s quiet window) and sends one bulk request.
  deleteQueue.enqueue(rel);
  // No point uploading a file the user just deleted.
  uploadQueue.cancel(rel);
}

module.exports = {
  init,
  runSync,
  syncSingleFile,
  syncFileDeletion,
  setPaused,
  isPaused,
  shouldIgnoreFile,
};
