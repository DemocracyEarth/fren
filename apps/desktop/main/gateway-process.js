'use strict';
/**
 * Launching the gateway (FREN Core) the packaged app needs, without a dev
 * runner. In development `start.js` already spawns it, so the app finds it
 * live and does nothing; packaged, there is no runner, so the app starts it.
 *
 * It runs under a STOCK Node, not Electron's: the vendored host loads a native
 * better-sqlite3 built for Node's ABI, and Electron's own ABI would refuse it.
 * A packaged app carries a Node beside its resources; in development the
 * machine's own Node is found on the usual paths.
 */
const { app } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../packages/shared/config');

function executable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

/** A stock Node to run the gateway and the host under; null if none is found. */
function resolveNode() {
  const tries = [
    process.env.FREN_NODE,
    app.isPackaged ? path.join(process.resourcesPath, 'node', 'bin', 'node') : null,
    app.isPackaged ? path.join(process.resourcesPath, 'node') : null,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ].filter(Boolean);
  for (const c of tries) if (executable(c)) return c;
  try {
    const which = execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim();
    if (which && executable(which)) return which;
  } catch { /* not on PATH */ }
  try {
    const versions = path.join(os.homedir(), '.nvm', 'versions', 'node');
    const latest = fs.readdirSync(versions).filter((v) => /^v\d/.test(v)).sort().pop();
    const bin = latest && path.join(versions, latest, 'bin', 'node');
    if (bin && executable(bin)) return bin;
  } catch { /* no nvm */ }
  return null;
}

let child = null;

/** Start the gateway as a child, if it is not already ours. Returns the pid or null. */
function startGateway({ log = () => {} } = {}) {
  if (child && child.exitCode === null) return child.pid;
  const node = resolveNode();
  if (!node) { log('[gateway] no Node runtime found to launch the gateway'); return null; }
  const server = path.join(config.REPO_ROOT, 'apps', 'gateway', 'server.js');
  const env = { ...process.env, FREN_PARENT_PID: String(process.pid) };
  // Packaged, the code (and the vendored host beside it) lives read-only inside
  // the app bundle, so the host cannot write its state next to itself as it does
  // in a checkout. Point it at the user's data dir instead. In development the
  // default — state beside the code — is left untouched.
  if (app.isPackaged && !env.FREN_RUNTIME_STATE_DIR) {
    env.FREN_RUNTIME_STATE_DIR = path.join(config.DATA_DIR, 'runtime-state');
  }
  log(`[gateway] launching (${node})`);
  child = spawn(node, [server], { cwd: config.REPO_ROOT, stdio: 'inherit', env });
  child.on('exit', (code) => { log(`[gateway] exited (${code ?? 'signal'})`); child = null; });
  return child.pid;
}

function stopGateway() {
  if (child && child.exitCode === null) child.kill();
  child = null;
}

/**
 * Make sure the gateway is reachable: if a health check already answers,
 * something else runs it (the dev runner) and we leave it be; otherwise start
 * one and wait for it to come up.
 */
async function ensureGateway({ health, log = () => {}, timeoutMs = 20_000 } = {}) {
  try {
    await health();
    log('[gateway] already running');
    return 'existing';
  } catch { /* not up yet — ours to start */ }
  startGateway({ log });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    try { await health(); log('[gateway] up'); return 'started'; } catch { /* keep waiting */ }
  }
  log('[gateway] did not come up in time');
  return 'timeout';
}

module.exports = { resolveNode, startGateway, stopGateway, ensureGateway };
