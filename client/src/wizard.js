'use strict';

const { exec } = require('child_process');
const fs = require('fs');

// Windows-only helpers. All functions use PowerShell to show native dialogs.

const esc = s => String(s).replace(/'/g, "''");

// Show a VB InputBox. Returns Promise<string> — empty string means blank/Cancel.
function inputBox(prompt, title, defaultValue) {
  const ps =
    `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
    `$r=[Microsoft.VisualBasic.Interaction]::InputBox('${esc(prompt)}','${esc(title)}','${esc(defaultValue)}'); ` +
    `Write-Output $r`;
  return new Promise(resolve => {
    exec(`powershell -NoProfile -WindowStyle Hidden -Command "${ps}"`, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// Show a native MessageBox. type: 'info' | 'warn' | 'yesno'.
// Returns Promise<boolean> (true = OK/Yes).
function messageBox(message, title, type) {
  const buttons = type === 'yesno' ? 4 : 0;
  const icon    = type === 'warn' ? 48 : 64;
  const ps =
    `Add-Type -AssemblyName PresentationFramework; ` +
    `$r=[System.Windows.MessageBox]::Show('${esc(message)}','${esc(title)}',${buttons},${icon}); ` +
    `if($r -eq 'Yes' -or $r -eq 'OK'){exit 0}else{exit 1}`;
  return new Promise(resolve => {
    exec(`powershell -NoProfile -WindowStyle Hidden -Command "${ps}"`, (err) => {
      resolve(!err);
    });
  });
}

// Walk the user through the three required config fields via sequential dialogs.
// defaults: partial config values to pre-fill (may be empty strings).
// defaultSyncFolder: platform default for the sync folder.
// Returns { serverUrl, token, syncFolder } or null if user cancels.
async function runWizard(defaults, defaultSyncFolder) {
  const welcomed = await messageBox(
    'simple-cloud needs to be configured before it can start.\n\nClick OK to set it up now, or Cancel to quit.',
    'simple-cloud Setup',
    'yesno'
  );
  if (!welcomed) return null;

  // Server URL
  let serverUrl = '';
  let urlPrompt = 'Enter the server URL shown by setup.sh\n(e.g. https://yourserver:11277):';
  while (!serverUrl) {
    const val = await inputBox(urlPrompt, 'simple-cloud Setup', defaults.serverUrl || 'https://');
    if (val === null) return null;
    serverUrl = val.trim().replace(/\/+$/, '');
    if (!serverUrl) urlPrompt = 'Server URL is required.\n\nEnter the server URL (e.g. https://yourserver:11277):';
  }

  // Token
  let token = '';
  let tokenPrompt = 'Enter the signing key from the server.\n(On the server: cat /opt/scserver/config/token.txt)\nThis key signs requests and is never sent on the wire.';
  while (!token) {
    const val = await inputBox(tokenPrompt, 'simple-cloud Setup', defaults.token || '');
    if (val === null) return null;
    token = val.trim();
    if (!token) tokenPrompt = 'Signing key is required.\n\nEnter the signing key from the server:';
  }

  // Sync folder
  let syncFolder = '';
  let folderPrompt = 'Local folder to sync:';
  while (!syncFolder) {
    const val = await inputBox(folderPrompt, 'simple-cloud Setup', defaults.syncFolder || defaultSyncFolder);
    if (val === null) return null;
    syncFolder = val.trim();
    if (!syncFolder) folderPrompt = 'Sync folder is required.\n\nLocal folder to sync:';
  }

  return { serverUrl, token, syncFolder };
}

// Write an .env file by substituting the three config lines in envTemplate.
function writeEnvFile(envFile, envTemplate, { serverUrl, token, syncFolder }) {
  const content = envTemplate
    .replace(/^SC_SERVER_URL=.*/m, `SC_SERVER_URL=${serverUrl}`)
    .replace(/^SC_TOKEN=.*/m, `SC_TOKEN=${token}`)
    .replace(/^SC_SYNC_FOLDER=.*/m, `SC_SYNC_FOLDER=${syncFolder}`);
  fs.writeFileSync(envFile, content, 'utf8');
}

module.exports = { runWizard, writeEnvFile };
