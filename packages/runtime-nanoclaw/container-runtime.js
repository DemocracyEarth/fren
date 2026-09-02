'use strict';
/**
 * The container runtime, probed and named in exactly one place.
 *
 * Everything the product says about it says "secure execution environment".
 * The hints here are the only strings that name a product, because they are
 * what a person needs in order to fix the situation.
 */
const { execFile } = require('node:child_process');

const PROBE_TIMEOUT_MS = 10_000;

function run(bin, args, { timeoutMs = PROBE_TIMEOUT_MS, exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

/**
 * @returns {Promise<{kind:'docker', installed:boolean, running:boolean, version:string|null, hint:string|null, reason:string|null}>}
 */
async function detect({ exec } = {}) {
  const version = await run('docker', ['version', '--format', '{{.Client.Version}}'], { exec });
  if (!version.ok && version.error && (version.error.code === 'ENOENT' || /ENOENT/.test(String(version.error.message)))) {
    return {
      kind: 'docker', installed: false, running: false, version: null,
      reason: 'no container runtime is installed',
      hint: 'Install Docker Desktop (https://docker.com/products/docker-desktop), then open it once.',
    };
  }
  const info = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { exec });
  if (!info.ok) {
    return {
      kind: 'docker', installed: true, running: false, version: version.stdout.trim() || null,
      reason: 'the container runtime is installed but not running',
      hint: 'Start Docker Desktop and wait for it to say it is running.',
    };
  }
  return { kind: 'docker', installed: true, running: true, version: info.stdout.trim() || version.stdout.trim() || null, reason: null, hint: null };
}

/** True when the agent image exists locally. */
async function imagePresent(tag, { exec } = {}) {
  const r = await run('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { exec });
  return r.ok;
}

/** Stop every container this install started. Best effort, never throws. */
async function stopLabeled(label, { exec, timeoutMs = 30_000 } = {}) {
  const list = await run('docker', ['ps', '-q', '--filter', `label=${label}`], { exec });
  const ids = list.stdout.split(/\s+/).filter(Boolean);
  if (!ids.length) return 0;
  await run('docker', ['stop', '-t', '5', ...ids], { exec, timeoutMs });
  return ids.length;
}

/** On macOS the app can be asked to start. Fire and forget. */
async function tryStart({ exec, platform = process.platform } = {}) {
  if (platform !== 'darwin') return false;
  const r = await run('open', ['-a', 'Docker'], { exec, timeoutMs: 5_000 });
  return r.ok;
}

module.exports = { detect, imagePresent, stopLabeled, tryStart, PROBE_TIMEOUT_MS };
