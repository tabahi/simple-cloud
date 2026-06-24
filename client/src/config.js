'use strict';

// Client configuration — loaded entirely from environment variables.
//
// Values come from a `.env` file in the platform config dir (alongside logs)
// plus any variables already set in the real environment (which take
// precedence). There is no config.json anymore.
//
//   Windows: %APPDATA%\simplecloud\.env
//   Linux:   ~/.config/simplecloud/.env
//
// `.env` is gitignored, so your server URL, token, and paths never get
// committed.

const fs = require('fs');
const path = require('path');
const os = require('os');
const dotenv = require('dotenv');

const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'simplecloud')
  : path.join(os.homedir(), '.config', 'simplecloud');
const ENV_FILE = path.join(CONFIG_DIR, '.env');

const DEFAULT_SYNC_FOLDER = process.platform === 'win32'
  ? path.join('C:\\', 'simplecloudData')
  : path.join(os.homedir(), 'simplecloudData');

// Template written on first run so the user has something to fill in.
const ENV_TEMPLATE = `# simple-cloud client configuration
# This file is read on startup. Fill in SC_SERVER_URL and SC_TOKEN, then rerun.

# Full URL of the simple-cloud server (required)
SC_SERVER_URL=https://alive.botup.top:24900

# Signing key from the server (required) — see /opt/scserver/config/token.txt
# This is used to sign requests with HMAC-SHA256; it is never sent on the wire.
SC_TOKEN=

# Local folder to sync
SC_SYNC_FOLDER=${DEFAULT_SYNC_FOLDER}

# (The secure folder name is set on the SERVER and discovered automatically;
#  there is no client-side setting for it.)

# Fallback poll interval (seconds) — SSE push handles real-time syncing;
# this fires periodically as a safety net in case SSE is reconnecting.
SC_SYNC_INTERVAL_SECONDS=300

# debug | info | warn | error
SC_LOG_LEVEL=info

# Set true to connect even when the server's SSL certificate is expired/self-signed.
SC_IGNORE_SSL_ERRORS=false

# Files larger than this (MB) use the slow polling interval instead of the
# real-time watcher. 0 disables (all files real-time).
SC_LARGE_FILE_LAZY_SYNC_MB=100

# Files larger than this (MB) are never synced in either direction. 0 disables.
SC_LARGE_FILE_IGNORE_MB=500
`;

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

async function loadConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (!fs.existsSync(ENV_FILE)) {
    if (process.platform === 'win32') {
      const { runWizard, writeEnvFile } = require('./wizard');
      const values = await runWizard({}, DEFAULT_SYNC_FOLDER);
      if (!values) process.exit(0);
      writeEnvFile(ENV_FILE, ENV_TEMPLATE, values);
    } else {
      fs.writeFileSync(ENV_FILE, ENV_TEMPLATE, 'utf8');
      console.warn(`Config created at ${ENV_FILE} — please edit it and restart.`);
      process.exit(0);
    }
  }
  console.info(`Loading config from ${ENV_FILE}`);

  // Load the .env file into process.env (won't overwrite already-set vars).
  const result = dotenv.config({ path: ENV_FILE });
  if (result.error) {
    console.error(`Could not read ${ENV_FILE}: ${result.error.message}`);
    process.exit(1);
  }

  const cfg = {
    serverUrl: str('SC_SERVER_URL', '').replace(/\/+$/, ''),
    token: str('SC_TOKEN', ''),
    syncFolder: str('SC_SYNC_FOLDER', DEFAULT_SYNC_FOLDER),
    syncIntervalSeconds: int('SC_SYNC_INTERVAL_SECONDS', 300),
    logLevel: str('SC_LOG_LEVEL', 'info'),
    ignoreSslErrors: bool('SC_IGNORE_SSL_ERRORS', false),
    largeFileLazySyncMb: int('SC_LARGE_FILE_LAZY_SYNC_MB', 100),
    largeFileIgnoreMb: int('SC_LARGE_FILE_IGNORE_MB', 500),
  };

  // On Windows, prompt for any missing required fields via a GUI wizard.
  if (process.platform === 'win32' && (!cfg.serverUrl || !cfg.token || !cfg.syncFolder)) {
    const { runWizard, writeEnvFile } = require('./wizard');
    const values = await runWizard(cfg, DEFAULT_SYNC_FOLDER);
    if (!values) process.exit(0);
    writeEnvFile(ENV_FILE, ENV_TEMPLATE, values);
    dotenv.config({ path: ENV_FILE, override: true });
    cfg.serverUrl  = str('SC_SERVER_URL', '');
    cfg.token      = str('SC_TOKEN', '');
    cfg.syncFolder = str('SC_SYNC_FOLDER', DEFAULT_SYNC_FOLDER);
  }

  // Validate required fields
  if (!cfg.serverUrl) throw new Error(`${ENV_FILE}: SC_SERVER_URL is not set`);
  if (!cfg.token) {
    throw new Error(
      `${ENV_FILE}: SC_TOKEN is not set — paste the signing key from /opt/scserver/config/token.txt`
    );
  }
  if (!cfg.syncFolder) throw new Error(`${ENV_FILE}: SC_SYNC_FOLDER is not set`);

  return cfg;
}

module.exports = { loadConfig, ENV_FILE, CONFIG_DIR };
