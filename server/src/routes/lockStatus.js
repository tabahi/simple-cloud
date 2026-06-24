'use strict';

const lockService = require('../lockService');

// GET /api/lock-status → { locked, prefix }
// Clients poll this to decide how to treat the secure folder:
//   locked=true  → remove local plaintext copies (the server holds only the
//                  encrypted archive).
//   locked=false → the folder behaves like a normal synced folder (new files
//                  upload, server files download). This is also the first-run
//                  state, so brand-new secret files are NOT deleted.
async function lockStatusRoute(fastify, _opts) {
  fastify.get('/api/lock-status', async (_request, _reply) => {
    const s = lockService.status();
    return { locked: s.locked, prefix: s.prefix };
  });
}

module.exports = lockStatusRoute;
