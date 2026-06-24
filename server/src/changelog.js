'use strict';

const fs = require('fs');
const path = require('path');
const { filechangeLogs, logDir } = require('./config');

const LOG_PATH = filechangeLogs || path.join(logDir, 'changes.log');

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

function append(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(LOG_PATH, line, 'utf8');
}

function logUpload({ filePath, fileName, storageId, hash, size, ip }) {
  append({ action: 'upload', path: filePath, fileName, storageId, hash, size, ip });
}

function logReplace({ filePath, fileName, storageId, hash, size, tempPath, ip }) {
  append({ action: 'replace', path: filePath, fileName, storageId, hash, size, tempPath, ip });
}

function logDelete({ filePath, storageId, ip }) {
  append({ action: 'delete', path: filePath, fileName: filePath.split('/').pop(), storageId, ip });
}

module.exports = { logUpload, logReplace, logDelete };
