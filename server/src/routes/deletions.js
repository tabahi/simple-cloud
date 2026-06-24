'use strict';

const fs = require('fs');
const { filechangeLogs, logDir } = require('../config');
const path = require('path');

const CHANGES_LOG = filechangeLogs || path.join(logDir, 'changes.log');

// Returns the set of file paths deleted within the last `sinceMs` milliseconds.
// Clients use this to avoid re-uploading files that a peer deleted.
async function deletionsRoute(fastify, _opts) {
  fastify.get('/api/deletions', async (request, reply) => {
    const sinceMs = parseInt(request.query.since || String(30 * 24 * 60 * 60 * 1000), 10);
    if (isNaN(sinceMs) || sinceMs < 0) {
      return reply.code(400).send({ error: 'Invalid since parameter' });
    }

    if (!fs.existsSync(CHANGES_LOG)) {
      return { deleted: [] };
    }

    const cutoff = Date.now() - sinceMs;
    const content = fs.readFileSync(CHANGES_LOG, 'utf8');
    const deleted = [];

    for (const line of content.split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.action === 'delete' && new Date(entry.ts).getTime() >= cutoff) {
        deleted.push(entry.path);
      }
    }

    return { deleted };
  });
}

module.exports = deletionsRoute;
