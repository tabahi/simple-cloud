'use strict';

// simplecloud web UI — vanilla JS, no build step. Talks to the existing /api/*
// endpoints using the HttpOnly session cookie (sent automatically) plus a CSRF
// token returned at login, sent as X-CSRF-Token on state-changing requests.

const $ = (sel) => document.querySelector(sel);

let csrf = null;
let manifest = []; // [{ path, size, modified_at, hash }]
let cwd = ''; // current folder prefix, "" = root, else "a/b/"

// ── helpers ───────────────────────────────────────────────────────────────────

function humanSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'onclick') e.onclick = v;
    else if (k === 'text') e.textContent = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids) e.append(kid);
  return e;
}

// fetch wrapper that attaches the CSRF header and handles auth expiry.
async function api(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (csrf && opts.method && opts.method !== 'GET') {
    opts.headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    showLogin();
    throw new Error('Session expired — please sign in again.');
  }
  return res;
}

// ── login ────────────────────────────────────────────────────────────────────

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
}
function showApp() {
  $('#boot-warn').hidden = true;
  $('#login').hidden = true;
  $('#app').hidden = false;
  showServerInfo();
}

async function initLogin() {
  try {
    const cfg = await (await fetch('/api/web/config')).json();
    $('#totp-field').hidden = !cfg.totpRequired;
    if (cfg.totpRequired) $('#totp').required = true;
  } catch (_) { /* leave TOTP field as-is */ }
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#login-error').textContent = '';
  $('#login-btn').disabled = true;
  try {
    const body = { password: $('#password').value };
    if (!$('#totp-field').hidden) body.totp = $('#totp').value.trim();
    const res = await fetch('/api/web/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Login failed (${res.status})`);
    csrf = json.csrf;
    $('#password').value = '';
    $('#totp').value = '';
    showApp();
    await refresh();
  } catch (e) {
    $('#login-error').textContent = e.message;
  } finally {
    $('#login-btn').disabled = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('/api/web/logout', { method: 'POST' }); } catch (_) {}
  csrf = null;
  showLogin();
});

// ── data + render ─────────────────────────────────────────────────────────────

async function refresh() {
  const [m, lock] = await Promise.all([
    api('/api/manifest').then((r) => r.json()),
    api('/api/lock-status').then((r) => r.json()).catch(() => ({})),
  ]);
  manifest = Array.isArray(m) ? m : [];
  const badge = $('#lock-badge');
  if (lock && lock.prefix) {
    badge.textContent = lock.locked ? '🔒 locked' : '🔓 unlocked';
    badge.className = 'badge ' + (lock.locked ? 'locked' : 'unlocked');
  } else {
    badge.textContent = '';
  }
  const totalBytes = manifest.reduce((s, f) => s + (f.size || 0), 0);
  $('#stats').textContent = `${manifest.length} files · ${humanSize(totalBytes)}`;
  render();
}

// Build the current folder's immediate children from the flat manifest.
function childrenOf(prefix) {
  const folders = new Map(); // name → file count
  const files = [];
  for (const f of manifest) {
    if (prefix && !f.path.startsWith(prefix)) continue;
    const rel = prefix ? f.path.slice(prefix.length) : f.path;
    if (!rel) continue;
    const slash = rel.indexOf('/');
    if (slash === -1) files.push({ ...f, name: rel });
    else {
      const sub = rel.slice(0, slash);
      folders.set(sub, (folders.get(sub) || 0) + 1);
    }
  }
  return { folders, files };
}

function render() {
  // breadcrumbs
  const crumbs = $('#crumbs');
  crumbs.innerHTML = '';
  crumbs.append(el('a', { text: 'root', onclick: () => go('') }));
  let acc = '';
  for (const part of cwd.split('/').filter(Boolean)) {
    acc += part + '/';
    const here = acc;
    crumbs.append(el('span', { class: 'sep', text: '/' }));
    crumbs.append(el('a', { text: part, onclick: () => go(here) }));
  }

  const filter = $('#filter').value.toLowerCase();
  const { folders, files } = childrenOf(cwd);
  const listing = $('#listing');
  listing.innerHTML = '';

  [...folders.keys()].sort((a, b) => a.localeCompare(b))
    .filter((n) => !filter || n.toLowerCase().includes(filter))
    .forEach((name) => {
      const count = folders.get(name);
      listing.append(el('div', { class: 'row' },
        el('span', { class: 'icon', text: '📁' }),
        el('span', { class: 'name folder', text: name, onclick: () => go(cwd + name + '/') }),
        el('span', { class: 'size', text: `${count} file${count === 1 ? '' : 's'}` }),
        el('span', { class: 'actions' })
      ));
    });

  files.sort((a, b) => a.name.localeCompare(b.name))
    .filter((f) => !filter || f.name.toLowerCase().includes(filter))
    .forEach((f) => {
      const actions = el('span', { class: 'actions' },
        el('button', { class: 'ghost', text: 'Download', onclick: () => download(f.path) }),
        el('button', { class: 'danger', text: 'Delete', onclick: () => del(f.path) })
      );
      listing.append(el('div', { class: 'row' },
        el('span', { class: 'icon', text: '📄' }),
        el('span', { class: 'name', text: f.name, onclick: () => download(f.path) }),
        el('span', { class: 'size', text: humanSize(f.size) }),
        actions
      ));
    });

  if (!folders.size && !files.length) {
    listing.append(el('div', { class: 'row muted' }, el('span', { text: '(empty)' })));
  }
}

function go(prefix) {
  cwd = prefix;
  $('#filter').value = '';
  render();
}

// ── file actions ────────────────────────────────────────────────────────────────

function download(path) {
  // Open via a temporary form so the cookie is sent; the server streams it.
  const url = '/api/download?path=' + encodeURIComponent(path);
  window.open(url, '_blank');
}

async function del(path) {
  if (!confirm(`Delete "${path}"?\n\nIt goes to the server recycle bin and can be restored from Backups until it expires.`)) return;
  try {
    const res = await api('/api/file?path=' + encodeURIComponent(path), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`Delete failed (${res.status})`);
    await refresh();
  } catch (e) {
    alert(e.message);
  }
}

$('#upload-btn').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  if (!files.length) return;
  const prog = $('#progress');
  prog.hidden = false;
  let done = 0;
  for (const file of files) {
    prog.textContent = `Uploading ${file.name} (${++done}/${files.length})…`;
    try {
      const form = new FormData();
      form.append('path', cwd + file.name);
      form.append('file', file, file.name);
      const res = await api('/api/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    } catch (e) {
      alert(`${file.name}: ${e.message}`);
    }
  }
  prog.hidden = true;
  await refresh();
});

$('#refresh-btn').addEventListener('click', () => refresh().catch((e) => alert(e.message)));
$('#filter').addEventListener('input', render);

// ── backups panel ────────────────────────────────────────────────────────────

$('#backups-btn').addEventListener('click', openBackups);
$('#backups-close').addEventListener('click', () => ($('#backups-panel').hidden = true));

async function openBackups() {
  const panel = $('#backups-panel');
  const body = $('#backups-body');
  panel.hidden = false;
  body.textContent = 'Loading…';
  try {
    const data = await api('/api/backups').then((r) => r.json());
    const groups = data.backups || [];
    body.innerHTML = '';
    if (!groups.length) {
      body.append(el('p', { class: 'muted', text: 'No backups or deleted files.' }));
      return;
    }
    for (const g of groups) {
      const title = `${g.deleted ? '🗑 deleted · ' : ''}${g.date}`;
      body.append(el('h4', { text: title }));
      for (const f of g.files) {
        const row = el('div', { class: 'bk' + (g.deleted || f.deleted ? ' deleted' : '') },
          el('span', { class: 'name', text: f.logicalPath }),
          el('span', { class: 'size', text: humanSize(f.size) }),
          el('button', { class: 'ghost', text: 'Download',
            onclick: () => window.open('/api/backup?id=' + encodeURIComponent(f.id), '_blank') })
        );
        body.append(row);
      }
    }
  } catch (e) {
    body.textContent = e.message;
  }
}

// ── boot ──────────────────────────────────────────────────────────────────────

// Show the server's running build + start time in the topbar. If a deploy
// updated the files on disk but nobody restarted the process, `startedAt` stays
// old (and routes the new UI calls may be missing) — this makes that visible.
async function showServerInfo() {
  try {
    const h = await (await fetch('/api/health')).json();
    const started = h.startedAt ? new Date(h.startedAt).toLocaleString() : '?';
    $('#server-info').textContent = `v${h.version || '?'} · up since ${started}`;
  } catch (_) { /* non-critical */ }
}

(async () => {
  await initLogin();

  // Try to resume an existing session via the cookie. We must distinguish:
  //   200 → valid session, enter the app.
  //   401 → genuinely signed out, show login (the normal case).
  //   else (404/5xx/network) → the server can't answer the resume call, almost
  //         always a stale/misconfigured deploy. Show login but say why, instead
  //         of silently bouncing the user to a login screen that won't stick.
  let status = 0;
  try {
    const res = await fetch('/api/web/session');
    status = res.status;
    if (res.ok) {
      csrf = (await res.json()).csrf;
      showApp();
      // A transient failure here must NOT undo a valid session: stay in the app
      // and let refresh()'s own 401 handling sign the user out if truly expired.
      refresh().catch((e) => { $('#progress').hidden = false; $('#progress').textContent = e.message; });
      return;
    }
  } catch (_) { /* network error → treated as "can't reach resume endpoint" */ }

  if (status && status !== 401) {
    $('#boot-warn').hidden = false;
    $('#boot-warn').textContent =
      `Can't reach the session endpoint (HTTP ${status}). The server is likely ` +
      `running an outdated build — restart the server process (e.g. pm2 restart). ` +
      `You can still sign in below.`;
  }
  showLogin();
})();
