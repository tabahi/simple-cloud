'use strict';

const { deleteFile } = require('../db');
const { deleteStoredFile, recycleDeletedBlob } = require('../storage');
const changelog = require('../changelog');
const { notifyChanged } = require('../events');

// Delete one logical path. Returns true if it existed and was removed.
// The blob is first moved to the recycle bin (tempDir/deletions/<date>/<path>)
// so it can be browsed/restored until it expires, then removed from storage.
function deleteOne(filePath, ip, log) {
  const storageId = deleteFile(filePath);
  if (!storageId) return false;
  try {
    recycleDeletedBlob(storageId, filePath);
  } catch (e) {
    if (log) log.warn({ path: filePath, err: e.message }, 'could not recycle deleted file');
  }
  deleteStoredFile(storageId);
  changelog.logDelete({ filePath, storageId, ip });
  notifyChanged();
  if (log) log.info({ action: 'delete', path: filePath, ip }, 'file deleted');
  return true;
}

async function deleteRoute(fastify, _opts) {
  // Single-file delete (kept for back-compat).
  fastify.delete('/api/file', async (request, reply) => {
    const filePath = request.query.path;
    if (!filePath) {
      return reply.code(400).send({ error: 'Missing path query parameter' });
    }

    const existed = deleteOne(filePath, request.ip, request.log);
    if (!existed) {
      return reply.code(404).send({ error: 'File not found' });
    }
    return { ok: true };
  });

  // Bulk delete — one request removes many paths. Clients batch a folder's
  // worth of deletions into a single call here so the server (and any firewall
  // rate limiter in front of it) sees one request instead of hundreds.
  fastify.post('/api/files/delete', async (request, reply) => {
    const body = request.body || {};
    const paths = Array.isArray(body.paths) ? body.paths : null;
    if (!paths) {
      return reply.code(400).send({ error: 'Body must be { "paths": [ ... ] }' });
    }

    let deleted = 0;
    let missing = 0;
    for (const p of paths) {
      if (typeof p !== 'string' || !p) continue;
      // Don't pass the per-file log here — we summarize below to avoid flooding.
      if (deleteOne(p, request.ip, null)) deleted += 1;
      else missing += 1;
    }

    request.log.info(
      { action: 'bulk-delete', requested: paths.length, deleted, missing, ip: request.ip },
      'bulk delete'
    );

    return { ok: true, deleted, missing };
  });
}

module.exports = deleteRoute;
