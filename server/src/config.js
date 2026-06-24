'use strict';

// Server configuration — loaded entirely from environment variables.
//
// Values come from `server/.env` (see server/.env.example) plus any variables
// already present in the real environment (which take precedence — useful for
// systemd/PM2 overrides). There is no JSON config file anymore.
//
// `.env` is gitignored, so your own cloud's paths, hostnames, cert paths, and
// Discord secrets never get committed.

const fs = require('fs');
const path = require('path');

// Load server/.env into process.env (without overwriting vars already set).
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ── helpers ───────────────────────────────────────────────────────────────────

function str(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function bool(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

// Comma-separated list → trimmed non-empty array (e.g. "111, 222" → ["111","222"]).
function list(key) {
  const v = process.env[key];
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── config ────────────────────────────────────────────────────────────────────

const config = {
  port: int('SC_PORT', 11277),
  host: str('SC_HOST', '127.0.0.1'),

  storageDir: str('SC_STORAGE_DIR', '/var/simplecloud/storage'),
  tempDir: str('SC_TEMP_DIR', '/var/simplecloud/temp'),
  logDir: str('SC_LOG_DIR', '/var/simplecloud/logs'),
  dbDir: str('SC_DB_DIR', '/var/simplecloud'),
  filechangeLogs: str('SC_FILECHANGE_LOGS', ''), // derived below if empty

  pm2Name: str('SC_PM2_NAME', 'simplecloud-server'),

  minClientVersion: str('SC_MIN_CLIENT_VERSION', '1.0.0'),

  backupRetentionDays: int('SC_BACKUP_RETENTION_DAYS', 90),
  backupMaxFileSizeBytes: int('SC_BACKUP_MAX_FILE_SIZE_BYTES', 10 * 1024 * 1024),

  // Secure locked-folder feature.
  lockedFolderName: str('SC_LOCKED_FOLDER_NAME', '.simplecloud_locked'),
  lockedZip: str('SC_LOCKED_ZIP', '/var/simplecloud/locked.7z'),

  ssl: {
    enabled: bool('SC_SSL_ENABLED', false),
    certFile: str('SC_SSL_CERT_FILE', ''),
    keyFile: str('SC_SSL_KEY_FILE', ''),
  },

  discord: {
    enabled: bool('SC_DISCORD_ENABLED', false),
    token: str('SC_DISCORD_TOKEN', ''),
    clientId: str('SC_DISCORD_CLIENT_ID', ''),
    guildId: str('SC_DISCORD_GUILD_ID', ''),
    allowedUserIds: list('SC_DISCORD_ALLOWED_USER_IDS'),
    allowedChannelIds: list('SC_DISCORD_ALLOWED_CHANNEL_IDS'),
    maxUploadBytes: int('SC_DISCORD_MAX_UPLOAD_BYTES', 25 * 1024 * 1024),
  },

  // Optional web UI. Off by default. When enabled, login is password + (by
  // default) a TOTP code, exchanged for an HttpOnly session cookie. The signing
  // key is never exposed to the browser. See server/web/ and routes/web.js.
  web: {
    enabled: bool('SC_WEB_ENABLED', false),
    passwordHash: str('SC_WEB_PASSWORD_HASH', ''), // scrypt hash "scrypt$<saltHex>$<hashHex>"
    sessionSecret: str('SC_WEB_SESSION_SECRET', ''), // HMAC key for signing sessions
    totpEnabled: bool('SC_WEB_TOTP_ENABLED', true),  // 2FA ON by default
    totpSecret: str('SC_WEB_TOTP_SECRET', ''),       // base32 TOTP secret
    sessionTtlMinutes: int('SC_WEB_SESSION_TTL_MINUTES', 60),
  },
};

// Derived paths
if (!config.filechangeLogs) {
  config.filechangeLogs = path.join(config.logDir, 'changes.log');
}
config.logFile = path.join(config.logDir, 'server.log');
config.dbPath = path.join(config.dbDir, 'simplecloud.db');

// Ensure the directories that other modules assume exist.
fs.mkdirSync(config.logDir, { recursive: true });
fs.mkdirSync(config.dbDir, { recursive: true });

module.exports = config;
