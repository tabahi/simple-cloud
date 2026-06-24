'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');
const { dbDir, dbPath } = require('./config');

let db;

function initDb() {
  fs.mkdirSync(dbDir, { recursive: true });

  db = new Database(dbPath);

  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      path       TEXT    NOT NULL UNIQUE,
      storage_id TEXT    NOT NULL,
      hash       TEXT    NOT NULL,
      size       INTEGER NOT NULL,
      modified_at TEXT   NOT NULL
    )
  `);

  // Web-UI sessions live here (not in process memory) so they survive restarts
  // and are shared across worker processes behind a reverse proxy — otherwise a
  // reload can land on a worker that never saw the session and 401s. See
  // web/webSession.js.
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_sessions (
      id      TEXT    PRIMARY KEY,
      expires INTEGER NOT NULL,
      csrf    TEXT    NOT NULL
    )
  `);

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function upsertFile({ path: filePath, storage_id, hash, size, modified_at }) {
  const stmt = getDb().prepare(`
    INSERT INTO files (path, storage_id, hash, size, modified_at)
    VALUES (@path, @storage_id, @hash, @size, @modified_at)
    ON CONFLICT(path) DO UPDATE SET
      storage_id  = excluded.storage_id,
      hash        = excluded.hash,
      size        = excluded.size,
      modified_at = excluded.modified_at
  `);
  stmt.run({ path: filePath, storage_id, hash, size, modified_at });
}

function getFile(filePath) {
  return getDb().prepare('SELECT * FROM files WHERE path = ?').get(filePath);
}

function getAllFiles() {
  return getDb().prepare('SELECT path, hash, size, modified_at FROM files').all();
}

function deleteFile(filePath) {
  const row = getDb().prepare('SELECT storage_id FROM files WHERE path = ?').get(filePath);
  if (!row) return null;
  getDb().prepare('DELETE FROM files WHERE path = ?').run(filePath);
  return row.storage_id;
}

module.exports = { initDb, getDb, upsertFile, getFile, getAllFiles, deleteFile };
