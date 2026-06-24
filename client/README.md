# simple-cloud client

Node.js sync client, runs on **Windows** (with system tray icon) and **Linux** (headless).

## Windows, install

> The simple-cloud **server** must already be running first. See the [server setup guide](../README.md#server-setup-linux) if it isn't.

### Step 1, Install Node.js (skip if already installed)

Download and run the installer from [nodejs.org](https://nodejs.org/) (LTS version, click through with all defaults).

### Step 2, Get your token from the server

SSH into your server and run:

```bash
cat /opt/scserver/config/token.txt
```

Copy that long hex string, you'll paste it in a moment.

### Step 3, Run the installer

Open **PowerShell** (press `Win + X` → *Terminal* or search "PowerShell" in Start) and paste:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
irm https://raw.githubusercontent.com/tabahi/simple-cloud/refs/heads/main/client/setup.ps1 | iex
```

The script downloads simple-cloud, installs dependencies, and launches the app. Three setup dialogs appear:

- **Server URL**: the full address of your server, e.g. `https://yourserver.com:11277`
- **Signing key**: paste the key from Step 2
- **Sync folder**: the local folder to keep in sync (default `C:\simplecloudData` is fine)

### Step 4, Done

A tray icon appears in your system tray (bottom-right corner, or the `^` overflow). Files in your sync folder stay in sync with the server. The client starts on every login automatically.

> **Already have the repo downloaded?** Double-click `setup.bat` in the `client/` folder instead, it does the same thing without downloading.

## Linux, quick install

> The simple-cloud **server** must already be running first.

```bash
# from the client/ folder
npm install
node src/index.js
```

The first run creates `~/.config/simplecloud/.env` and exits. Open it, fill in `SC_SERVER_URL` and `SC_TOKEN` (token is at `/opt/scserver/config/token.txt` on the server), then run again:

```bash
node src/index.js
```

For auto-start see [Auto-start on Linux (systemd)](#auto-start-on-linux-systemd) below.

## Platform support

| Feature | Windows | Linux |
| --- | --- | --- |
| File sync (core) | Yes | Yes |
| Real-time watcher | Yes | Yes |
| `.ignore` file | Yes | Yes |
| System tray icon | Yes | No (headless) |
| Auto-start on login | Yes, `setup.bat` handles it | No, use systemd or cron |

## Configuration

Settings live in a **`.env`** file in the platform config directory:

**Windows:** `%APPDATA%\simplecloud\.env` (written by the setup wizard)
**Linux:** `~/.config/simplecloud/.env`

```bash
SC_SERVER_URL=https://your-server:24900
SC_TOKEN=PASTE_TOKEN_HERE
SC_SYNC_FOLDER=C:\simplecloudData
SC_SYNC_INTERVAL_SECONDS=300
SC_LOG_LEVEL=info
SC_IGNORE_SSL_ERRORS=false
SC_LARGE_FILE_LAZY_SYNC_MB=100
SC_LARGE_FILE_IGNORE_MB=500
```

`.env` is gitignored, so your server URL and token never get committed. A tracked [`.env.example`](.env.example) documents every variable. Any variable already set in your environment overrides the file.

To re-run the wizard (e.g. to change the server URL), delete or blank `SC_SERVER_URL` in the `.env` and restart the app.

Get the token from the server:

```bash
cat /opt/scserver/config/token.txt
```

### Config options

| Variable | Default | Description |
| --- | --- | --- |
| `SC_SERVER_URL` |, | Full URL of the simple-cloud server (required) |
| `SC_TOKEN` |, | Signing key from the server (required) — used for HMAC request signing, never sent on the wire |
| `SC_SYNC_FOLDER` | `C:\simplecloudData` / `~/simplecloudData` | Local folder to sync |
| `SC_SYNC_INTERVAL_SECONDS` | `300` | Fallback poll interval in seconds, SSE push handles real-time changes; this fires as a safety net when the stream is reconnecting |
| `SC_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `SC_IGNORE_SSL_ERRORS` | `false` | Skip SSL verification (expired cert workaround) |
| `SC_LARGE_FILE_LAZY_SYNC_MB` | `100` | Files above this size skip real-time sync, wait for next poll |
| `SC_LARGE_FILE_IGNORE_MB` | `500` | Files above this size are never synced |

## .ignore file

Drop a `.ignore` file in the root of your sync folder to exclude files and directories. Uses gitignore-style glob patterns:

```gitignore
# Compiled Python
__pycache__/
*.pyc

# Build output
/dist/
*.tmp
```

Patterns are reloaded automatically on each sync cycle, no restart needed.

## Secure locked folder

The client creates the secure folder (named by the server's `SC_LOCKED_FOLDER_NAME`, e.g. `.simplecloud_locked`, inside your sync folder) once it has synced with the server. Files you place there can be **locked** and **unlocked** from the server's Discord bot:

- Send `lock <password>` to the bot → the server encrypts those files into a password-protected archive and removes them. The folder disappears from this client (local plaintext copies are deleted).
- Send `unlock <password>` to the bot → the files are restored and re-downloaded on the next sync.

While locked, nothing in that folder exists in plaintext anywhere, only the server's encrypted `.7z`. The client never re-uploads locked files; it mirrors whatever the server's manifest shows.

> The **server** owns the folder name: the client discovers it via `/api/lock-status`, so it's configured only on the server (`SC_LOCKED_FOLDER_NAME`), there is no client-side setting. The password is handled entirely on the server and is never sent to or stored on the client.

## Backups (view & restore)

The server keeps two kinds of backups you can pull down:

- **Overwrite backups**: the previous version of a file, kept before each overwrite.
- **Deleted files**: every deleted file is moved to a server-side recycle bin before removal.

Downloaded into your sync folder under:

```text
<syncFolder>/simplecloud-backups/<YYYY-MM-DD>/<original/relative/path>            ← overwrite backups
<syncFolder>/simplecloud-backups/deletions/<YYYY-MM-DD>/<original/relative/path>  ← deleted files
```

Each backup is filed under the date it was taken. The whole **`simplecloud-backups/` folder is excluded from sync**, downloading or browsing it never uploads anything.

**Windows (tray):** right-click the tray icon → **Backups** →

- **Download simplecloud-backups**: downloads everything into the folder above and opens it.
- **Clear all backups (server + local)**: deletes every backup on the server *and* the local `simplecloud-backups/` folder. Asks for confirmation first.

**Linux / headless (CLI):**

```bash
node src/backups.js download   # download all backups into simplecloud-backups/
node src/backups.js clear       # delete all backups on the server and locally
```

To restore a file, copy the version you want out of `simplecloud-backups/<date>/...` back to its place in the sync folder; it uploads on the next sync.

> **Clearing is irreversible.** It wipes all server-side backups and the recycle bin (live files are untouched) and removes the local `simplecloud-backups/` copy.

## Running

```bash
node src/index.js
```

Press `Ctrl+C` to stop. On Windows a tray icon appears; on Linux sync runs headlessly and logs to the console and log file.

## Auto-start on Windows

**`setup.bat` handles this automatically**, it installs the startup entry and launches the app. You only need the manual method below if you skipped `setup.bat`.

Manual install (no Administrator required):

```cmd
node service\install.js
```

This writes a VBScript to your Startup folder that launches Node invisibly on every login. The tray icon appears in the system tray.

Uninstall:

```cmd
node service\uninstall.js
```

> **Windows-only.** For Linux, use systemd or cron, see below.

## Auto-start on Linux (systemd)

Create `/etc/systemd/system/simple-cloud-client.service`:

```ini
[Unit]
Description=simple-cloud client
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/client/src/index.js
Restart=on-failure
User=youruser
Environment=HOME=/home/youruser

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now simple-cloud-client
```

## Logs

**Windows:** `%APPDATA%\simplecloud\logs\sync-YYYY-MM-DD.log`
**Linux:** `~/.config/simplecloud/logs/sync-YYYY-MM-DD.log`

Rolling log: 5 MB per file, 3 files kept. On Windows the tray menu also has **Open log file** to open the current log in Notepad.

## Sync behaviour

- **SSE push**: the client keeps a persistent HTTP connection open to `/api/events`. Whenever a file is uploaded or deleted on the server, a `changed` notification is pushed and a full diff runs within ~1 second. The connection reconnects with exponential backoff (2 s → 64 s) if it drops.
- **Fallback poll**: every `SC_SYNC_INTERVAL_SECONDS` seconds (default 5 min) a full diff also runs, catches any changes that arrived while the SSE stream was reconnecting.
- **Real-time local watcher**: chokidar triggers an immediate upload on any file add or change.
- **Serial upload queue**: every upload goes through one queue, processed one file at a time, the server never sees concurrent uploads from a client.
- **Rate-limit backoff**: if an upload times out or the connection drops, the queue pauses for **30 seconds**, then retries the same file. Nothing is dropped; queued files just wait. Uploads have a 30s request timeout. On Windows, the tray status shows **"Paused (rate-limited)"** during the backoff.
- **Conflict resolution**: the side with the newer modification timestamp wins.
- **Deletion propagation**: local deletes are recorded and sent to the server. Files that disappear locally without being explicitly deleted are re-downloaded (server wins).
- **Batched deletes**: deleting a whole folder fires one event per file. Instead of sending one request per file, deletes are **collected for 5 seconds** and then sent as **one bulk request**. If that request is rate-limited, the queue pauses 30 seconds and retries the same batch.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `SC_TOKEN is not set` | Paste the server token into `.env` |
| `Authentication error` | `SC_TOKEN` in `.env` doesn't match the server's `token.txt` |
| `ECONNREFUSED` | Server is down or `serverUrl` is wrong |
| Files not syncing | Check `syncFolder` in config matches the folder you're editing |
| Tray icon missing | Expected on Linux, sync still runs. On Windows check the system tray overflow area |

## Windows-specific files

| File | Purpose |
| --- | --- |
| `src/tray.js` | System tray icon, skipped automatically on non-Windows |
| `service/install.js` | Writes a startup VBScript and launches the client |
| `service/uninstall.js` | Removes the startup entry |
| `service/launch.vbs` | Template (not used directly, install.js generates the final VBScript) |
