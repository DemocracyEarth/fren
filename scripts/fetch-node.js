#!/usr/bin/env node
'use strict';
/**
 * Fetch the stock Node the packaged app carries to run the gateway and host.
 *
 * The desktop is Electron, but the vendored host loads a native better-sqlite3
 * whose prebuilds are N-API (ABI-stable across Node versions) — so any modern
 * Node runs it, and Electron's own Node cannot (its ABI refuses the prebuild).
 * We bundle one stock Node binary; electron-builder copies it to Resources/node,
 * where the launcher (apps/desktop/main/gateway-process.js) finds it.
 *
 * Node 24 is the floor: the FREN-side store (packages/fren-core/store.js) uses
 * the built-in node:sqlite, which older Node exposes only behind
 * --experimental-sqlite; Node 24 ships it unflagged, so the gateway loads it
 * plainly. (The host's own DB is the N-API better-sqlite3, unaffected.)
 *
 * The binary is large and platform-specific, so it is git-ignored and fetched
 * here on demand. `npm run pack` runs this first.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const NODE_VERSION = 'v24.20.0'; // Node 24+: node:sqlite unflagged (see note above).
const OUT = path.join(__dirname, '..', 'packaging', 'node');

function platformSlug() {
  const arch = { arm64: 'arm64', x64: 'x64' }[process.arch];
  const platform = { darwin: 'darwin', linux: 'linux' }[process.platform];
  if (!arch || !platform) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  return `node-${NODE_VERSION}-${platform}-${arch}`;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) { file.close(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => { file.close(); fs.rmSync(dest, { force: true }); reject(err); });
  });
}

async function main() {
  if (fs.existsSync(OUT)) {
    const v = execFileSync(OUT, ['--version'], { encoding: 'utf8' }).trim();
    console.log(`[fetch-node] already present: ${v}`);
    return;
  }
  const slug = platformSlug();
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${slug}.tar.gz`;
  const tmp = path.join(os.tmpdir(), `${slug}.tar.gz`);
  console.log(`[fetch-node] downloading ${url}`);
  await download(url, tmp);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-node-'));
  execFileSync('tar', ['-xzf', tmp, '-C', workdir]);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.copyFileSync(path.join(workdir, slug, 'bin', 'node'), OUT);
  fs.chmodSync(OUT, 0o755);
  fs.rmSync(tmp, { force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
  const v = execFileSync(OUT, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`[fetch-node] bundled ${v} at packaging/node`);
}

main().catch((err) => { console.error(`[fetch-node] ${err.message}`); process.exit(1); });
