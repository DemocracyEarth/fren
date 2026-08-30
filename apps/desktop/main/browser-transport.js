'use strict';
/**
 * The loopback channel between the browser extension and fren.
 *
 * Same idiom as the gateway: node:http, bound STRICTLY to 127.0.0.1, JSON in
 * and out, a hard body cap. Localhost is not authentication, so nothing here
 * trusts it: the extension pairs once through a native consent dialog, gets a
 * random 256-bit token, and every later request must present both that token
 * AND the chrome-extension:// Origin recorded at pairing. A web page cannot
 * forge that Origin (the browser stamps it), and a local process that never
 * saw the token has nothing to replay.
 *
 * This file is the transport and nothing else — verified events go to a
 * callback. Replacing HTTP with Chrome Native Messaging later means replacing
 * this file, not the sensor.
 */
const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY_BYTES = 256 * 1024;   // a page snapshot, with generous room

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/**
 * @param {object} opts
 * @param {number} opts.port          loopback port to bind
 * @param {(msg: object) => void} opts.onMessage   verified events land here
 * @param {() => object} opts.getPolicy            what /config serves
 * @param {(req: {browser: string, name: string, origin: string}) => Promise<boolean>} opts.approve
 *        the consent decision — a native dialog in the app, an injected stub in tests
 * @param {() => Array<{tokenHash: string, origin: string}>} opts.loadPairs
 * @param {(pairs: Array) => void} opts.savePairs
 * @param {(line: string) => void} [opts.log]
 */
function createBrowserTransport({ port, onMessage, getPolicy, approve, loadPairs, savePairs, log = () => {} }) {
  let pairs = [];
  try { pairs = loadPairs() || []; } catch { pairs = []; }
  // One consent dialog at a time, and a denied origin stays denied for the
  // session — an extension retrying on a timer must not turn the dialog into
  // a siege.
  let asking = false;
  const denied = new Set();

  const originOf = (req) => String(req.headers.origin || '');
  const tokenOf = (req) => {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
    return m ? m[1] : '';
  };

  function authed(req) {
    const origin = originOf(req);
    const hash = sha256(tokenOf(req));
    return pairs.some((p) => p.tokenHash === hash && p.origin === origin);
  }

  async function handlePair(req, body, res) {
    const origin = originOf(req);
    // Only a browser extension may pair. Web pages arrive with an https
    // origin; curl arrives with none. Both end here.
    if (!/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) {
      return send(res, 403, { error: 'only a browser extension can pair' });
    }
    if (authed(req)) return send(res, 200, { paired: true });
    if (denied.has(origin)) return send(res, 403, { error: 'denied' });
    if (asking) return send(res, 429, { error: 'a pairing question is already on screen' });

    asking = true;
    let ok = false;
    try {
      ok = await approve({
        browser: String(body.browser || 'chromium').slice(0, 40),
        name: String(body.name || 'a browser extension').slice(0, 80),
        origin,
      });
    } finally {
      asking = false;
    }
    if (!ok) {
      denied.add(origin);
      log(`[browser] pairing denied for ${origin}`);
      return send(res, 403, { error: 'denied' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    // Re-pairing from the same origin replaces the old token rather than
    // accumulating spares — a reinstalled extension should not leave a live
    // credential behind it.
    pairs = pairs.filter((p) => p.origin !== origin);
    pairs.push({ tokenHash: sha256(token), origin, at: Date.now() });
    try { savePairs(pairs); } catch { /* the pairing still works this session */ }
    log(`[browser] paired: ${origin}`);
    return send(res, 200, { token });
  }

  const server = http.createServer(async (req, res) => {
    // Same-machine only, still worth asserting: a proxied request would show
    // a non-loopback socket address.
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' &&
        req.socket.remoteAddress !== '::ffff:127.0.0.1') {
      return send(res, 403, { error: 'loopback only' });
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/pair') {
        return await handlePair(req, await readJson(req), res);
      }
      if (!authed(req)) return send(res, 401, { error: 'not paired' });
      if (req.method === 'GET' && url.pathname === '/config') {
        return send(res, 200, getPolicy());
      }
      if (req.method === 'POST' && url.pathname === '/events') {
        const body = await readJson(req);
        const events = Array.isArray(body.events) ? body.events : [body];
        for (const e of events.slice(0, 20)) {
          if (e && typeof e.type === 'string') onMessage(e);
        }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/heartbeat') {
        onMessage({ type: 'heartbeat' });
        return send(res, 200, getPolicy());
      }
      return send(res, 404, { error: 'no such thing' });
    } catch (err) {
      return send(res, err.status || 500, { error: err.message || 'error' });
    }
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        log(`[browser] sensor listening on 127.0.0.1:${port}`);
        resolve();
      });
    });
  }

  function stop() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    start, stop,
    hasPairs: () => pairs.length > 0,
    // The actual bound port — tests listen on 0 and ask.
    port: () => (server.address() ? server.address().port : null),
  };
}

module.exports = { createBrowserTransport };
