# simplecloud — context for coding sessions

> Compressed map of this codebase. Skim this first, then open only the files your task touches. The codebase is fully implemented. When you change architecture, update the relevant line here in the same commit.

## What it is

Self-hosted, Dropbox-style bidirectional file sync. CommonJS Node.js throughout (no ESM, no TypeScript, no build step).

- **Server**: Fastify app on a Linux VPS, normally behind nginx/Caddy that terminates SSL. Binds `127.0.0.1:SC_PORT` (default `11277`). State lives in SQLite + flat blob files on disk.
- **Client**: Node CLI. Windows (system-tray icon, auto-start via a Startup-folder VBScript) and Linux (headless). Watches a folder and bidirectionally syncs it.
- **Two optional interfaces** (both off by default): a **Discord bot** (mobile/remote browsing + lock control) and a **web UI** (full management in a browser, password + TOTP 2FA).

**Config is `.env`-only** on both sides (via `dotenv`, all `SC_*` vars). No JSON config files. `.env` is gitignored; `.env.example` is committed; `server/setup.sh` writes `server/.env`.

## Dependencies

Everything is pure-JS **except**:

- **`better-sqlite3`** (server) — a native/compiled addon. Installs from a prebuilt binary on common Linux/Node combos; needs build tools otherwise.
- **`p7zip-full`** (server, system package, installed by `setup.sh`) — provides the `7z` binary for the locked-folder feature.

All crypto (token, TOTP, scrypt, HMAC sessions, SHA-256) uses Node's built-in `crypto`. Server npm deps: fastify ^4, @fastify/{multipart ^8, static ^6, cookie ^9}, better-sqlite3 ^9, discord.js ^14, dotenv ^16, pino ^8, pino-roll ^1, mime-types ^2, uuid ^9. Client npm deps: chokidar ^3, dotenv ^16, systray2 ^2, winston ^3, winston-daily-rotate-file ^4, form-data ^4, node-fetch ^2 (pinned `^2` — v3 is ESM-only).

## Repo map

```text
server/src/
  index.js          Fastify entry. validateWebConfig() fails closed; registers cookie+static+web route only when web.enabled; schedules cleanup; starts discord bot (caught so it can't crash the server)
  config.js         loads server/.env → SC_* vars; derives logFile/dbPath. Nested ssl/discord/web blocks
  auth.js           onRequest hook: authorizes EITHER HMAC-signed request (clients+bot — token never on wire; X-SC-Timestamp/Nonce/Signature headers, ±60s clock skew, in-memory nonce dedup) OR a web session cookie (browser, when web.enabled). CSRF on cookie writes. isPublic() bypass = health + web login + static assets
  db.js             better-sqlite3 (WAL). files table: path↔storage_id↔hash↔size↔modified_at
  storage.js        blob I/O (UUID filenames), SHA-256. backupBlob() = pre-overwrite copy to tempDir/<date>/. recycleDeletedBlob() = copy to tempDir/deletions/<date>/<logical-path> before a delete (recycle bin)
  fileService.js    storeBuffer(): shared save/replace → db upsert → changelog → notifyChanged(). Used by upload route + discord bot + lockService unlock
  events.js         in-process EventEmitter + debounced notifyChanged() (200 ms). Emitted by fileService + delete route; consumed by SSE clients in routes/events.js
  lockService.js    secure folder: lock(pw)/unlock(pw) via 7z (-mhe=on hides filenames). isLocked() is DERIVED (archive exists AND no manifest rows under prefix), never stored. Password only ever a 7z arg
  backupService.js  list/stream/clear of BOTH overwrite-backups (tempDir/<date>/<uuid>.<date>.bk, name resolved via db→changelog→uuid) AND recycled deletions (tempDir/deletions/<date>/<path>, group.deleted=true). Path-traversal guarded
  cleanup.js        daily purge of date-dirs older than backupRetentionDays, in tempDir/<date>/ AND tempDir/deletions/<date>/
  changelog.js      append-only JSONL of uploads/replaces/deletes (filechangeLogs path)
  web/              [OPTIONAL web UI — off by default]
    totp.js         RFC 6238 TOTP (verify/generate/secret/otpauth URL). Zero deps, Node crypto. Verified vs RFC vectors
    webSession.js   scrypt password hash/verify, HMAC-signed in-memory sessions, login rate-limiter (5 fails/IP → 15min lockout), CSRF tokens
    setupWeb.js     CLI for setup.sh: password on stdin → prints SC_WEB_PASSWORD_HASH/SESSION_SECRET/TOTP_SECRET + #OTPAUTH url. No config/dotenv dep (runs before npm install)
  discord/bot.js    [OPTIONAL] discord.js v14. Slash: /list (one dir) /tree (depth-limited) /search (full path) /find (filename) /get /status. Text: "lock <pw>"/"unlock <pw>" (msg deleted to scrub pw). Attachment ingest → discord_files/. In-process (shares db/storage directly)
  routes/
    health.js       GET /api/health (no auth)
    events.js       GET /api/events SSE stream. reply.hijack() keeps connection open; emits 'changed' per notifyChanged(); ping comment every 30 s; listeners removed on close
    manifest.js     GET /api/manifest → all files
    upload.js       POST /api/upload (multipart path+file)
    download.js     GET /api/download?path=
    delete.js       DELETE /api/file?path= (single) + POST /api/files/delete (bulk). Both recycle before removing, then call notifyChanged()
    deletions.js    GET /api/deletions?since= (delete-propagation feed)
    lockStatus.js   GET /api/lock-status → { locked, prefix }
    backups.js      GET /api/backups (list) + GET /api/backup?id= (one) + DELETE /api/backups (clear all)
    web.js          [OPTIONAL] POST /api/web/login (password+TOTP→cookie) /logout, GET /api/web/config (totpRequired) + /api/web/session (csrf). Registered only when web.enabled
    log.js          GET /api/log?lines=N
server/web/         [OPTIONAL] static frontend (index.html+app.js+style.css), vanilla JS over /api/*, served by @fastify/static. No build step
server/config/token.txt   auto-generated 32-byte hex signing token (gitignored)
server/setup.sh     interactive 7-step wizard → writes server/.env, installs p7zip-full, npm install, generates token, PM2 start. Web step hashes password + auto-generates TOTP + prints otpauth QR. Has --uninstall

client/src/
  index.js          loads config, starts tray + watcher + SSE listener + fallback poll. SSE triggers runSync() on 'changed' event with exponential-backoff reconnect (2 s → 64 s); fallback poll every syncIntervalSeconds (default 300 s)
  config.js         async loadConfig(): loads/creates .env in platform config dir (SC_* vars), validates token. On Windows, missing/incomplete config triggers wizard.js instead of exiting. SC_SYNC_INTERVAL_SECONDS defaults to 300 (fallback poll; SSE handles real-time)
  wizard.js         [WINDOWS] first-run GUI wizard: PowerShell VB InputBox prompts for serverUrl/token/syncFolder, writes .env. Called by config.js when .env is absent or required fields are blank
  logger.js         winston: console + DailyRotateFile
  hasher.js         SHA-256 (matches server)
  api.js            fetchManifest/uploadFile/downloadFile/deleteRemoteFile/deleteRemoteFiles(bulk)/connectEventStream. 30s timeout; timeout/ECONN* → code:'RATE_LIMIT'. No internal retry (queues own it). connectEventStream uses raw http/https (not node-fetch) for streaming SSE; reuses _agent for SSL-ignore
  uploadQueue.js    single serial upload queue (dedup by rel). One at a time; on rate-limit pause 30s + retry SAME file (max 10)
  deleteQueue.js    debounced batched deletes: collect 5s (each delete resets timer) → ONE bulk POST. Rate-limit → pause 30s + retry SAME batch
  sync.js           bidirectional diff loop, .ignore matching, size filters, deleted.json. Marks self-writes so watcher ignores them
  selfWrites.js     expiry-window map: sync mark()s files it writes/deletes; watcher consume()s to skip the event (breaks download→re-upload loop)
  watcher.js        chokidar (500ms debounce). Skips ignored paths + self-writes + simplecloud-backups/
  backups.js        download all backups → <syncFolder>/simplecloud-backups/<date>/<path> (deletions under /deletions/). clear (server+local). CLI: node src/backups.js download|clear
  tray.js           [WINDOWS] systray2. Backups submenu; "Paused (rate-limited)" status; PowerShell MessageBox confirms
  service/          [WINDOWS] auto-start: install.js writes a Startup VBScript (NOT node-windows — services run as SYSTEM and break systray2)
client/setup.bat    [WINDOWS] double-click installer for users who already have the repo: checks Node.js, npm install, runs service/install.js
client/setup.ps1    [WINDOWS] one-liner remote installer (irm URL | iex): downloads the repo zip, npm install, runs service/install.js. First-run wizard fires automatically after launch
```

## Key decisions

| Topic | What & why |
| --- | --- |
| Blobs are flat UUIDs | path↔UUID mapping lives in SQLite; avoids path-traversal in storage. Resolve names via db, fall back to changelog |
| Conflict resolution | last-modified-at wins (`stat.mtimeMs` vs server `modified_at`). Simple, deterministic |
| Rate limit is at the FIREWALL | The server is throttled upstream — it DROPS the connection (no 4xx). So the client treats a 30s `node-fetch` timeout / ECONN* as `RATE_LIMIT` → back off 30s |
| All uploads serialized | `uploadQueue` — poll-loop + watcher both enqueue; never concurrent. Dedup by rel. `runSync` doesn't await uploads (background) |
| All deletes batched | `deleteQueue` — folder delete = many unlinks; collect 5s → ONE bulk request, so the firewall isn't tripped. `markDeleted` still immediate so the file isn't re-downloaded |
| Watcher ignores self-writes | `selfWrites` expiry-window map (5s). Without it, a downloaded file re-fires `add`→re-upload (feedback loop). Expiry (not delete-on-first) so a download's add+change are both suppressed |
| Secure folder name is SERVER-only | Client has NO setting; it learns the prefix from `/api/lock-status`. Until known, ALL secure-folder logic is skipped — no client/server mismatch possible |
| Client deletes locked files ONLY when server says `locked:true` | Removed without a `deleted.json` entry (so unlock restores them) and never re-uploaded. lockService deletes rows/blobs directly (not via the route) so locked paths never enter the deletions feed |
| Deletions are recoverable | recycle bin = backups: same `backupRetentionDays` expiry, same clear-all, same size cap, downloadable to clients under `simplecloud-backups/deletions/` |
| Web UI keeps the token out of the browser | Browser auth is a SEPARATE path (password+TOTP → HttpOnly+Secure+SameSite=Strict cookie). authPlugin accepts HMAC-signed requests OR a session cookie. CSRF on cookie writes. Fail-closed: web on + TOTP on + no secret → server won't start |
| Discord/web are off by default | Discord: empty allowlists = ignore everyone. Web: disabled unless `SC_WEB_ENABLED=true` |
| No cron, no extra services | Server owns its housekeeping via `setInterval` (cleanup, session sweep) |
| Windows tray needs a user session | VBScript-in-Startup launcher, not a Windows service (SYSTEM has no desktop → systray2 crashes) |

## Auth flow

1. First server start: `auth.js` generates a 32-byte hex token → `config/token.txt` (gitignored).
2. Every request (except `/api/health` and, when web is on, the web-login routes + static assets) authenticates via EITHER HMAC-signed headers (clients + bot) OR a valid web session cookie (browser).
3. HMAC auth: client sends `X-SC-Timestamp` (unix seconds) + `X-SC-Nonce` (32 hex chars) + `X-SC-Signature` (HMAC-SHA256 of `METHOD\nPATH\nTIMESTAMP\nNONCE`). Server checks timestamp freshness (±60 s), nonce uniqueness (in-memory map, 130 s window), and signature. Raw token never on the wire.
4. Wrong/missing → `401`. Cookie-authenticated writes also need a matching `X-CSRF-Token` → else `403`.
5. Web login (`POST /api/web/login`): scrypt password + (default-on) TOTP → sets the session cookie.
6. Client on `401`: pauses sync (`authErrorPaused`) until restart.

## Sync triggers

**SSE (primary):** client holds a persistent connection to `GET /api/events`. Server emits `data: changed` (debounced 200 ms) after every upload or delete. Client calls `runSync()` immediately on receipt. Reconnects with exponential backoff (2 s → 64 s) on disconnect.

**Fallback poll:** `setInterval` every `syncIntervalSeconds` (default 300 s) — safety net for changes that arrive while SSE is reconnecting.

**Local watcher (uploads only):** chokidar triggers `syncSingleFile` on local file add/change without waiting for a diff cycle.

## Sync loop (client/src/sync.js → runSync, per cycle)

```text
1. reload .ignore (mtime-cached)
2. in parallel: fetch server manifest + walk/hash local folder (+ fetch lock-status, deletions)
3. UPLOAD: local-not-on-server → enqueue upload; hash differs & local mtime >= server → enqueue (local wins)
4. DELETE-PROPAGATION: deleted.json paths still on server → enqueue bulk delete; gone already → drop from deleted.json
5. DOWNLOAD: server-not-local & not in deleted.json → download; hash differs & server newer → download (server wins)
secure-folder special-case: when lock-status says locked, remove local secure files (no deleted.json entry); when unlocked, behave normally
watcher: add/change → syncSingleFile (enqueue upload, skip ignored/lazy/large); unlink → syncFileDeletion (enqueue bulk delete)
```

## Runtime paths

**Client** — config `.env`, logs, and `deleted.json` live in the platform config dir: Windows `%APPDATA%\simplecloud\`, Linux `~/.config/simplecloud/`.

**Server** (from `SC_*` in `server/.env`): `storageDir` (UUID blobs) · `tempDir/<date>/<uuid>.<date>.bk` (overwrite backups) · `tempDir/deletions/<date>/<path>` (recycle bin) · `logDir/server.log` + `logDir/changes.log` · `dbDir/simplecloud.db` · `config/token.txt`.

## Deploy / run

**Server:** `cd server && sudo ./setup.sh` (one-line remote install also documented in README). Wizard writes `.env`, installs deps, starts under PM2, prints the token (and the web-UI TOTP QR if enabled).

**Client (Windows):** open PowerShell → `irm https://raw.githubusercontent.com/tabahi/simple-cloud/refs/heads/main/client/setup.ps1 | iex`. Downloads repo, installs deps, sets up auto-start, launches GUI wizard for URL + token. Or double-click `client/setup.bat` if repo is already local.

**Client (Linux):** `cd client && npm install && node src/index.js` once to create `.env`, fill in `SC_SERVER_URL`/`SC_TOKEN`, run again. Auto-start: systemd (see client/README.md).
