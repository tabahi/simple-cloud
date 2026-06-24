'use strict';

// Secure locked-folder feature.
//
// Files under the `lockedFolderName/` path prefix can be encrypted into a 7z
// archive (`lockedZip`) protected by a password supplied via Discord. The
// password is NEVER persisted — it lives only as an argument to the 7z child
// process for the duration of a single lock/unlock call.
//
// lock(password):
//   1. Collect every manifest entry under `lockedFolderName/`.
//   2. Stage their blobs into a temp dir under their real relative paths.
//   3. 7z them into `lockedZip` with -p<password> -mhe=on (header encryption).
//   4. On success, delete those rows from the DB and remove the blobs.
//      → They vanish from the manifest, so clients delete their local copies.
//
// unlock(password):
//   1. 7z-extract `lockedZip` with the password into a temp dir.
//      Wrong password → 7z exits non-zero → we throw, change nothing.
//   2. Re-import every extracted file back into storage/DB under the prefix.
//      → They reappear in the manifest, so clients download them.
//
// State: "locked" simply means `lockedZip` exists AND no manifest entries are
// under the prefix. We derive it rather than storing a flag, so it can't drift.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { lockedFolderName, lockedZip, tempDir } = require('./config');
const { getAllFiles, getFile, deleteFile } = require('./db');
const { getReadStream, deleteStoredFile } = require('./storage');
const { storeBuffer } = require('./fileService');

// Serialize lock/unlock so two Discord commands can't interleave.
let _busy = false;

function sevenZipBinary() {
  // p7zip-full provides `7z`; some distros only ship `7za`/`7zr`.
  for (const bin of ['7z', '7za', '7zr']) {
    const probe = spawnSync(bin, ['--help'], { stdio: 'ignore' });
    if (!probe.error) return bin;
  }
  return null;
}

function normalizedPrefix() {
  // Ensure a single trailing slash, forward slashes only.
  return lockedFolderName.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
}

// All manifest paths currently under the locked prefix.
function lockedManifestPaths() {
  const prefix = normalizedPrefix();
  return getAllFiles()
    .map((f) => f.path)
    .filter((p) => p.startsWith(prefix));
}

// Locked = archive exists and nothing is in the manifest under the prefix.
function isLocked() {
  return fs.existsSync(lockedZip) && lockedManifestPaths().length === 0;
}

function status() {
  const inManifest = lockedManifestPaths().length;
  return {
    locked: isLocked(),
    archiveExists: fs.existsSync(lockedZip),
    filesInManifest: inManifest,
    prefix: normalizedPrefix(),
  };
}

function mkdtemp(label) {
  const base = path.join(tempDir, `lock-${label}-${Date.now()}-${process.pid}`);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* best effort */
  }
}

// ── lock ────────────────────────────────────────────────────────────────────

async function lock(password) {
  if (_busy) throw new Error('Another lock/unlock operation is in progress.');
  if (!password) throw new Error('Password is required.');

  const bin = sevenZipBinary();
  if (!bin) throw new Error('7z is not installed. Run: apt install p7zip-full');

  _busy = true;
  let stageDir;
  try {
    if (isLocked()) throw new Error('Already locked.');

    const paths = lockedManifestPaths();
    if (paths.length === 0) {
      throw new Error(`No files found under "${normalizedPrefix()}" to lock.`);
    }

    // Stage blobs into a temp tree under their real relative paths so the
    // archive preserves the folder structure on extraction.
    stageDir = mkdtemp('stage');
    const prefix = normalizedPrefix();
    for (const p of paths) {
      const row = getFile(p);
      if (!row) continue;
      // Strip the prefix so the archive root is the locked folder's contents.
      const rel = p.slice(prefix.length);
      const dest = path.join(stageDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await streamToFile(getReadStream(row.storage_id), dest);
    }

    // Fresh archive every time — remove any stale one first.
    if (fs.existsSync(lockedZip)) fs.rmSync(lockedZip);
    fs.mkdirSync(path.dirname(lockedZip), { recursive: true });

    // -mhe=on encrypts headers (filenames) too. -p with no space = password.
    const args = ['a', '-t7z', `-p${password}`, '-mhe=on', lockedZip, '.'];
    const res = spawnSync(bin, args, { cwd: stageDir, stdio: 'pipe' });
    if (res.status !== 0) {
      // Clean up a partial archive so we never leave a half-written file.
      if (fs.existsSync(lockedZip)) fs.rmSync(lockedZip);
      throw new Error(`7z failed to create archive (exit ${res.status}). ${stderr(res)}`);
    }

    // Archive is good — now remove the plaintext blobs + manifest rows.
    // After this the files are gone from the manifest and clients will delete
    // their local copies.
    let removed = 0;
    for (const p of paths) {
      const storageId = deleteFile(p);
      if (storageId) {
        deleteStoredFile(storageId);
        removed++;
      }
    }

    return { lockedCount: removed, archive: lockedZip };
  } finally {
    if (stageDir) rmrf(stageDir);
    _busy = false;
  }
}

// ── unlock ──────────────────────────────────────────────────────────────────

async function unlock(password) {
  if (_busy) throw new Error('Another lock/unlock operation is in progress.');
  if (!password) throw new Error('Password is required.');

  const bin = sevenZipBinary();
  if (!bin) throw new Error('7z is not installed. Run: apt install p7zip-full');

  _busy = true;
  let outDir;
  try {
    if (!fs.existsSync(lockedZip)) throw new Error('Nothing is locked — no archive found.');

    outDir = mkdtemp('extract');

    // -p<password>, -y (assume yes), -o<dir> (no space). Wrong password makes
    // 7z exit non-zero; we surface that and change nothing.
    const args = ['x', `-p${password}`, '-y', `-o${outDir}`, lockedZip];
    const res = spawnSync(bin, args, { stdio: 'pipe' });
    if (res.status !== 0) {
      throw new Error('Extraction failed — wrong password or corrupt archive.');
    }

    // Re-import every extracted file back under the locked prefix.
    const prefix = normalizedPrefix();
    const files = walkFiles(outDir);
    if (files.length === 0) {
      throw new Error('Archive extracted but contained no files.');
    }

    let restored = 0;
    for (const abs of files) {
      const rel = path.relative(outDir, abs).replace(/\\/g, '/');
      const logicalPath = prefix + rel;
      const buffer = fs.readFileSync(abs);
      await storeBuffer({
        filePath: logicalPath,
        fileName: path.basename(abs),
        buffer,
        source: 'lock-service',
      });
      restored++;
    }

    // Files are back in the manifest — clients will re-download them.
    // Remove the archive so state is unambiguously "unlocked".
    fs.rmSync(lockedZip, { force: true });

    return { restoredCount: restored };
  } finally {
    if (outDir) rmrf(outDir);
    _busy = false;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function stderr(res) {
  const s = (res.stderr || '').toString().trim();
  return s ? s.split('\n').slice(-2).join(' ') : '';
}

function streamToFile(readStream, destPath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    readStream.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    readStream.on('error', reject);
  });
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

module.exports = { lock, unlock, isLocked, status, sevenZipBinary };
