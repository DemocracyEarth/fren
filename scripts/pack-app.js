#!/usr/bin/env node
'use strict';
/**
 * Build the desktop app into a launchable bundle.
 *
 * Three things must be in place before electron-builder runs, and this script
 * makes sure of each so `npm run pack` is one step:
 *   1. the bundled stock Node (packaging/node)          — scripts/fetch-node.js
 *   2. the vendored host's build output (dist/)          — npm run runtime:build
 *   3. the vendored host's node_modules (native prebuilds) — npm --prefix … install
 * Then electron-builder bundles the whole tree (asar off, so the stock-Node
 * gateway can require it) plus the Node binary, and writes an unsigned .app.
 * Signing and notarization need Apple credentials and are left to the owner.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });

function step(msg) { console.log(`\n\x1b[36m▸ ${msg}\x1b[0m`); }

step('bundled Node');
run(process.execPath, [path.join(ROOT, 'scripts', 'fetch-node.js')]);

const host = path.join(ROOT, 'vendor', 'nanoclaw');
if (!fs.existsSync(path.join(host, 'node_modules'))) {
  step('host dependencies (vendor/nanoclaw/node_modules missing)');
  run('npm', ['--prefix', host, 'install'], { env: { ...process.env } });
}
if (!fs.existsSync(path.join(host, 'dist'))) {
  step('host build (vendor/nanoclaw/dist missing)');
  run(process.execPath, [path.join(ROOT, 'scripts', 'runtime-build.js')]);
}

step('electron-builder (unsigned .app → dist-app/)');
run(path.join(ROOT, 'node_modules', '.bin', 'electron-builder'), ['--mac', 'dir']);

const app = path.join(ROOT, 'dist-app', 'mac-arm64', 'fren.app');
console.log(`\n\x1b[32m✓ built ${fs.existsSync(app) ? app : 'dist-app/'}\x1b[0m`);
console.log('  Unsigned: right-click → Open the first time, or sign/notarize with Apple credentials.');
