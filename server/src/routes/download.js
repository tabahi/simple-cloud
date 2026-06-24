'use strict';

const path = require('path');
const mime = require('mime-types');
const { getFile } = require('../db');
const { getReadStream } = require('../storage');

async function downloadRoute(fastify, _opts) {
  fastify.get('/api/download', async (request, reply) => {
    const filePath = request.query.path;
    if (!filePath) {
      return reply.code(400).send({ error: 'Missing path query parameter' });
    }

    const row = getFile(filePath);
    if (!row) {
      return reply.code(404).send({ error: 'File not found' });
    }

    const contentType = mime.lookup(filePath) || 'application/octet-stream';
    const stream = getReadStream(row.storage_id);

    request.log.info(
      { action: 'download', path: filePath, size: row.size, ip: request.ip },
      'file downloaded'
    );

    const filename = path.basename(filePath);
    return reply
      .header('Content-Type', contentType)
      .header('Content-Length', row.size)
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(stream);
  });
}

module.exports = downloadRoute;
