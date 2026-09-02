'use strict';
/**
 * A client for the runtime host's control socket.
 *
 * The protocol is newline-delimited JSON, one request per connection: open,
 * write `{ id, command, args }`, read one `{ id, ok, data | error }` line,
 * done. Commands are `<plural>-<verb>` (`tasks-create`, `groups-list`); the
 * host normalises hyphenated argument keys to underscores, so both spellings
 * work here. The socket file's permissions are the authentication.
 */
const net = require('node:net');

const DEFAULT_TIMEOUT_MS = 20_000;

class NclError extends Error {
  constructor(code, message, command) {
    super(`${command}: ${message}`);
    this.name = 'NclError';
    this.code = code;
    this.command = command;
  }
}

function createNclClient({ socketPath, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let seq = 0;

  function call(command, args = {}) {
    seq += 1;
    const id = `c${Date.now().toString(36)}-${seq}`;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      let settled = false;
      const done = (fn) => { if (!settled) { settled = true; clearTimeout(timer); fn(); socket.destroy(); } };
      const timer = setTimeout(() => done(() => reject(new NclError('timeout', 'no answer in time', command))), timeoutMs);
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write(JSON.stringify({ id, command, args }) + '\n');
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        const idx = buffer.indexOf('\n');
        if (idx < 0) return;
        const line = buffer.slice(0, idx);
        let frame;
        try { frame = JSON.parse(line); } catch { return done(() => reject(new NclError('transport-error', 'bad frame from the host', command))); }
        if (frame.ok === true) return done(() => resolve(frame.data));
        const err = frame.error || {};
        done(() => reject(new NclError(err.code || 'handler-error', err.message || 'unknown error', command)));
      });
      socket.on('error', (err) => done(() => reject(new NclError('transport-error', err.message, command))));
      socket.on('close', () => done(() => reject(new NclError('transport-error', 'connection closed before an answer', command))));
    });
  }

  /** True when the host answers at all. */
  async function alive() {
    try {
      await call('help');
      return true;
    } catch (err) {
      return err.code !== 'transport-error' && err.code !== 'timeout';
    }
  }

  return { call, alive, socketPath };
}

module.exports = { createNclClient, NclError, DEFAULT_TIMEOUT_MS };
