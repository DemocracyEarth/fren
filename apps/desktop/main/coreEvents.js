'use strict';
/**
 * The desktop's ear on FREN Core: a server-sent-events client that never
 * gives up and never repeats itself.
 *
 * Core numbers every event. This client remembers the last id it saw and
 * reconnects with it, so a dropped connection costs nothing but the gap, and
 * the gap is replayed. Pure Node (fetch + streams), no Electron, so the
 * parsing and the reconnect loop are testable against a plain HTTP server.
 */

/**
 * Split a text buffer into complete SSE frames. Returns the parsed events
 * and whatever partial frame is left for next time.
 */
function parseFrames(buffer) {
  const events = [];
  let rest = buffer;
  let idx;
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let data = null;
    let id = null;
    let type = null;
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue;               // a comment: keepalive
      if (line.startsWith('data: ')) data = (data === null ? '' : data + '\n') + line.slice(6);
      else if (line.startsWith('id: ')) id = Number(line.slice(4));
      else if (line.startsWith('event: ')) type = line.slice(7);
    }
    if (data === null) continue;
    try {
      const event = JSON.parse(data);
      if (id !== null && event.id === undefined) event.id = id;
      if (type && event.type === undefined) event.type = type;
      events.push(event);
    } catch { /* a frame that is not JSON is not ours */ }
  }
  return { events, rest };
}

const BACKOFF_MS = [1000, 2000, 5000, 10000];

/**
 * Open the stream and keep it open.
 *
 * @param {object} opts
 * @param {string} opts.url            the events endpoint
 * @param {string} opts.token          bearer token
 * @param {number|'latest'} [opts.since]  first id to ask for; 'latest' skips history
 * @param {(event: object) => void} opts.onEvent
 * @param {(status: 'connected'|'disconnected', detail?: string) => void} [opts.onStatus]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number[]} [opts.backoffMs]
 */
function createEventStream({ url, token, since = 'latest', onEvent, onStatus = () => {}, fetchImpl = fetch, backoffMs = BACKOFF_MS }) {
  let closed = false;
  let controller = null;
  let lastId = since;
  let attempt = 0;
  let wake = null;

  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
    wake = () => { clearTimeout(t); resolve(); };
  });

  async function once() {
    controller = new AbortController();
    const res = await fetchImpl(`${url}?since=${encodeURIComponent(String(lastId))}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`events -> ${res.status}`);
    attempt = 0;
    onStatus('connected');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseFrames(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (typeof event.id === 'number') lastId = event.id;
        try { onEvent(event); } catch { /* a listener's bug does not close the stream */ }
      }
    }
  }

  (async function loop() {
    while (!closed) {
      try {
        await once();
        if (!closed) onStatus('disconnected', 'stream ended');
      } catch (err) {
        if (closed) break;
        onStatus('disconnected', err && err.message);
      }
      if (closed) break;
      await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
      attempt += 1;
    }
  })();

  return {
    close() {
      closed = true;
      if (controller) controller.abort();
      if (wake) wake();
    },
    lastId: () => lastId,
  };
}

module.exports = { createEventStream, parseFrames, BACKOFF_MS };
