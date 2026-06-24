'use strict';

const { emitter } = require('../events');

async function eventsRoute(fastify, _opts) {
  fastify.get('/api/events', (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders(); // send headers immediately so the client sees the 200 without waiting for the first event

    const send = () => res.write('data: changed\n\n');
    emitter.on('changed', send);
    const ping = setInterval(() => res.write(': ping\n\n'), 30_000);

    request.raw.on('close', () => {
      emitter.off('changed', send);
      clearInterval(ping);
      res.end();
    });
  });
}

module.exports = eventsRoute;
