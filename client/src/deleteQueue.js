'use strict';

// Debounced, batched delete queue.
//
// Deleting a whole folder fires one watcher `unlink` per file. Sending an
// individual DELETE for each would flood the server and trip its firewall rate
// limiter. Instead we COLLECT deletions and flush them as a single bulk request:
//
//   - Each delete is added to a pending batch and (re)starts a quiet timer.
//   - When no new delete arrives for DEBOUNCE_MS (default 5s), the whole batch
//     is sent in ONE request (api.deleteRemoteFiles).
//   - On a rate-limit/timeout the batch is retried after RATE_LIMIT_PAUSE_MS
//     (default 30s), up to MAX_ATTEMPTS; nothing is lost.
//
// Deletes that arrive while a flush is in flight go into the NEXT batch.

const logger = require('./logger');
const api = require('./api');

let DEBOUNCE_MS = 5 * 1000;            // quiet period before a batch is sent
let RATE_LIMIT_PAUSE_MS = 30 * 1000;  // back off this long after a rate-limit
const MAX_ATTEMPTS = 10;              // give up on a batch after this many tries

// Test/override hooks.
function _setTimings({ debounceMs, pauseMs } = {}) {
  if (typeof debounceMs === 'number') DEBOUNCE_MS = debounceMs;
  if (typeof pauseMs === 'number') RATE_LIMIT_PAUSE_MS = pauseMs;
}

// Pending batch being accumulated: rel → [callbacks].
let _batch = new Map();
let _timer = null;
let _flushing = false;
let _paused = false;

// Optional listeners (wired to the tray, mirroring uploadQueue).
let _onPauseChange = null;
let _onDrain = null;
function onPauseChange(fn) { _onPauseChange = fn; }
function onDrain(fn) { _onDrain = fn; }

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

// Queue a path for deletion. onResult(ok) fires when its batch settles.
function enqueue(rel, onResult) {
  const cbs = _batch.get(rel) || [];
  if (onResult) cbs.push(onResult);
  _batch.set(rel, cbs);
  logger.debug(`Delete queue: queued ${rel} (batch size ${_batch.size})`);

  // (Re)start the quiet timer — every new delete pushes the flush back.
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    _timer = null;
    _flush().catch((e) => logger.error(`Delete queue flush error: ${e.message}`));
  }, DEBOUNCE_MS);
}

async function _flush() {
  if (_flushing) return;          // a flush is already running; this batch waits
  if (_batch.size === 0) return;

  _flushing = true;
  try {
    // Process batches until the pending set is empty (new deletes may arrive
    // and form fresh batches while we work).
    while (_batch.size > 0) {
      // Snapshot the current batch and start a fresh one for incoming deletes.
      const batch = _batch;
      _batch = new Map();

      const paths = [...batch.keys()];
      let attempts = 0;
      let done = false;

      while (!done) {
        attempts += 1;
        try {
          const res = await api.deleteRemoteFiles(paths);
          logger.info(`Delete queue: sent ${paths.length} deletion(s) — ${res.deleted} removed, ${res.missing} already gone`);
          _notify(batch, true);
          done = true;
        } catch (err) {
          if (err.code === 'AUTH') {
            logger.error(`Delete queue: auth error, dropping batch of ${paths.length}: ${err.message}`);
            _notify(batch, false);
            done = true;
          } else if (api.isRateLimitError(err) || err.code === 'RATE_LIMIT') {
            logger.warn(`Delete queue: rate-limited on batch of ${paths.length} (attempt ${attempts}) — pausing ${RATE_LIMIT_PAUSE_MS / 1000}s`);
            setPaused(true);
            await sleep(RATE_LIMIT_PAUSE_MS);
            setPaused(false);
            if (attempts >= MAX_ATTEMPTS) {
              logger.error(`Delete queue: giving up on batch of ${paths.length} after ${attempts} attempts`);
              _notify(batch, false);
              done = true;
            }
            // else: loop and retry the same batch
          } else {
            logger.error(`Delete queue: batch delete failed (${paths.length} paths): ${err.message}`);
            _notify(batch, false);
            done = true;
          }
        }
      }
    }
  } finally {
    _flushing = false;
  }

  if (_onDrain) {
    try { _onDrain(); } catch (_) { /* ignore listener errors */ }
  }
}

function _notify(batch, ok) {
  for (const cbs of batch.values()) {
    for (const cb of cbs) {
      try { cb(ok); } catch (_) { /* ignore callback errors */ }
    }
  }
}

// Remove a path from the pending batch before it is flushed. No-op if the
// batch is already in flight (the HTTP request is already sent).
function cancel(rel) {
  if (!_flushing && _batch.has(rel)) {
    _batch.delete(rel);
    logger.debug(`Delete queue: cancelled ${rel}`);
  }
}

function hasPending(rel) { return _batch.has(rel); }
function isPaused() { return _paused; }
function pendingCount() { return _batch.size; }

module.exports = { enqueue, cancel, hasPending, isPaused, pendingCount, onPauseChange, onDrain, _setTimings };
