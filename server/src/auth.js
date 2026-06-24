'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_PATH = path.join(__dirname, '..', 'config', 'token.txt');

// HMAC replay protection: track accepted nonces for 2× clock-skew window.
// In-memory only — a server restart clears the map, which is acceptable.
const CLOCK_SKEW_SEC = 60;
const NONCE_WINDOW_MS = (CLOCK_SKEW_SEC * 2 + 10) * 1000; // 130 s
const _nonceSeen = new Map();

function purgeExpiredNonces(nowMs) {
  const cutoff = nowMs - NONCE_WINDOW_MS;
  for (const [n, ts] of _nonceSeen) {
    if (ts < cutoff) _nonceSeen.delete(n);
  }
}

// Verify an HMAC-signed request. Returns true if the signature is valid,
// the timestamp is fresh, and the nonce has not been used before.
// Canonical string: METHOD\nPATH_WITH_QUERY\nTIMESTAMP\nNONCE
// Body is NOT signed — buffering a streaming upload defeats the streaming arch.
function verifyHmac(request, token) {
  const ts  = request.headers['x-sc-timestamp'];
  const nonce = request.headers['x-sc-nonce'];
  const sig = request.headers['x-sc-signature'];
  if (!ts || !nonce || !sig) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  const reqSec = parseInt(ts, 10);
  if (isNaN(reqSec) || Math.abs(nowSec - reqSec) > CLOCK_SKEW_SEC) return false;

  if (!/^[0-9a-f]{32}$/.test(nonce)) return false;
  if (_nonceSeen.has(nonce)) return false;

  const canonical = `${request.method}\n${request.url}\n${ts}\n${nonce}`;
  const expected  = crypto.createHmac('sha256', token).update(canonical).digest('hex');
  const sigBuf    = Buffer.from(sig, 'hex');
  const expBuf    = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  const nowMs = Date.now();
  _nonceSeen.set(nonce, nowMs);
  purgeExpiredNonces(nowMs);
  return true;
}

function loadOrGenerateToken() {
  const dir = path.dirname(TOKEN_PATH);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(TOKEN_PATH)) {
    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_PATH, token, 'utf8');
    return token;
  }

  return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
}

const TOKEN = loadOrGenerateToken();

const { web } = require('./config');
const webSession = require('./web/webSession');

// Name of the session cookie set by the web UI login.
const SESSION_COOKIE = 'sc_session';

// Endpoints reachable without auth: health, and (when the web UI is on) the
// login flow + the static UI assets the browser needs to render the login page.
function isPublic(url) {
  if (url === '/api/health') return true;
  if (!web.enabled) return false;
  // The login/config endpoints and the static web assets must be reachable pre-auth.
  if (url === '/api/web/login') return true;
  if (url === '/api/web/config') return true;
  if (url === '/' || url === '/index.html') return true;
  if (url.startsWith('/app.js') || url.startsWith('/style.css')) return true;
  return false;
}

// Authorize every request via EITHER an HMAC-signed request (sync clients +
// Discord bot) OR a web session cookie (browser). The raw token never travels
// on the wire — it acts only as a signing key.
//
// Exported as a plain async function so index.js can register it at the root
// Fastify scope, where it applies to every route. Registering it inside a
// fastify.register() child scope (even before other plugins) scopes the hook to
// that child only — sibling routes would be unprotected.
async function authHook(request, reply) {
  if (isPublic(request.url)) return;

  // 1. HMAC-signed request (sync clients — token never travels on the wire)
  if (request.headers['x-sc-signature']) {
    if (verifyHmac(request, TOKEN)) return;
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  // 2. Web session cookie (browser) — only when the web UI is enabled.
  if (web.enabled && request.cookies) {
    const sess = webSession.getSession(request.cookies[SESSION_COOKIE]);
    if (sess) {
      request.webSession = sess;
      // CSRF: cookie-authenticated state-changing requests must carry a
      // matching CSRF token header. SameSite=Strict already blocks most
      // cross-site sends; this is defence in depth. Safe methods are exempt.
      const method = request.method;
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && request.url !== '/api/web/logout') {
        const csrfHeader = request.headers['x-csrf-token'];
        if (!csrfHeader || csrfHeader !== sess.csrf) {
          reply.code(403).send({ error: 'Invalid or missing CSRF token' });
          return;
        }
      }
      return;
    }
  }

  reply.code(401).send({ error: 'Unauthorized' });
}

module.exports = { authHook, loadOrGenerateToken, TOKEN, SESSION_COOKIE };
