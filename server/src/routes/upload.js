'use strict';

const { storeBuffer } = require('../fileService');

async function uploadRoute(fastify, _opts) {
  fastify.post('/api/upload', async (request, reply) => {
    const parts = request.parts();

    let filePath = null;
    let fileName = null;
    let fileBuffer = null;

    for await (const part of parts) {
      if (part.fieldname === 'path' && !part.filename) {
        filePath = part.value.trim();
      } else if (part.fieldname === 'file' && part.filename) {
        fileName = part.filename;
        const chunks = [];
        for await (const chunk of part.file) chunks.push(chunk);
        fileBuffer = Buffer.concat(chunks);
      }
    }

    if (!filePath || fileBuffer === null) {
      return reply.code(400).send({ error: 'Missing path or file field' });
    }

    const { hash, size } = await storeBuffer({
      filePath,
      fileName,
      buffer: fileBuffer,
      source: request.ip,
    });

    request.log.info({ action: 'upload', path: filePath, size, ip: request.ip }, 'file uploaded');

    return { ok: true, path: filePath, hash };
  });
}

module.exports = uploadRoute;
