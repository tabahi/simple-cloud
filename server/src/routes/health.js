'use strict';

const { execSync } = require('child_process');
const pkg = require('../../package.json');
const config = require('../config');

// Captured once when this module loads (i.e. at process boot). If the files on
// disk are redeployed but the process is NOT restarted, `startedAt` stays old
// even though @fastify/static serves the new web assets — that mismatch is what
// silently broke session resume before. The web UI surfaces this (see app.js).
const STARTED_AT = new Date().toISOString();

// Best-effort build identifier so a stale deploy is obvious. Prefer an explicit
// env var (set it in your deploy script), else read the git commit, else 'dev'.
const COMMIT = (() => {
  if (process.env.SC_COMMIT) return process.env.SC_COMMIT;
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || 'unknown';
  } catch (_) {
    return 'unknown';
  }
})();

async function healthRoute(fastify, _opts) {
  fastify.get('/api/health', async (_request, _reply) => {
    return {
      status: 'ok',
      version: pkg.version,
      commit: COMMIT,
      startedAt: STARTED_AT,
      uptimeSec: Math.round(process.uptime()),
      minClientVersion: config.minClientVersion,
    };
  });
}

module.exports = healthRoute;
