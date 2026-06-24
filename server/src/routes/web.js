'use strict';

// Web-UI auth routes. Only registered when SC_WEB_ENABLED=true.
//
//   POST /api/web/login   { password, totp? } → sets HttpOnly session cookie
//   POST /api/web/logout  clears the session
//   GET  /api/web/config  { totpRequired }  (public-ish: tells the login page
//                          whether to show the TOTP field)
//   GET  /api/web/session { csrf }           (authenticated: CSRF token for the UI)

const { web, ssl } = require('../config');
const { SESSION_COOKIE } = require('../auth');
const webSession = require('../web/webSession');
const totp = require('../web/totp');

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: ssl.enabled, // Secure flag on when the app terminates TLS itself;
  // behind an HTTPS reverse proxy the proxy adds it. (Documented in README.)
  path: '/',
  maxAge: (web.sessionTtlMinutes || 60) * 60,
};

async function webRoute(fastify, _opts) {
  // Lets the login page know whether to prompt for a TOTP code. No secrets.
  fastify.get('/api/web/config', async () => {
    return { totpRequired: web.totpEnabled === true };
  });

  // Issue a CSRF token for the current session (UI calls this after login).
  fastify.get('/api/web/session', async (request, reply) => {
    if (!request.webSession) {
      // TEMP DIAGNOSTIC: shows whether the browser actually sent the session
      // cookie on a reload. If hasSessionCookie=false the cookie isn't coming
      // back (storage/SameSite/proxy); if true it's being rejected server-side
      // (HMAC/expiry/missing row). Remove once the logout-on-refresh is solved.
      const raw = request.cookies && request.cookies[SESSION_COOKIE];
      request.log.warn({
        hasCookieHeader: !!request.headers.cookie,
        cookieNames: Object.keys(request.cookies || {}),
        hasSessionCookie: !!raw,
        sessionCookieLen: raw ? raw.length : 0,
      }, 'session resume rejected');
      return reply.code(401).send({ error: 'No session' });
    }
    return { csrf: request.webSession.csrf };
  });

  fastify.post('/api/web/login', async (request, reply) => {
    const ip = request.ip;
    const rl = webSession.checkRateLimit(ip);
    if (!rl.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(rl.retryAfterSec))
        .send({ error: `Too many attempts. Try again in ${rl.retryAfterSec}s.` });
    }

    const { password, totp: code } = request.body || {};

    const passwordOk = webSession.verifyPassword(password || '', web.passwordHash);
    const totpOk = web.totpEnabled ? totp.verify(code, web.totpSecret) : true;

    if (!passwordOk || !totpOk) {
      webSession.recordFailure(ip);
      request.log.warn({ ip, passwordOk, totpOk: web.totpEnabled ? totpOk : 'n/a' }, 'web login failed');
      // Don't reveal which factor failed.
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    webSession.recordSuccess(ip);
    const { cookieValue, csrf } = webSession.createSession();
    reply.setCookie(SESSION_COOKIE, cookieValue, COOKIE_OPTS);
    request.log.info({ ip }, 'web login ok');
    return { ok: true, csrf };
  });

  fastify.post('/api/web/logout', async (request, reply) => {
    if (request.cookies && request.cookies[SESSION_COOKIE]) {
      webSession.destroySession(request.cookies[SESSION_COOKIE]);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}

module.exports = webRoute;
