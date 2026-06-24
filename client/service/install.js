'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const indexJs = path.resolve(__dirname, '..', 'src', 'index.js');
const nodeExe = process.execPath; // absolute path to the node.exe that ran this script

const startupDir = path.join(
  process.env.APPDATA,
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
);
const vbsDest = path.join(startupDir, 'simplecloudClient.vbs');

// Generate VBScript with absolute paths baked in
const vbsContent = `Set objShell = CreateObject("WScript.Shell")
objShell.Run """${nodeExe}"" ""${indexJs}""", 0, False
`;

fs.writeFileSync(vbsDest, vbsContent, 'utf8');

// Launch it now
execSync(`wscript.exe "${vbsDest}"`, { stdio: 'ignore' });

console.log('simplecloudClient installed.');
console.log(`Startup entry: ${vbsDest}`);
console.log('The tray icon should appear momentarily. It will auto-start on every login.');
