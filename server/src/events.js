'use strict';

const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // one listener per connected SSE client

let debounceTimer = null;

function notifyChanged() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    emitter.emit('changed');
  }, 200);
}

module.exports = { emitter, notifyChanged };
