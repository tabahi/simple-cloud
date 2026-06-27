'use strict';

// Serial upload queue.
//
// All uploads — both the periodic full-sync and the real-time watcher — go
// through this one queue so the server never sees concurrent uploads from this
// client. Files are processed strictly one at a time.
//
// The server is rate-limited at the firewall level: instead of returning a
// status code it drops/holds the connection, so an over-limit upload simply
// times out (ETIMEDOUT etc., classified by api.isRateLimitError). When that
// happens the worker pauses the whole queue for RATE_LIMIT_PAUSE_MS and then
// retries the SAME file — nothing is dropped.

const logger = require('./logger');
const api = require('./api');

let RATE_LIMIT_PAUSE_MS = 30 * 1000;   // back off this long after a rate-limit
const MAX_ATTEMPTS_PER_FILE = 10;      // give up on a file after this many tries

// Test/override hook for the backoff duration.
function _setPauseMs(ms) { RATE_LIMIT_PAUSE_MS = ms; }

// rel → { abs, onDone, attempts }. Keyed by rel so a file queued twice before
// it's processed collapses to one entry (latest abs/onDone win).
const _pending = new Map();
let _running = false;
let _paused = false; // true while in a rate-limit backoff window

// Optional listener notified when the rate-limit pause begins/ends, so the UI
// (tray) can show "Paused (rate-limited)". Called with (paused: boolean).
let _onPauseChange = null;
function onPauseChange(fn) { _onPauseChange = fn; }
function setPaused(val) {
  if (_paused === val) return;
  _paused = val;
  if (_onPauseChange) {
    try { _onPauseChange(val); } catch (_) { /* ignore listener errors */ }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Enqueue a file for upload. Returns a promise that resolves when the upload
// finally succeeds (or rejects/​resolves false if permanently skipped).
// onResult(ok) is also invoked so callers without the promise can react.
function enqueue(rel, abs, onResult) {
  const existing = _pending.get(rel);
  if (existing) {
    // A newer version arrived. Update abs so we can re-upload it after the
    // current upload finishes (the running api.uploadFile already captured the
    // old path by value, so this doesn't affect the in-flight request).
    if (existing.abs !== abs) {
      existing.abs = abs;
      existing._requeue = true;
    }
    if (onResult) existing.extraCallbacks.push(onResult);
    logger.debug(`Upload queue: ${rel} already queued, refreshed`);
    return;
  }
  _pending.set(rel, { abs, attempts: 0, extraCallbacks: onResult ? [onResult] : [], _requeue: false });
  logger.debug(`Upload queue: enqueued ${rel} (size ${_pending.size})`);
  _run();
}

async function _run() {
  if (_running) return;
  _running = true;
  try {
    while (_pending.size > 0) {
      // Take the first entry (insertion order).
      const [rel, item] = _pending.entries().next().value;

      let result;
      try {
        item.attempts += 1;
        await api.uploadFile(rel, item.abs);
        result = 'ok';
      } catch (err) {
        if (err.code === 'AUTH') {
          // Auth failures won't fix themselves with a retry — surface and drop.
          logger.error(`Upload queue: auth error on ${rel}, dropping: ${err.message}`);
          result = 'auth';
        } else if (api.isRateLimitError(err) || err.code === 'RATE_LIMIT') {
          // Rate-limited: pause the whole queue, then retry the SAME file.
          logger.warn(
            `Upload queue: rate-limited on ${rel} (attempt ${item.attempts}) — pausing ${RATE_LIMIT_PAUSE_MS / 1000}s`
          );
          setPaused(true);
          await sleep(RATE_LIMIT_PAUSE_MS);
          setPaused(false);
          if (item.attempts >= MAX_ATTEMPTS_PER_FILE) {
            logger.error(`Upload queue: giving up on ${rel} after ${item.attempts} attempts`);
            result = 'gaveup';
          } else {
            continue; // retry same file without removing it
          }
        } else if (err.code === 'EBUSY' || err.code === 'EPERM') {
          logger.warn(`Upload queue: file locked, skipping ${rel}`);
          result = 'skip';
        } else {
          logger.error(`Upload queue: upload failed for ${rel}: ${err.message}`);
          result = 'error';
        }
      }

      // Done with this file (success or terminal failure) — remove + notify.
      _pending.delete(rel);
      const ok = result === 'ok';
      for (const cb of item.extraCallbacks) {
        try { cb(ok, result); } catch (_) { /* ignore callback errors */ }
      }

      // If a newer version of the file arrived while the upload was in flight,
      // item.abs was updated in place. Re-enqueue so that version gets uploaded.
      if (ok && item._requeue) {
        enqueue(rel, item.abs);
        logger.debug(`Upload queue: re-enqueued ${rel} (newer version arrived during upload)`);
      }
    }
  } finally {
    _running = false;
  }

  // Queue fully drained — notify so the UI can return to idle.
  if (_onDrain) {
    try { _onDrain(); } catch (_) { /* ignore listener errors */ }
  }
}

// Remove a queued file before it is processed. No-op if already in flight.
function cancel(rel) {
  if (_pending.has(rel)) {
    _pending.delete(rel);
    logger.debug(`Upload queue: cancelled ${rel}`);
  }
}

function hasPending(rel) { return _pending.has(rel); }
function isPaused() { return _paused; }
function pendingCount() { return _pending.size; }

// Optional listener invoked when the queue finishes processing all items.
let _onDrain = null;
function onDrain(fn) { _onDrain = fn; }

module.exports = { enqueue, cancel, hasPending, isPaused, pendingCount, onPauseChange, onDrain, _setPauseMs };
