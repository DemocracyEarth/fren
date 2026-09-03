'use strict';
/**
 * The runtime host as a child process.
 *
 * Spawned with a small, named environment (never a provider key), its output
 * kept in a log file rather than shown to anyone, stopped with a signal and a
 * deadline. Restart policy belongs to the runtime adapter; this only knows
 * how to start one process and how to stop it.
 *
 * Two things a long life needs. The log rotates when it grows past a few
 * megabytes, so a host that runs for weeks does not fill a disk; both of the
 * child's streams come through here so the file can be swapped under them.
 * And a host from an earlier life of ours, left running because that life
 * ended without stopping it, is stopped before a new one starts: it holds
 * the control socket and the instance lease, and it would never reconnect to
 * a Core whose token it does not know. The pid file next to the log is how
 * one life tells the next.
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const STOP_GRACE_MS = 10_000;
const ORPHAN_GRACE_MS = 5_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** What `ps` says that process is running, or '' when it cannot say. */
function commandOf(pid) {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

function createSupervisor({ runtimeDir, env, logDir, log = () => {}, command = process.execPath, args = ['dist/index.js'], spawnImpl = spawn, logMaxBytes = LOG_MAX_BYTES }) {
  let child = null;
  let exitInfo = null;
  let stderrTail = [];
  const listeners = new Set();
  const logFile = path.join(logDir, 'runtime.log');
  const pidFile = path.join(logDir, 'runtime-host.pid');
  const marker = String(args[args.length - 1] || command);
  let out = null;
  let written = 0;

  // ------------------------------------------------------------- the log
  function rotate() {
    for (let i = LOG_KEEP - 1; i >= 1; i -= 1) {
      try { fs.renameSync(`${logFile}.${i}`, `${logFile}.${i + 1}`); } catch { /* none to move */ }
    }
    try { fs.renameSync(logFile, `${logFile}.1`); } catch { /* none yet */ }
  }

  function openLog() {
    fs.mkdirSync(logDir, { recursive: true });
    let size = 0;
    try { size = fs.statSync(logFile).size; } catch { /* none yet */ }
    if (size >= logMaxBytes) rotate();
    out = fs.openSync(logFile, 'a');
    try { written = fs.fstatSync(out).size; } catch { written = 0; }
  }

  function write(text) {
    if (out === null) return;
    try { fs.writeSync(out, text); } catch { return; }
    written += Buffer.byteLength(text);
    if (written >= logMaxBytes) {
      try { fs.closeSync(out); } catch { /* closed */ }
      rotate();
      out = fs.openSync(logFile, 'a');
      written = 0;
    }
  }

  function closeLog() {
    if (out === null) return;
    try { fs.closeSync(out); } catch { /* closed */ }
    out = null;
  }

  // -------------------------------------------------------- earlier lives
  function readPidFile() {
    try { return JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch { return null; }
  }

  function forgetPid() {
    try { fs.unlinkSync(pidFile); } catch { /* gone */ }
  }

  /** Stop a host an earlier life of ours left running. Synchronous: start() must not race it. */
  function reapOrphan() {
    const note = readPidFile();
    const pid = note && Number(note.pid);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
    if (!alive(pid)) { forgetPid(); return; }
    const running = commandOf(pid);
    if (!running.includes(note.marker || marker)) { forgetPid(); return; } // the pid was reused by something else
    log(`[runtime] a host from an earlier life is still running (pid ${pid}); stopping it first`);
    try { process.kill(pid, 'SIGTERM'); } catch { forgetPid(); return; }
    const deadline = Date.now() + ORPHAN_GRACE_MS;
    while (alive(pid) && Date.now() < deadline) sleepSync(100);
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    forgetPid();
  }

  // ------------------------------------------------------------ lifecycle
  function start() {
    if (child) return child;
    exitInfo = null;
    stderrTail = [];
    reapOrphan();
    openLog();
    child = spawnImpl(command, args, {
      cwd: runtimeDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try { fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, marker, startedAt: new Date().toISOString() }) + '\n'); } catch { /* the next life cannot know; nothing else changes */ }
    if (child.stdout) child.stdout.on('data', (chunk) => write(String(chunk)));
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        write(text);
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          stderrTail.push(line);
          if (stderrTail.length > 20) stderrTail.shift();
        }
      });
    }
    child.on('exit', (code, signal) => {
      closeLog();
      forgetPid();
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
    logFile,
    pidFile,
  };
}

module.exports = { createSupervisor, STOP_GRACE_MS, LOG_MAX_BYTES, LOG_KEEP };
