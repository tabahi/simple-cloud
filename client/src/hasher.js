'use strict';

const fs = require('fs');
const crypto = require('crypto');

// Hash a file on disk using SHA-256 (must match server algorithm)
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Hash a Buffer directly
function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = { hashFile, hashBuffer };
