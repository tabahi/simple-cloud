'use strict';

const fs = require('fs');
const { logFile } = require('../config');

const LOG_FILE = logFile;

async function logRoute(fastify, _opts) {
  fastify.get('/api/log', async (request, reply) => {
    const n = parseInt(request.query.lines || '100', 10);
    if (isNaN(n) || n < 1) {
      return reply.code(400).send({ error: 'Invalid lines parameter' });
    }

    if (!fs.existsSync(LOG_FILE)) {
      return { lines: [] };
    }

    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const all = content.split('\n').filter(Boolean);
    // Return the last N lines
    const lines = all.slice(-n);
    return { lines };
  });
}

module.exports = logRoute;
