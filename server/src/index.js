'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const Fastify = require('fastify');
const multipart = require('@fastify/multipart');
const pinoRoll = require('pino-roll');

const { initDb } = require('./db');
const { authHook } = require('./auth');
const { scheduleCleanup } = require('./cleanup');
const { startDiscordBot } = require('./discord/bot');
const { logDir, logFile, tempDir, port, host, web } = require('./config');

// Validate the web-UI config up front and fail closed: if the web UI is on with
// TOTP required but no secret/password configured, refuse to start it rather
// than silently downgrading security.
function validateWebConfig() {
  if (!web.enabled) return;
  if (!web.passwordHash) {
    throw new Error('SC_WEB_ENABLED=true but SC_WEB_PASSWORD_HASH is not set. Run setup.sh to configure the web UI.');
  }
  if (!web.sessionSecret) {
    throw new Error('SC_WEB_ENABLED=true but SC_WEB_SESSION_SECRET is not set. Run setup.sh to configure the web UI.');
  }
  if (web.totpEnabled && !web.totpSecret) {
    throw new Error('SC_WEB_ENABLED=true with TOTP on, but SC_WEB_TOTP_SECRET is not set. Set the secret, or set SC_WEB_TOTP_ENABLED=false to disable 2FA.');
  }
}

fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });

async function buildLogger() {
  // Rolling file stream: max 10 MB, keep 5 rotated files
  const rollStream = await pinoRoll({ file: logFile, size: '10m', limit: { count: 5 } });

  return pino.multistream([
    { stream: process.stdout },
    { stream: rollStream },
  ]);
}

async function start() {
  validateWebConfig();
  initDb();

  const logStream = await buildLogger();

  const fastify = Fastify({
    logger: {
      level: 'info',
      stream: logStream,
    },
  });

  fastify.register(multipart, {
    limits: {
      fileSize: 500 * 1024 * 1024, // 500 MB per file
    },
  });

  // @fastify/cookie at ROOT scope so its onRequest cookie-parser hook is an
  // ancestor hook. Fastify always runs ancestor scope hooks before descendant
  // scope hooks, which guarantees request.cookies is populated before our auth
  // hook (registered in the child scope below) reads it.
  if (web.enabled) {
    await fastify.register(require('@fastify/cookie'));
  }

  // Static web assets at ROOT scope — publicly accessible before login.
  if (web.enabled) {
    await fastify.register(require('@fastify/static'), {
      root: path.join(__dirname, '..', 'web'),
      prefix: '/',
    });
  }

  // All routes live inside this single encapsulated scope so that the auth
  // hook applies to every one of them. Registering the hook at the root level
  // via fastify.register() would scope it to a childless plugin (the original
  // bug) — this wrapper makes all routes proper descendants of the hook.
  fastify.register(async (f) => {
    f.addHook('onRequest', authHook);

    if (web.enabled) {
      f.register(require('./routes/web'));
    }

    f.register(require('./routes/health'));
    f.register(require('./routes/events'));
    f.register(require('./routes/manifest'));
    f.register(require('./routes/upload'));
    f.register(require('./routes/download'));
    f.register(require('./routes/delete'));
    f.register(require('./routes/deletions'));
    f.register(require('./routes/lockStatus'));
    f.register(require('./routes/backups'));
    f.register(require('./routes/log'));
  });

  try {
    await fastify.listen({ port, host });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  scheduleCleanup(fastify.log);

  if (web.enabled) {
    fastify.log.info(
      { totp: web.totpEnabled ? 'required' : 'DISABLED' },
      'web UI enabled'
    );
    // Periodically drop expired sessions so the in-memory store stays bounded.
    const { sweepSessions } = require('./web/webSession');
    setInterval(sweepSessions, 10 * 60 * 1000);
  }

  // Discord bot — only starts if discord.enabled is true in server.json.
  // A bot failure must not take down the file server, so errors are caught.
  startDiscordBot(fastify.log).catch((err) => {
    fastify.log.error({ err }, 'discord bot failed to start');
  });
}

start();
