'use strict';

// Shared file-store helper used by both the HTTP upload route and the
// Discord bot. Encapsulates the save/replace → db upsert → changelog flow so
// callers don't duplicate it.

const { saveFile, replaceFile } = require('./storage');
const { upsertFile, getFile } = require('./db');
const changelog = require('./changelog');
const { notifyChanged } = require('./events');

// Store a buffer at the given logical path. If the path already exists the
// blob is overwritten in place (storageId stays stable); otherwise a new blob
// is created. Returns { path, storageId, hash, size, replaced }.
async function storeBuffer({ filePath, fileName, buffer, source }) {
  const now = new Date().toISOString();
  const existing = getFile(filePath);

  let storageId, hash, size, replaced;

  if (existing) {
    let tempPath;
    ({ hash, size, tempPath } = await replaceFile(existing.storage_id, buffer));
    storageId = existing.storage_id;
    replaced = true;
    changelog.logReplace({ filePath, fileName, storageId, hash, size, tempPath, ip: source });
  } else {
    ({ storageId, hash, size } = await saveFile(buffer));
    replaced = false;
    changelog.logUpload({ filePath, fileName, storageId, hash, size, ip: source });
  }

  upsertFile({ path: filePath, storage_id: storageId, hash, size, modified_at: now });
  notifyChanged();

  return { path: filePath, storageId, hash, size, replaced };
}

module.exports = { storeBuffer };
