'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { storageDir, tempDir, backupMaxFileSizeBytes } = require('./config');

function ensureStorageDir() {
  fs.mkdirSync(storageDir, { recursive: true });
}

// Returns the path for today's temp subdirectory, e.g. <tempDir>/2026-06-14/
function todayTempDir() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.join(tempDir, today);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Copy the current blob to temp before it is overwritten.
// Skips if the existing file exceeds backupMaxFileSizeBytes.
// Backup filename: <storageId>.<ISOtimestamp>.bk
// Returns the temp path if a backup was made, otherwise null.
function backupBlob(storageId) {
  const src = storagePathFor(storageId);
  if (!fs.existsSync(src)) return null;

  const stat = fs.statSync(src);
  if (stat.size > backupMaxFileSizeBytes) return null; // too large — skip backup

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dest = path.join(todayTempDir(), `${storageId}.${today}.bk`);
  fs.copyFileSync(src, dest);
  return dest;
}

function storagePathFor(storageId) {
  return path.join(storageDir, storageId);
}

// Hash a Buffer or stream data using sha256
function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Hash a file on disk by path
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Write uploaded buffer to a new UUID-named file, return { storageId, hash, size }
async function saveFile(buffer) {
  ensureStorageDir();
  const storageId = uuidv4();
  const dest = storagePathFor(storageId);
  fs.writeFileSync(dest, buffer);
  const hash = hashBuffer(buffer);
  return { storageId, hash, size: buffer.length };
}

// Replace an existing stored file (same storageId), return new hash and temp backup path.
// The old blob is copied to temp before being overwritten.
async function replaceFile(storageId, buffer) {
  ensureStorageDir();
  const tempPath = backupBlob(storageId);
  const dest = storagePathFor(storageId);
  fs.writeFileSync(dest, buffer);
  const hash = hashBuffer(buffer);
  return { hash, size: buffer.length, tempPath };
}

// Recycle-bin dir for deleted files: <tempDir>/deletions/<YYYY-MM-DD>/
const DELETIONS_DIR = 'deletions';

function todayDeletionsDir() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.join(tempDir, DELETIONS_DIR, today);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Sanitize a client-supplied logical path into a safe relative path: forward
// slashes, no drive letter, no leading slash, no ".." segments — so it can't
// escape the recycle-bin date directory.
function safeRelativePath(logicalPath) {
  let p = String(logicalPath || '').replace(/\\/g, '/');
  p = p.replace(/^[a-zA-Z]:/, '');
  const parts = p.split('/').filter((s) => s && s !== '.' && s !== '..');
  return parts.length ? parts.join(path.sep) : null;
}

// Move a soon-to-be-deleted blob into the recycle bin, preserving its logical
// path, so it can be browsed/restored later. Skips files over
// backupMaxFileSizeBytes (same rule as overwrite backups). Returns the recycle
// path if recycled, otherwise null.
function recycleDeletedBlob(storageId, logicalPath) {
  const src = storagePathFor(storageId);
  if (!fs.existsSync(src)) return null;

  const stat = fs.statSync(src);
  if (stat.size > backupMaxFileSizeBytes) return null; // too large — skip

  const rel = safeRelativePath(logicalPath);
  if (!rel) return null;

  const dest = path.join(todayDeletionsDir(), rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return dest;
}

function deleteStoredFile(storageId) {
  const dest = storagePathFor(storageId);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
}

function getReadStream(storageId) {
  return fs.createReadStream(storagePathFor(storageId));
}

module.exports = {
  saveFile,
  replaceFile,
  deleteStoredFile,
  recycleDeletedBlob,
  getReadStream,
  hashBuffer,
  hashFile,
  storagePathFor,
  DELETIONS_DIR,
};
