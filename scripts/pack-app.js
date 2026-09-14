#!/usr/bin/env node
'use strict';
/**
 * Build the desktop app into a launchable bundle.
 *
 * A few things must be in place before electron-builder runs, and this script
 * makes sure of each so `npm run pack` is one step:
 *   1. the bundled stock Node (packaging/node)            — scripts/fetch-node.js
 *   2. the app icon (packaging/icon.icns)                 — scripts/make-icon.js
 *   3. the vendored host built (dist/) with its deps      — pnpm + runtime:build
 *   4. a PRODUCTION-only copy of the host's deps to ship  — pnpm --prod (staged)
 * The host is built with its full (dev) toolchain, but only its production
 * dependencies are bundled: a fresh `pnpm --prod` install into packaging/host-prod
 * drops the build toolchain (typescript, rolldown, esbuild, vitest, …, ~113 MB)
 * that the running app never touches. electron-builder then bundles the tree
 * (asar off, so the stock-Node gateway can require it) plus the Node binary, and
 * writes an unsigned .app. Signing and notarization need Apple credentials and
 * are left to the owner.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOST = path.join(ROOT, 'vendor', 'nanoclaw');
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });

function step(msg) { console.log(`\n\x1b[36m▸ ${msg}\x1b[0m`); }
function have(cmd) { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }

step('bundled Node');
run(process.execPath, [path.join(ROOT, 'scripts', 'fetch-node.js')]);

if (!fs.existsSync(path.join(ROOT, 'packaging', 'icon.icns'))) {
  step('app icon (packaging/icon.icns missing)');
  run(process.execPath, [path.join(ROOT, 'scripts', 'make-icon.js')]);
}

if (!have('pnpm')) throw new Error('pnpm is required to build the host — install it (npm i -g pnpm) and retry');

if (!fs.existsSync(path.join(HOST, 'node_modules'))) {
  step('host dependencies (vendor/nanoclaw/node_modules missing)');
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: HOST });
}
// The no-container tier runs the agent runner from source with Bun, so its deps
// must be installed beside that source and shipped — the packaged app cannot
// install them at first run (the bundle is read-only). `--runner` builds dist/
// AND installs the runner deps; both are git-ignored, so ensure both are present.
const runnerMarker = path.join(HOST, 'container', 'agent-runner', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
if (!fs.existsSync(path.join(HOST, 'dist')) || !fs.existsSync(runnerMarker)) {
  step('host build + agent-runner deps (dist/ or runner deps missing)');
  run(process.execPath, [path.join(ROOT, 'scripts', 'runtime-build.js'), '--runner']);
}

// The host is a pnpm project; a fresh --prod install in a staging dir yields a
// lean node_modules (prod deps + their prod-only closure) that electron-builder
// maps into the bundle in place of the 152 MB dev tree. --ignore-scripts keeps
// better-sqlite3's shipped N-API prebuild instead of rebuilding it.
step('host production deps (staged — dev toolchain dropped from the bundle)');
const stage = path.join(ROOT, 'packaging', 'host-prod');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const f of ['package.json', 'pnpm-lock.yaml']) fs.copyFileSync(path.join(HOST, f), path.join(stage, f));
run('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'], { cwd: stage });

// Same for the Bun-run agent runner: ship only its production deps (drops
// typescript and the type packages — the runner is executed, never built).
if (!have('bun')) throw new Error('bun is required to stage the agent runner — install it and retry');
step('agent-runner production deps (staged — types/toolchain dropped)');
const runnerStage = path.join(ROOT, 'packaging', 'runner-prod');
const runnerSrc = path.join(HOST, 'container', 'agent-runner');
fs.rmSync(runnerStage, { recursive: true, force: true });
fs.mkdirSync(runnerStage, { recursive: true });
for (const f of ['package.json', 'bun.lock']) fs.copyFileSync(path.join(runnerSrc, f), path.join(runnerStage, f));
run('bun', ['install', '--production', '--frozen-lockfile'], { cwd: runnerStage });

step('electron-builder (unsigned .app → dist-app/)');
run(path.join(ROOT, 'node_modules', '.bin', 'electron-builder'), ['--mac', 'dir']);

const app = path.join(ROOT, 'dist-app', 'mac-arm64', 'fren.app');
// The bundle, checked: the microphone text fren declares, and the native
// pieces the wake word loads — a pack that lacks any of them is not a pack.
if (fs.existsSync(app)) {
  step('bundle check');
  const must = [
    'Contents/Resources/app/node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node',
    'Contents/Resources/app/node_modules/sherpa-onnx-darwin-arm64/libsherpa-onnx-c-api.dylib',
    'Contents/Resources/app/node_modules/sherpa-onnx-darwin-arm64/libonnxruntime.dylib',
    'Contents/Resources/app/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
    'Contents/Resources/app/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib',
    'Contents/Resources/app/node_modules/@picovoice/pvrecorder-node/lib/mac/arm64/pv_recorder.node',
  ];
  const missing = must.filter((rel) => !fs.existsSync(path.join(app, rel)));
  const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
  if (!plist.includes('fren listens for')) missing.push("Contents/Info.plist: NSMicrophoneUsageDescription (fren's own text)");
  if (missing.length) {
    console.error('\n\x1b[31m✗ the bundle is missing:\x1b[0m\n  ' + missing.join('\n  '));
    process.exit(1);
  }
  console.log("  microphone text and the wake word's native pieces are in place");
}

console.log(`\n\x1b[32m✓ built ${fs.existsSync(app) ? app : 'dist-app/'}\x1b[0m`);
console.log('  Launch it the way a user does — `open dist-app/mac-arm64/fren.app` — never Contents/MacOS/fren from a shell:');
console.log("  a shell launch borrows the terminal's microphone permission and proves nothing about the bundle's own.");
console.log('  Unsigned: a downloaded copy needs System Settings › Privacy & Security › Open Anyway (or xattr -dr com.apple.quarantine),');
console.log('  or sign/notarize with Apple credentials.');
console.log('  Keys: the bundle carries no .env — put yours at ~/Library/Application Support/fren/.env (or FREN_DATA_DIR/.env).');
