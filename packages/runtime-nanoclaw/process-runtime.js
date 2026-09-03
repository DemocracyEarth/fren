'use strict';
/**
 * The no-container tier: the agent runner as a sandboxed process on this
 * machine, confined by the operating system itself (macOS seatbelt). No
 * image, no daemon, nothing for the person to install beside what fren
 * ships or finds.
 *
 * This module finds the pieces the process driver needs (the sandbox, a
 * Bun, a native Claude Code, the runner's installed dependencies), turns
 * them into the host's environment, and can stop every session the driver
 * recorded. It never runs an agent; the driver in the vendored host does
 * (vendor/nanoclaw/src/drivers/process-driver.ts).
 */
const fs = require('node:fs');
const path = require('node:path');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const MACHO_64 = [0xcf, 0xfa, 0xed, 0xfe];
const MACHO_FAT = [0xca, 0xfe, 0xba, 0xbe];
const ELF = [0x7f, 0x45, 0x4c, 0x46];

function readMagic(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    return [...b];
  } catch {
    return null;
  }
}

/** A native executable, as opposed to a shell shim that only prints an error. */
function isNativeExecutable(file, { magic = readMagic } = {}) {
  const m = magic(file);
  if (!m) return false;
  return [MACHO_64, MACHO_FAT, ELF].some((want) => want.every((byte, i) => m[i] === byte));
}

function home(env) {
  return env.HOME || '';
}

function onPath(name, env) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name));
}

/** Where a Bun may be, most deliberate first. */
function bunCandidates(env = process.env) {
  return [
    env.FREN_BUN,
    path.join(home(env), '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
    ...onPath('bun', env),
  ].filter(Boolean);
}

function desktopVersions(dir, { readdir = fs.readdirSync } = {}) {
  let names;
  try {
    names = readdir(dir);
  } catch {
    return [];
  }
  const semver = (v) => v.split('.').map((n) => Number(n) || 0);
  return names
    .filter((n) => /^\d+\.\d+\.\d+$/.test(n))
    .sort((a, b) => {
      const [x, y] = [semver(a), semver(b)];
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    });
}

/** Where a native Claude Code may be, most deliberate first. */
function claudeCandidates(env = process.env, { platform = process.platform, readdir } = {}) {
  const out = [env.FREN_CLAUDE];
  if (platform === 'darwin') {
    const app = path.join(home(env), 'Library', 'Application Support', 'Claude', 'claude-code');
    for (const v of desktopVersions(app, readdir ? { readdir } : {})) {
      out.push(path.join(app, v, 'claude.app', 'Contents', 'MacOS', 'claude'));
    }
  }
  out.push(path.join(home(env), '.local', 'bin', 'claude'));
  out.push(...onPath('claude', env));
  return out.filter(Boolean);
}

/**
 * What this machine has for the process tier.
 * @returns {{kind:'process', available:boolean, sandbox:string|null, bun:string|null, claude:string|null,
 *            runnerDeps:boolean, reason:string|null, hint:string|null}}
 */
function detect({ runtimeDir, env = process.env, platform = process.platform, exists = fs.existsSync, native = isNativeExecutable, readdir } = {}) {
  const found = { kind: 'process', available: false, sandbox: null, bun: null, claude: null, runnerDeps: false, reason: null, hint: null };
  const missing = [];
  if (platform !== 'darwin') {
    return { ...found, reason: 'the no-container tier needs macOS for now', hint: 'Install Docker Desktop to run agents in containers instead.' };
  }
  found.sandbox = exists(SANDBOX_EXEC) ? SANDBOX_EXEC : null;
  if (!found.sandbox) missing.push(['the macOS sandbox is missing', 'This build of macOS has no sandbox-exec; install Docker Desktop instead.']);
  found.bun = bunCandidates(env).find((c) => exists(c)) || null;
  if (!found.bun) missing.push(['Bun is not installed', 'Install Bun (https://bun.sh) or set FREN_BUN to a Bun binary.']);
  found.runnerDeps = Boolean(runtimeDir) && exists(path.join(runtimeDir, 'container', 'agent-runner', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'));
  if (!found.runnerDeps) missing.push(['the agent runner is not installed', 'Run: npm run runtime:build -- --runner']);
  found.claude = claudeCandidates(env, readdir ? { platform, readdir } : { platform }).find((c) => exists(c) && native(c)) || null;
  if (!found.claude) missing.push(['Claude Code is not installed', 'Install Claude Code (https://claude.com/claude-code) or set FREN_CLAUDE to its binary.']);
  if (missing.length > 0) {
    found.reason = missing.map(([r]) => r).join('; ');
    found.hint = missing[0][1];
    return found;
  }
  found.available = true;
  return found;
}

/** The host's environment for the process driver, from what `detect` found. */
function hostEnv(found) {
  return {
    NANOCLAW_RUNTIME_DRIVER: 'process',
    NANOCLAW_PROCESS_BUN: found.bun,
    NANOCLAW_PROCESS_CLAUDE: found.claude,
  };
}

/** The proxy as a process on this machine reaches it: the container's host alias becomes loopback. */
function sandboxUrlFor(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'host.docker.internal') u.hostname = '127.0.0.1';
    return u.toString();
  } catch {
    return url;
  }
}

function registryDir(runtimeDir) {
  return path.join(runtimeDir, 'data', 'process-sessions');
}

/**
 * Stop every session the driver recorded: the whole process group of each,
 * politely first. Returns how many were told to stop.
 */
async function stopAll(runtimeDir, { kill = process.kill, graceMs = 2_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const dir = registryDir(runtimeDir);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return 0;
  }
  const live = [];
  for (const n of names) {
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    } catch {
      continue;
    }
    if (entry && typeof entry.pid === 'number' && !entry.exitedAt) live.push(entry);
  }
  const signal = (entry, sig) => {
    for (const target of [-entry.pid, entry.pid]) {
      try { kill(target, sig); } catch { /* gone */ }
    }
  };
  for (const entry of live) signal(entry, 'SIGTERM');
  if (live.length > 0) await sleep(graceMs);
  for (const entry of live) signal(entry, 'SIGKILL');
  for (const n of names) {
    fs.rmSync(path.join(dir, n), { force: true });
    fs.rmSync(path.join(dir, n.replace(/\.json$/, '.sb')), { force: true });
  }
  return live.length;
}

module.exports = { detect, hostEnv, stopAll, sandboxUrlFor, isNativeExecutable, bunCandidates, claudeCandidates, registryDir, SANDBOX_EXEC };
