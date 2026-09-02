'use strict';
/**
 * The bridge: Core's end of the link the runtime host's FREN channel dials.
 *
 * A Unix socket server, listening before the host is spawned so the host can
 * never find it absent. One connection at a time (a newer one supersedes),
 * newline-delimited JSON both ways. The first frame must be `hello` with the
 * token Core gave the host; anything else closes the connection.
 *
 * Frames from the host: deliver (answered with ack), typing, provenance,
 * turn, pong. Frames to the host: inbound, action, watch, ack, ping.
 */
const fs = require('node:fs');
const net = require('node:net');

const PING_MS = 15_000;

function createBridge({ socketPath, token, onFrame, log = () => {}, pingMs = PING_MS }) {
  let server = null;
  let peer = null;
  let ready = false;
  const waiters = [];
  let ping = null;

  function settleWaiters() {
    for (const w of waiters.splice(0)) w();
  }

  function send(frame) {
    if (!peer || !ready) return false;
    try {
      peer.write(JSON.stringify(frame) + '\n');
      return true;
    } catch (err) {
      log(`[runtime] bridge write failed: ${err.message}`);
      return false;
    }
  }

  function attach(socket) {
    let greeted = false;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (!frame || typeof frame.type !== 'string') continue;
        if (!greeted) {
          if (frame.type !== 'hello' || frame.token !== token) {
            log('[runtime] bridge: a connection did not say hello with the right token; closed');
            socket.destroy();
            return;
          }
          greeted = true;
          if (peer && peer !== socket) {
            try { peer.destroy(); } catch { /* gone */ }
          }
          peer = socket;
          ready = true;
          socket.write(JSON.stringify({ type: 'welcome' }) + '\n');
          settleWaiters();
          onFrame({ type: 'connected' }, () => {});
          continue;
        }
        if (frame.type === 'pong') continue;
        const reply = (answer) => {
          if (peer === socket) socket.write(JSON.stringify({ type: 'ack', id: frame.id, ...answer }) + '\n');
        };
        try {
          onFrame(frame, reply);
        } catch (err) {
          log(`[runtime] bridge handler failed on ${frame.type}: ${err.message}`);
          if (frame.type === 'deliver') reply({ ok: false, error: err.message });
        }
      }
    });
    const gone = () => {
      if (peer === socket) {
        peer = null;
        ready = false;
        onFrame({ type: 'disconnected' }, () => {});
      }
    };
    socket.on('close', gone);
    socket.on('error', gone);
  }

  function listen() {
    return new Promise((resolve, reject) => {
      try { fs.unlinkSync(socketPath); } catch { /* none */ }
      server = net.createServer(attach);
      server.once('error', reject);
      server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ }
        ping = setInterval(() => send({ type: 'ping' }), pingMs);
        if (ping.unref) ping.unref();
        resolve();
      });
    });
  }

  /** Resolve when a host has said hello, or reject after the timeout. */
  function waitForPeer(timeoutMs) {
    if (ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.indexOf(done);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error('the runtime host did not connect in time'));
      }, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      waiters.push(done);
    });
  }

  function close() {
    clearInterval(ping);
    ping = null;
    if (peer) { try { peer.destroy(); } catch { /* gone */ } peer = null; }
    ready = false;
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => {
        server = null;
        try { fs.unlinkSync(socketPath); } catch { /* gone */ }
        resolve();
      });
    });
  }

  return { listen, close, send, waitForPeer, isConnected: () => ready, socketPath };
}

module.exports = { createBridge, PING_MS };
