'use strict';

// Web-UI auth primitives: password hashing (scrypt), signed sessions, a login
// rate-limiter, and CSRF tokens. Node `crypto` only — no dependencies.
//
// Sessions are stored in memory: a random session id → { expires, csrf }. The
// cookie carries "<sessionId>.<hmac>" so a forged id is rejected without a DB
// lookup. The signing key is NEVER placed in the cookie.

const crypto = require('crypto');
const { web } = require('../config');
const { getDb } = require('../db');

const SCRYPT_KEYLEN = 32;
const SESSION_ID_BYTES = 32;
const CSRF_BYTES = 24;

// ── password hashing (scrypt) ───────────────────────────────────────────────────

// Hash format: "scrypt$<saltHex>$<hashHex>". setup.sh writes this into
// SC_WEB_PASSWORD_HASH so the plaintext password is never stored.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length);
  } catch (_) {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ── sessions ─────────────────────────────────────────────────────────────────────

// Sessions are stored in SQLite (table web_sessions), NOT in process memory, so
// they survive a server restart and are shared across all worker processes
// behind a reverse proxy. The cookie still carries "<id>.<hmac>" so a forged id
// is rejected by the HMAC before any DB lookup.

function sign(value) {
  return crypto.createHmac('sha256', web.sessionSecret || 'unset').update(value).digest('hex');
}

// Create a new session, returning { cookieValue, csrf }.
function createSession() {
  const id = crypto.randomBytes(SESSION_ID_BYTES).toString('hex');
  const csrf = crypto.randomBytes(CSRF_BYTES).toString('hex');
  const ttl = (web.sessionTtlMinutes || 60) * 60 * 1000;
  getDb()
    .prepare('INSERT INTO web_sessions (id, expires, csrf) VALUES (?, ?, ?)')
    .run(id, Date.now() + ttl, csrf);
  return { cookieValue: `${id}.${sign(id)}`, csrf };
}

// Validate a cookie value → the session record, or null. Verifies the HMAC
// (constant-time) before any DB lookup, and prunes the row if it has expired.
function getSession(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot === -1) return null;
  const id = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);
  const expectedMac = sign(id);
  if (mac.length !== expectedMac.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expectedMac))) return null;

  const sess = getDb().prepare('SELECT expires, csrf FROM web_sessions WHERE id = ?').get(id);
  if (!sess) return null;
  if (Date.now() > sess.expires) {
    getDb().prepare('DELETE FROM web_sessions WHERE id = ?').run(id);
    return null;
  }
  return { id, csrf: sess.csrf };
}

function destroySession(cookieValue) {
  if (!cookieValue) return;
  const dot = cookieValue.lastIndexOf('.');
  if (dot === -1) return;
  getDb().prepare('DELETE FROM web_sessions WHERE id = ?').run(cookieValue.slice(0, dot));
}

// Sweep expired sessions occasionally so the table can't grow unbounded.
function sweepSessions() {
  getDb().prepare('DELETE FROM web_sessions WHERE expires < ?').run(Date.now());
}

// ── login rate-limiter ────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5;          // failures before lockout
const WINDOW_MS = 15 * 60 * 1000; // attempts tracked over this window
const LOCKOUT_MS = 15 * 60 * 1000; // lockout duration after MAX_ATTEMPTS

const _attempts = new Map(); // ip → { count, first: ms, lockedUntil: ms }

// Returns { allowed, retryAfterSec } — call before checking the password.
function checkRateLimit(ip) {
  const rec = _attempts.get(ip);
  const now = Date.now();
  if (!rec) return { allowed: true };
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { allowed: false, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

function recordFailure(ip) {
  const now = Date.now();
  let rec = _attempts.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) {
    rec = { count: 0, first: now, lockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
  }
  _attempts.set(ip, rec);
}

function recordSuccess(ip) {
  _attempts.delete(ip);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  sweepSessions,
  checkRateLimit,
  recordFailure,
  recordSuccess,
};
