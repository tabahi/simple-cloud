'use strict';

// Tracks files the sync engine wrote/deleted itself, so the chokidar watcher
// can ignore the add/change/unlink events those writes trigger. Without this,
// a downloaded file immediately fires an `add` event and gets re-uploaded
// (a self-feedback loop).
//
// Keyed by the file's relative path (forward-slash form). Each entry has an
// expiry: the watcher event can arrive well after the write because chokidar's
// `awaitWriteFinish` holds it until the file is stable (~300ms+), so we keep
// the suppression alive for a short window rather than clearing it instantly.

const SUPPRESS_MS = 5000; // window during which a self-write's events are ignored

const _suppressed = new Map(); // rel → expiry timestamp (ms)

function normalize(rel) {
  return rel.replace(/\\/g, '/');
}

// Mark a path as just written by us. Call this right before (or after) the
// sync engine writes/deletes the file.
function mark(rel) {
  const now = Date.now();
  // Opportunistically drop expired entries so the map can't grow without bound
  // in a long-running session where some marks never get a matching event.
  if (_suppressed.size > 64) {
    for (const [k, exp] of _suppressed) {
      if (now > exp) _suppressed.delete(k);
    }
  }
  _suppressed.set(normalize(rel), now + SUPPRESS_MS);
}

// Returns true if the path was recently self-written and the event should be
// ignored. Uses an expiry window rather than removing on first match, because a
// single download can fire BOTH an `add` and a follow-up `change` event — both
// must be suppressed. A genuine user edit after the window (default 5s) syncs
// normally. Expired entries are pruned lazily on access.
function consume(rel) {
  const key = normalize(rel);
  const expiry = _suppressed.get(key);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    _suppressed.delete(key); // stale — clean up and treat as a real event
    return false;
  }
  return true;
}

module.exports = { mark, consume, SUPPRESS_MS };
