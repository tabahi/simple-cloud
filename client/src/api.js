'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const fetch = require('node-fetch');
const FormData = require('form-data');
const logger = require('./logger');

let _config = null;
let _agent = null; // reused across all requests

function setConfig(cfg) {
  _config = cfg;

  if (cfg.ignoreSslErrors && cfg.serverUrl.startsWith('https')) {
    // Allow expired or self-signed certs (e.g. lapsed Let's Encrypt renewal).
    // HMAC signatures still authenticate every request, so the risk is limited
    // to a potential MITM on the local network — acceptable for a home/office setup.
    _agent = new https.Agent({ rejectUnauthorized: false });
    logger.warn('ignoreSslErrors=true: SSL certificate errors will be ignored');
  } else {
    _agent = null;
  }
}

// Build HMAC-signed request headers. The raw token is the signing key and
// never travels on the wire. Canonical string: METHOD\nPATH_WITH_QUERY\nTS\nNONCE
function signedHeaders(method, fullUrl) {
  const parsed = new URL(fullUrl);
  const pathWithQuery = parsed.pathname + (parsed.search || '');
  const ts    = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const canonical = `${method}\n${pathWithQuery}\n${ts}\n${nonce}`;
  const sig = crypto.createHmac('sha256', _config.token).update(canonical).digest('hex');
  return { 'X-SC-Timestamp': ts, 'X-SC-Nonce': nonce, 'X-SC-Signature': sig };
}

function fetchOpts(extra) {
  return _agent ? { ...extra, agent: _agent } : extra;
}

function url(endpoint) {
  return `${_config.serverUrl}${endpoint}`;
}

async function fetchHealth() {
  const res = await fetch(url('/api/health'), fetchOpts({}));
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

async function fetchManifest() {
  const res = await fetch(url('/api/manifest'), fetchOpts({ headers: signedHeaders('GET', url('/api/manifest')) }));
  if (res.status === 401) throw Object.assign(new Error('Invalid token — check .env'), { code: 'AUTH' });
  if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
  return res.json();
}

// How long to wait for an upload before treating it as a rate-limit/timeout.
// The firewall-level rate limiter drops the connection rather than returning a
// status code, so the request just hangs until this fires.
const UPLOAD_TIMEOUT_MS = 30 * 1000;

// Low-level connection failures that indicate the firewall throttled/dropped us.
const RATE_LIMIT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

// Classify an error as a rate-limit/connection problem so the upload queue can
// back off for 30s and retry the same file (instead of dropping it).
function isRateLimitError(err) {
  if (!err) return false;
  if (err.code && RATE_LIMIT_ERROR_CODES.has(err.code)) return true;
  // node-fetch surfaces its own timeout as a FetchError with this type.
  if (err.type === 'request-timeout') return true;
  // HTTP-level signals, in case a proxy returns them instead of dropping.
  if (err.status === 429 || err.status === 503) return true;
  return false;
}

// Upload a local file to the server. No internal retry — the upload queue owns
// retry/backoff so all uploads stay strictly serial. On a rate-limit/timeout
// the thrown error carries `code: 'RATE_LIMIT'`.
async function uploadFile(relativePath, localAbsPath) {
  const form = new FormData();
  form.append('path', relativePath);
  form.append('file', fs.createReadStream(localAbsPath), {
    filename: path.basename(localAbsPath),
  });

  let res;
  try {
    res = await fetch(url('/api/upload'), fetchOpts({
      method: 'POST',
      headers: { ...signedHeaders('POST', url('/api/upload')), ...form.getHeaders() },
      body: form,
      timeout: UPLOAD_TIMEOUT_MS,
    }));
  } catch (err) {
    if (isRateLimitError(err)) {
      throw Object.assign(new Error(`Upload rate-limited/timed out: ${relativePath}`), { code: 'RATE_LIMIT', cause: err });
    }
    throw err;
  }

  if (res.status === 401) throw Object.assign(new Error('Invalid token — check .env'), { code: 'AUTH' });
  if (res.status === 429 || res.status === 503) {
    throw Object.assign(new Error(`Upload rate-limited (${res.status}): ${relativePath}`), { code: 'RATE_LIMIT' });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  logger.info(`Uploaded: ${relativePath} (hash: ${json.hash})`);
  return json;
}

// Download a remote file and write it to localAbsPath
async function downloadFile(relativePath, localAbsPath) {
  const res = await fetch(url(`/api/download?path=${encodeURIComponent(relativePath)}`), fetchOpts({
    headers: signedHeaders('GET', url(`/api/download?path=${encodeURIComponent(relativePath)}`)),
    timeout: UPLOAD_TIMEOUT_MS,
  }));

  if (res.status === 401) throw Object.assign(new Error('Invalid token — check .env'), { code: 'AUTH' });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${relativePath}`);

  fs.mkdirSync(path.dirname(localAbsPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(localAbsPath);
    res.body.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
    res.body.on('error', reject);
  });

  logger.info(`Downloaded: ${relativePath}`);
}

async function fetchDeletions() {
  const res = await fetch(url('/api/deletions'), fetchOpts({ headers: signedHeaders('GET', url('/api/deletions')) }));
  if (res.status === 401) throw Object.assign(new Error('Invalid token — check .env'), { code: 'AUTH' });
  if (!res.ok) throw new Error(`Deletions fetch failed: ${res.status}`);
  const json = await res.json();
  return new Set(json.deleted || []);
}

// Returns the server's secure-folder lock state: { locked, prefix }.
// Falls back to { locked: false } if the server is older and lacks the route,
// so the client never deletes the locked folder against an unaware server.
async function fetchLockStatus() {
  const res = await fetch(url('/api/lock-status'), fetchOpts({ headers: signedHeaders('GET', url('/api/lock-status')) }));
  if (res.status === 401) throw Object.assign(new Error('Invalid token — check .env'), { code: 'AUTH' });
  if (res.status === 404) return { locked: false };
  if (!res.ok) throw new Error(`Lock-status fetch failed: ${res.status}`);
  return res.json();
}

// List all server-side backups, grouped by date.
// → [{ date, files: [{ id, storageId, date, size, logicalPath }] }]
async function fetchBackups() {
  const res = await fetch(url('/api/backups'), fetchOpts({ headers: signedHeaders('GET', url('/api/backups')) }));
  if (res.status === 401) throw Object.assign(new Error('Invalid token — check .env'), { code: 'AUTH' });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Backups list failed: ${res.status}`);
  const json = await res.json();
  return json.backups || [];
}

// Download a single backup blob (by opaque id) to a local absolute path.
async function downloadBackup(id, localAbsPath) {
  const res = await fetch(url(`/api/backup?id=${encodeURIComponent(id)}`), fetchOpts({
    headers: signedHeaders('GET', url(`/api/backup?id=${encodeURIComponent(id)}`)),
    timeout: UPLOAD_TIMEOUT_MS,
  }));
  if (res.status === 401) throw Object.assign(new Error('Invalid token — check .env'), { code: 'AUTH' });
  if (!res.ok) throw new Error(`Backup download failed (${res.status}): ${id}`);

  fs.mkdirSync(path.dirname(localAbsPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(localAbsPath);
    res.body.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
    res.body.on('error', reject);
  });
}

// Clear all server-side backups. → { removedDateDirs }
async function clearServerBackups() {
  const res = await fetch(url('/api/backups'), fetchOpts({
    method: 'DELETE',
    headers: signedHeaders('DELETE', url('/api/backups')),
  }));
  if (res.status === 401) throw Object.assign(new Error('Invalid token — check .env'), { code: 'AUTH' });
  if (!res.ok) throw new Error(`Clear backups failed: ${res.status}`);
  return res.json();
}

async function deleteRemoteFile(relativePath) {
  const res = await fetch(url(`/api/file?path=${encodeURIComponent(relativePath)}`), fetchOpts({
    method: 'DELETE',
    headers: signedHeaders('DELETE', url(`/api/file?path=${encodeURIComponent(relativePath)}`)),
  }));

  if (res.status === 401) throw Object.assign(new Error('Invalid token — check .env'), { code: 'AUTH' });
  if (res.status === 404) return; // already gone
  if (!res.ok) throw new Error(`Delete failed (${res.status}): ${relativePath}`);

  logger.info(`Deleted remote: ${relativePath}`);
}

// Bulk-delete many paths in ONE request (POST /api/files/delete). Used by the
// delete queue to collapse a folder's worth of deletions into a single call so
// the firewall rate limiter isn't tripped. On a timeout/connection drop the
// thrown error carries code:'RATE_LIMIT' so the caller can back off and retry.
async function deleteRemoteFiles(paths) {
  let res;
  try {
    res = await fetch(url('/api/files/delete'), fetchOpts({
      method: 'POST',
      headers: { ...signedHeaders('POST', url('/api/files/delete')), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
      timeout: UPLOAD_TIMEOUT_MS,
    }));
  } catch (err) {
    if (isRateLimitError(err)) {
      throw Object.assign(new Error(`Bulk delete rate-limited/timed out (${paths.length} paths)`), { code: 'RATE_LIMIT', cause: err });
    }
    throw err;
  }

  if (res.status === 401) throw Object.assign(new Error('Invalid token — check .env'), { code: 'AUTH' });
  if (res.status === 429 || res.status === 503) {
    throw Object.assign(new Error(`Bulk delete rate-limited (${res.status})`), { code: 'RATE_LIMIT' });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bulk delete failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  logger.info(`Bulk-deleted ${json.deleted}/${paths.length} remote path(s)` + (json.missing ? ` (${json.missing} already gone)` : ''));
  return json;
}

// Open a persistent SSE connection to /api/events. Calls onEvent(data) for
// each "data: ..." line received, and onError(err) when the stream closes or
// errors. Returns a disconnect() function. Reconnect logic lives in index.js.
function connectEventStream(onEvent, onError) {
  const serverUrl = new URL(_config.serverUrl);
  const isHttps = serverUrl.protocol === 'https:';
  const lib = isHttps ? require('https') : require('http');

  const reqOpts = {
    hostname: serverUrl.hostname,
    port: serverUrl.port || (isHttps ? 443 : 80),
    path: '/api/events',
    headers: signedHeaders('GET', _config.serverUrl + '/api/events'),
  };
  if (_agent) reqOpts.agent = _agent;

  const req = lib.get(reqOpts, (res) => {
    if (res.statusCode === 401) {
      return onError(Object.assign(new Error('Invalid token — check .env'), { code: 'AUTH' }));
    }
    if (res.statusCode !== 200) {
      return onError(new Error(`SSE connect: HTTP ${res.statusCode}`));
    }
    logger.info('SSE connected');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith('data: ')) onEvent(line.slice(6).trim());
      }
    });
    res.on('end', () => onError(new Error('SSE stream ended')));
    res.on('error', onError);
  });
  req.on('error', onError);
  return () => req.destroy();
}

module.exports = { setConfig, fetchHealth, fetchManifest, fetchDeletions, fetchLockStatus, uploadFile, downloadFile, deleteRemoteFile, deleteRemoteFiles, fetchBackups, downloadBackup, clearServerBackups, isRateLimitError, connectEventStream };
