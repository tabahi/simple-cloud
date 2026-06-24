'use strict';

const { listBackups, getBackupStream, clearAllBackups, resolveLogicalFilename } = require('../backupService');

async function backupsRoute(fastify, _opts) {
  // List all backups grouped by date, with each backup's resolved logical path.
  fastify.get('/api/backups', async (_request, _reply) => {
    return { backups: listBackups() };
  });

  // Download a single backup blob by its opaque id ("<date>/<storageId>.<date>.bk").
  fastify.get('/api/backup', async (request, reply) => {
    const id = request.query.id;
    if (!id) {
      return reply.code(400).send({ error: 'Missing id query parameter' });
    }
    const stream = getBackupStream(id);
    if (!stream) {
      return reply.code(404).send({ error: 'Backup not found' });
    }
    const filename = resolveLogicalFilename(id);
    request.log.info({ action: 'backup-download', id, ip: request.ip }, 'backup downloaded');
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(stream);
  });

  // Clear ALL backups on the server.
  fastify.delete('/api/backups', async (request, _reply) => {
    const removed = clearAllBackups(request.log);
    request.log.warn({ action: 'backups-clear', removed, ip: request.ip }, 'all backups cleared');
    return { ok: true, removedDateDirs: removed };
  });
}

module.exports = backupsRoute;
