'use strict';
/**
 * The container runtime, probed and named in exactly one place.
 *
 * Everything the product says about it says "secure execution environment".
 * The hints here are the only strings that name a product, because they are
 * what a person needs in order to fix the situation.
 *
 * Finding the binary is part of the probe. Docker Desktop only puts `docker`
 * on PATH when a person lets it create symlinks, which needs an admin
 * password; an app launched from the Dock has a bare PATH anyway. So the
 * binary is looked for on PATH first and then where the runtime's own app
 * keeps it, and whatever directory it was found in is handed to the host
 * process, which shells `docker` by name.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROBE_TIMEOUT_MS = 10_000;

/** Where the binary lives when it is not on PATH, per platform. */
const KNOWN_DIRS = {
  darwin: [
    '/Applications/Docker.app/Contents/Resources/bin',
    path.join(process.env.HOME || '', 'Applications/Docker.app/Contents/Resources/bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(process.env.HOME || '', '.docker/bin'),
  ],
  linux: ['/usr/bin', '/usr/local/bin', '/snap/bin', path.join(process.env.HOME || '', '.docker/bin')],
  win32: ['C:\\Program Files\\Docker\\Docker\\resources\\bin'],
};

/**
 * The docker binary: its absolute path and the directory to add to a child's
 * PATH. Null when nowhere. Pure given `env`, `platform` and `exists`.
 */
function resolveDocker({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const name = platform === 'win32' ? 'docker.exe' : 'docker';
  const onPath = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of [...onPath, ...(KNOWN_DIRS[platform] || [])]) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return { bin: candidate, dir, onPath: onPath.includes(dir) };
  }
  return null;
}

function run(bin, args, { timeoutMs = PROBE_TIMEOUT_MS, exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

function bin(opts = {}) {
  const found = opts.resolved !== undefined ? opts.resolved : resolveDocker(opts);
  return found ? found.bin : 'docker';
}

/**
 * @returns {Promise<{kind:'docker', installed:boolean, running:boolean, version:string|null, bin:string|null, dir:string|null, hint:string|null, reason:string|null}>}
 */
async function detect({ exec, env, platform, exists } = {}) {
  const found = resolveDocker({ env, platform, exists });
  if (!found) {
    return {
      kind: 'docker', installed: false, running: false, version: null, bin: null, dir: null,
      reason: 'no container runtime is installed',
      hint: 'Install Docker Desktop (https://docker.com/products/docker-desktop), then open it once.',
    };
  }
  const version = await run(found.bin, ['version', '--format', '{{.Client.Version}}'], { exec });
  if (!version.ok && version.error && (version.error.code === 'ENOENT' || /ENOENT/.test(String(version.error.message)))) {
    return {
      kind: 'docker', installed: false, running: false, version: null, bin: null, dir: null,
      reason: 'no container runtime is installed',
      hint: 'Install Docker Desktop (https://docker.com/products/docker-desktop), then open it once.',
    };
  }
  const info = await run(found.bin, ['info', '--format', '{{.ServerVersion}}'], { exec });
  if (!info.ok) {
    return {
      kind: 'docker', installed: true, running: false, version: version.stdout.trim() || null, bin: found.bin, dir: found.dir,
      reason: 'the container runtime is installed but not running',
      hint: 'Start Docker Desktop and wait for it to say it is running.',
    };
  }
  return {
    kind: 'docker', installed: true, running: true, version: info.stdout.trim() || version.stdout.trim() || null,
    bin: found.bin, dir: found.dir, reason: null, hint: null,
  };
}

/** True when the agent image exists locally. */
async function imagePresent(tag, { exec, resolved } = {}) {
  const r = await run(bin({ resolved }), ['image', 'inspect', tag, '--format', '{{.Id}}'], { exec });
  return r.ok;
}

/** Stop every container this install started. Best effort, never throws. */
async function stopLabeled(label, { exec, resolved, timeoutMs = 30_000 } = {}) {
  const b = bin({ resolved });
  const list = await run(b, ['ps', '-q', '--filter', `label=${label}`], { exec });
  const ids = list.stdout.split(/\s+/).filter(Boolean);
  if (!ids.length) return 0;
  await run(b, ['stop', '-t', '5', ...ids], { exec, timeoutMs });
  return ids.length;
}

/** On macOS the app can be asked to start. Fire and forget. */
async function tryStart({ exec, platform = process.platform } = {}) {
  if (platform !== 'darwin') return false;
  const r = await run('open', ['-a', 'Docker'], { exec, timeoutMs: 5_000 });
  return r.ok;
}

/** PATH for a child process that shells `docker` by name. */
function pathWithDocker(env = process.env, { platform, exists } = {}) {
  const found = resolveDocker({ env, platform, exists });
  const current = String(env.PATH || '/usr/local/bin:/usr/bin:/bin');
  if (!found || found.onPath) return current;
  return `${found.dir}${path.delimiter}${current}`;
}

module.exports = { detect, imagePresent, stopLabeled, tryStart, resolveDocker, pathWithDocker, KNOWN_DIRS, PROBE_TIMEOUT_MS };
