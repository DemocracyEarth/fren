'use strict';
/**
 * First-run setup for the no-container tier: fetch what an agent needs so it
 * runs with nothing installed by hand.
 *
 * Three pieces, each fetched only if the machine does not already have it:
 *  - Bun, the runtime the agent runner executes under, from its official
 *    GitHub release.
 *  - Claude Code, the agent itself, from Anthropic's official npm platform
 *    package (the user's machine pulls it; fren redistributes nothing).
 *  - the runner's own dependencies, installed with that Bun.
 *
 * Everything fren fetches lands under one managed directory
 * (`<dataDir>/runtime/`), so it is fren's to place, update, and remove, and it
 * never touches the machine's own tools. Downloads and shell-outs are injected
 * so the orchestration is testable without the network.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const BUN_RELEASE = 'https://github.com/oven-sh/bun/releases/latest/download';
const NPM_REGISTRY = 'https://registry.npmjs.org';

/** The managed directory fren keeps the tier's pieces in. */
function managedDir(dataDir) {
  return path.join(dataDir, 'runtime');
}
function managedBun(dataDir) {
  return path.join(managedDir(dataDir), 'bin', 'bun');
}
function managedClaude(dataDir) {
  return path.join(managedDir(dataDir), 'claude');
}

/** The Bun release asset for this platform, or null where the tier is not offered. */
function bunAsset(platform = process.platform, arch = process.arch) {
  const o = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  const c = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x64' : null;
  return o && c ? `bun-${o}-${c}` : null;
}
/** The Claude Code platform package for this machine, or null. */
function claudePackage(platform = process.platform, arch = process.arch) {
  const o = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'win32' : null;
  const c = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  return o && c ? `@anthropic-ai/claude-code-${o}-${c}` : null;
}

/** Stream a URL to a file. Follows redirects (fetch does). */
async function downloadTo(url, dest, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

function run(bin, args, { exec = execFile, cwd, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    exec(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin} ${args.join(' ')} failed: ${(stderr || err.message || '').slice(0, 300)}`));
      else resolve(String(stdout || ''));
    });
  });
}

/**
 * Ensure a Bun exists; return its path. If `existing` is given (the machine
 * already has one), that is used and nothing is fetched. Otherwise Bun is
 * downloaded into the managed directory.
 */
async function ensureBun({ dataDir, existing = null, deps = {}, log = () => {} }) {
  if (existing && fs.existsSync(existing)) return existing;
  const target = managedBun(dataDir);
  if (fs.existsSync(target)) return target;
  const asset = bunAsset();
  if (!asset) throw new Error('no Bun build for this platform');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-bun-'));
  try {
    const zip = path.join(tmp, `${asset}.zip`);
    log(`downloading Bun (${asset})`);
    await downloadTo(`${BUN_RELEASE}/${asset}.zip`, zip, deps);
    await run('unzip', ['-o', '-q', zip, '-d', tmp], deps);
    const unpacked = path.join(tmp, asset, 'bun'); // the zip holds `bun-<os>-<arch>/bun`
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(unpacked, target);
    fs.chmodSync(target, 0o755);
    return target;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Ensure a native Claude Code exists; return its path. Uses `existing` when the
 * machine already has one; otherwise downloads Anthropic's official platform
 * package from the npm registry and extracts the standalone binary.
 */
async function ensureClaude({ dataDir, existing = null, deps = {}, log = () => {} }) {
  if (existing && fs.existsSync(existing)) return existing;
  const target = managedClaude(dataDir);
  if (fs.existsSync(target)) return target;
  const pkg = claudePackage();
  if (!pkg) throw new Error('no Claude Code build for this platform');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-cc-'));
  try {
    log('resolving Claude Code');
    const meta = await (deps.fetchImpl || fetch)(`${NPM_REGISTRY}/${pkg}/latest`, { redirect: 'follow' });
    if (!meta.ok) throw new Error(`could not reach the Claude Code registry (${meta.status})`);
    const tarball = (await meta.json()).dist.tarball;
    const tgz = path.join(tmp, 'cc.tgz');
    log('downloading Claude Code');
    await downloadTo(tarball, tgz, deps);
    await run('tar', ['-xzf', tgz, '-C', tmp], deps);
    const bin = path.join(tmp, 'package', 'claude'); // the tarball holds `package/claude`
    if (!fs.existsSync(bin)) throw new Error('the Claude Code package had no claude binary');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(bin, target);
    fs.chmodSync(target, 0o755);
    return target;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Ensure the runner's dependencies are installed beside its source, with Bun. */
async function ensureRunnerDeps({ runtimeDir, bun, deps = {}, log = () => {} }) {
  const runner = path.join(runtimeDir, 'container', 'agent-runner');
  const marker = path.join(runner, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
  if (fs.existsSync(marker)) return false;
  log('installing the agent runner');
  await run(bun, ['install', '--no-save'], { ...deps, cwd: runner });
  return true;
}

/**
 * Set up everything the process tier needs that this machine lacks, reporting
 * each step. `found` is a process-runtime `detect()` result: whatever it
 * already located is reused, only the gaps are fetched. Returns the resolved
 * { bun, claude } paths.
 */
async function setup({ runtimeDir, dataDir, found, deps = {}, onProgress = () => {} }) {
  const log = (m) => onProgress(m);
  onProgress('checking fren’s workspace');
  const bun = await ensureBun({ dataDir, existing: found && found.bun, deps, log });
  await ensureRunnerDeps({ runtimeDir, bun, deps, log });
  const claude = await ensureClaude({ dataDir, existing: found && found.claude, deps, log });
  onProgress('workspace ready');
  return { bun, claude };
}

module.exports = {
  setup, ensureBun, ensureClaude, ensureRunnerDeps,
  bunAsset, claudePackage, managedDir, managedBun, managedClaude, downloadTo,
};
