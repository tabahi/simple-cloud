'use strict';

const { getAllFiles } = require('../db');

async function manifestRoute(fastify, _opts) {
  fastify.get('/api/manifest', async (_request, _reply) => {
    return getAllFiles();
  });
}

module.exports = manifestRoute;
