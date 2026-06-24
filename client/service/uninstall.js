'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const vbsDest = path.join(
  process.env.APPDATA,
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
  'simple-cloud-client.vbs'
);

// Kill any running instance
try {
  execSync('taskkill /F /IM node.exe /FI "WINDOWTITLE eq simplecloud*"', { stdio: 'ignore' });
} catch (_) {}

if (fs.existsSync(vbsDest)) {
  fs.unlinkSync(vbsDest);
  console.log('Startup entry removed.');
} else {
  console.log('No startup entry found — nothing to remove.');
}
