'use strict';
/**
 * The runtime host as a child process.
 *
 * Spawned with a small, named environment (never a provider key), its output
 * kept in a log file rather than shown to anyone, stopped with a signal and a
 * deadline. Restart policy belongs to the runtime adapter; this only knows
 * how to start one process and how to stop it.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const STOP_GRACE_MS = 10_000;

function createSupervisor({ runtimeDir, env, logDir, log = () => {}, command = process.execPath, args = ['dist/index.js'], spawnImpl = spawn }) {
  let child = null;
  let exitInfo = null;
  let stderrTail = [];
  const listeners = new Set();

  function start() {
    if (child) return child;
    exitInfo = null;
    stderrTail = [];
    fs.mkdirSync(logDir, { recursive: true });
    const out = fs.openSync(path.join(logDir, 'runtime.log'), 'a');
    child = spawnImpl(command, args, {
      cwd: runtimeDir,
      env,
      stdio: ['ignore', out, 'pipe'],
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      fs.writeSync(out, text);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > 20) stderrTail.shift();
      }
    });
    child.on('exit', (code, signal) => {
      try { fs.closeSync(out); } catch { /* closed */ }
      exitInfo = { code, signal, at: Date.now(), stderr: stderrTail.slice() };
      child = null;
      log(`[runtime] host exited (${signal || code})`);
      for (const fn of [...listeners]) fn(exitInfo);
    });
    child.on('error', (err) => {
      log(`[runtime] host could not be started: ${err.message}`);
    });
    return child;
  }

  function stop({ graceMs = STOP_GRACE_MS } = {}) {
    const c = child;
    if (!c) return Promise.resolve(exitInfo);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { c.kill('SIGKILL'); } catch { /* gone */ }
      }, graceMs);
      c.once('exit', () => {
        clearTimeout(timer);
        resolve(exitInfo);
      });
      try { c.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(exitInfo); }
    });
  }

  return {
    start,
    stop,
    onExit(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    isRunning: () => !!child,
    pid: () => (child ? child.pid : null),
    lastExit: () => exitInfo,
    stderr: () => stderrTail.slice(),
  };
}

module.exports = { createSupervisor, STOP_GRACE_MS };
