'use strict';
/**
 * The event log: everything Core tells the desktop, in order, with an id.
 *
 * Events are appended to core.db first and pushed to listeners second, so a
 * subscriber that reconnects with the last id it saw gets exactly what it
 * missed and nothing twice. The push is server-sent events over the existing
 * HTTP connection: no new dependency, no new port, resumable by design.
 *
 * Wire format (one frame per event):
 *
 *   id: 42
 *   event: agent.message
 *   data: {"id":42,"at":1725...,"type":"agent.message","runId":"run_…","message":{…}}
 *
 * A comment line is sent every KEEPALIVE_MS so proxies and the client know
 * the stream is alive.
 */
const KEEPALIVE_MS = 15_000;

function createEventLog({ store, now = Date.now, log = () => {} }) {
  const listeners = new Set();

  function emit(type, payload = {}) {
    const at = now();
    const id = store.appendEvent(type, payload, at);
    const event = { id, at, type, ...payload };
    for (const fn of [...listeners]) {
      try { fn(event); } catch (err) { log(`[core] event listener failed: ${err.message}`); }
    }
    return event;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function frame(event) {
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  /**
   * Attach an HTTP response as an SSE client. `since` is the last id the
   * client saw (from Last-Event-ID or ?since=); everything after it is
   * replayed before live events flow.
   */
  function attach(res, { since = 0 } = {}) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`: connected\n\n`);
    for (const event of store.eventsSince(Number(since) || 0)) res.write(frame(event));
    const off = subscribe((event) => {
      if (!res.writableEnded) res.write(frame(event));
    });
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(`: ping\n\n`);
    }, KEEPALIVE_MS);
    if (ping.unref) ping.unref();
    const close = () => {
      clearInterval(ping);
      off();
    };
    res.on('close', close);
    res.on('error', close);
    return close;
  }

  return { emit, subscribe, attach, since: (id, limit) => store.eventsSince(id, limit), lastId: () => store.lastEventId() };
}

module.exports = { createEventLog, KEEPALIVE_MS };
