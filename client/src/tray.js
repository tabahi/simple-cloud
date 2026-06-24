'use strict';

const { exec, spawn } = require('child_process');
const path = require('path');
const logger = require('./logger');
const sync = require('./sync');
const backups = require('./backups');

const ICON_BASE64 = require('fs').readFileSync(path.join(__dirname, 'icon.ico')).toString('base64');

// Array indices into menuItems[] — used by updateItem()
const ITEM_STATUS = 0;
const ITEM_LAST_SYNCED = 1;

// Flat seq_ids across the full tree (submenu children count toward the index).
// Layout:
//   0  Status           seq 0
//   1  Last synced      seq 1
//   2  <SEP>            seq 2
//   3  Sync now         seq 3
//   4  Open folder      seq 4
//   5  <SEP>            seq 5
//   6  Backups          seq 6  (parent)
//        Download       seq 7
//        Clear          seq 8
//   7  Options          seq 9  (parent)
//        View logs      seq 10
//        Edit .env      seq 11
//        Restart        seq 12
//   8  <SEP>            seq 13
//   9  Quit             seq 14
const SEQ_SYNC_NOW    = 3;
const SEQ_OPEN_FOLDER = 4;
const SEQ_QUIT        = 14;

// Submenu items matched by unique title (avoids fragile seq indexing).
const TITLE_DOWNLOAD_BACKUPS = 'Download simplecloud-backups';
const TITLE_CLEAR_BACKUPS    = 'Clear all backups (server + local)';
const TITLE_VIEW_LOGS        = 'View logs';
const TITLE_EDIT_ENV         = 'Edit .env';
const TITLE_RESTART          = 'Restart';

let _tray   = null;
let _config = null;
let _backupBusy = false;

const menuItems = [
  { title: 'Sync status: Idle',   tooltip: '', enabled: false, checked: false },
  { title: 'Last synced: never',  tooltip: '', enabled: false, checked: false },
  { title: '<SEPARATOR>',         tooltip: '', enabled: false, checked: false },
  { title: 'Sync now',            tooltip: 'Run a sync immediately', enabled: true, checked: false },
  { title: 'Open sync folder',    tooltip: 'Open in Explorer',        enabled: true, checked: false },
  { title: '<SEPARATOR>',         tooltip: '', enabled: false, checked: false },
  {
    title: 'Backups',
    tooltip: 'View and manage server backups',
    enabled: true,
    checked: false,
    items: [
      { title: TITLE_DOWNLOAD_BACKUPS, tooltip: 'Download all backups into the sync folder',      enabled: true, checked: false },
      { title: TITLE_CLEAR_BACKUPS,    tooltip: 'Delete all backups on the server and locally', enabled: true, checked: false },
    ],
  },
  {
    title: 'Options',
    tooltip: 'Settings and tools',
    enabled: true,
    checked: false,
    items: [
      { title: TITLE_VIEW_LOGS, tooltip: 'Open the latest log file in Notepad', enabled: true, checked: false },
      { title: TITLE_EDIT_ENV,  tooltip: 'Open .env config file in Notepad',    enabled: true, checked: false },
      { title: TITLE_RESTART,   tooltip: 'Restart the sync client',              enabled: true, checked: false },
    ],
  },
  { title: '<SEPARATOR>', tooltip: '', enabled: false, checked: false },
  { title: 'Quit',        tooltip: 'Exit simplecloudClient', enabled: true, checked: false },
];

async function startTray(config) {
  _config = config;

  if (process.platform !== 'win32') {
    logger.info('Non-Windows platform — tray icon disabled');
    return { setStatus, setLastSynced };
  }

  let SysTray;
  try {
    SysTray = require('systray2').default || require('systray2');
  } catch (e) {
    logger.warn('systray2 not available, running without tray icon');
    return { setStatus, setLastSynced };
  }

  try {
    _tray = new SysTray({
      menu: {
        icon: ICON_BASE64,
        title: 'simplecloud',
        tooltip: 'File Sync Client',
        items: menuItems,
      },
      debug: false,
      copyDir: true,
    });
  } catch (e) {
    logger.warn(`Tray icon failed to start: ${e.message} — running without tray`);
    return { setStatus, setLastSynced };
  }

  try {
    await _tray.onClick(action => {
      const seq          = action.seq_id;
      const clickedTitle = action.item && action.item.title;

      // Submenu items matched by title.
      if (clickedTitle === TITLE_DOWNLOAD_BACKUPS) { runDownloadBackups(); return; }
      if (clickedTitle === TITLE_CLEAR_BACKUPS)    { runClearBackups();    return; }
      if (clickedTitle === TITLE_VIEW_LOGS)        { openLogFile();        return; }
      if (clickedTitle === TITLE_EDIT_ENV)         { openEnvFile();        return; }
      if (clickedTitle === TITLE_RESTART)          { restartClient();      return; }

      if (seq === SEQ_SYNC_NOW) {
        logger.info('Manual sync triggered from tray');
        setStatus('Syncing...');
        sync.runSync()
          .then(() => setStatus('Idle'))
          .catch(err => { logger.error(`Manual sync failed: ${err.message}`); setStatus('Idle'); });
      } else if (seq === SEQ_OPEN_FOLDER) {
        exec(`explorer "${_config.syncFolder}"`);
      } else if (seq === SEQ_QUIT) {
        logger.info('Quit requested from tray');
        if (_tray) _tray.kill();
        process.exit(0);
      }
    });

    _tray.onError(err => {
      logger.error(`Tray error: ${err}`);
    });
  } catch (e) {
    logger.warn(`Tray event wiring failed: ${e.message} — running without tray`);
    _tray = null;
    return { setStatus, setLastSynced };
  }

  return { setStatus, setLastSynced };
}

// Show a native Windows message box. type: 'info' | 'warn' | 'yesno'.
// Returns a promise resolving to true (OK/Yes) or false (No/Cancel).
function messageBox(message, title, type) {
  return new Promise((resolve) => {
    const buttons = type === 'yesno' ? 4 : 0;
    const icon    = type === 'warn' || type === 'yesno' ? 48 : 64;
    const esc = (s) => s.replace(/'/g, "''");
    const ps =
      `Add-Type -AssemblyName PresentationFramework; ` +
      `$r=[System.Windows.MessageBox]::Show('${esc(message)}','${esc(title)}',${buttons},${icon}); ` +
      `if($r -eq 'Yes' -or $r -eq 'OK'){exit 0}else{exit 1}`;
    exec(`powershell -NoProfile -WindowStyle Hidden -Command "${ps}"`, (err) => {
      resolve(!err);
    });
  });
}

function openLogFile() {
  const { LOG_DIR } = require('./logger');
  const fs = require('fs');
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => f.startsWith('sync-') && f.endsWith('.log'))
    .sort()
    .pop();
  exec(`notepad "${path.join(LOG_DIR, files || 'sync.log')}"`);
}

function openEnvFile() {
  const { ENV_FILE } = require('./config');
  exec(`notepad "${ENV_FILE}"`);
}

function restartClient() {
  logger.info('Restart requested from tray');
  spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  }).unref();
  if (_tray) _tray.kill();
  process.exit(0);
}

async function runDownloadBackups() {
  if (_backupBusy) return;
  _backupBusy = true;
  setStatus('Downloading backups...');
  try {
    const r = await backups.downloadAllBackups(_config.syncFolder);
    setStatus('Idle');
    const msg = r.total === 0
      ? 'No backups found on the server.'
      : `Downloaded ${r.downloaded} of ${r.total} backup(s) into:\n${r.root}` +
        (r.failed ? `\n\n${r.failed} failed — see the log.` : '');
    await messageBox(msg, 'simplecloud — backups', 'info');
    if (r.total > 0) exec(`explorer "${r.root}"`);
  } catch (e) {
    logger.error(`Backup download failed: ${e.message}`);
    setStatus('Idle');
    await messageBox(`Backup download failed:\n${e.message}`, 'simplecloud — backups', 'warn');
  } finally {
    _backupBusy = false;
  }
}

async function runClearBackups() {
  if (_backupBusy) return;
  const ok = await messageBox(
    'Delete ALL backups on the server and the local simplecloud-backups folder?\n\nThis cannot be undone.',
    'simplecloud — clear backups',
    'yesno'
  );
  if (!ok) return;

  _backupBusy = true;
  setStatus('Clearing backups...');
  try {
    const r = await backups.clearAllBackups(_config.syncFolder);
    setStatus('Idle');
    await messageBox(
      `Cleared ${r.serverRemovedDateDirs} backup folder(s) on the server` +
        (r.localRemoved ? ' and the local copy.' : '.'),
      'simplecloud — clear backups',
      'info'
    );
  } catch (e) {
    logger.error(`Clear backups failed: ${e.message}`);
    setStatus('Idle');
    await messageBox(`Clear backups failed:\n${e.message}`, 'simplecloud — clear backups', 'warn');
  } finally {
    _backupBusy = false;
  }
}

function updateItem(index, title) {
  if (!_tray) return;
  menuItems[index].title = title;
  _tray.sendAction({ type: 'update-item', item: menuItems[index] });
}

function setStatus(status) {
  updateItem(ITEM_STATUS, `Sync status: ${status}`);
}

function setLastSynced(ts) {
  updateItem(ITEM_LAST_SYNCED, `Last synced: ${ts}`);
}

module.exports = { startTray, setStatus, setLastSynced };
