'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const setupMod = require('../runtime-setup');

test('platform mapping: Bun asset and Claude Code package', () => {
  assert.equal(setupMod.bunAsset('darwin', 'arm64'), 'bun-darwin-aarch64');
  assert.equal(setupMod.bunAsset('darwin', 'x64'), 'bun-darwin-x64');
  assert.equal(setupMod.bunAsset('linux', 'arm64'), 'bun-linux-aarch64');
  assert.equal(setupMod.bunAsset('win32', 'x64'), null);
  assert.equal(setupMod.claudePackage('darwin', 'arm64'), '@anthropic-ai/claude-code-darwin-arm64');
  assert.equal(setupMod.claudePackage('linux', 'x64'), '@anthropic-ai/claude-code-linux-x64');
});

/** fetch + exec fakes that "download" and "extract" without the network. */
function fakeDeps(calls) {
  const fetchImpl = async (url) => {
    calls.push({ fetch: url });
    if (url.endsWith('/latest')) return { ok: true, json: async () => ({ dist: { tarball: 'https://reg/cc.tgz' } }) };
    return { ok: true, arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer };
  };
  const exec = (bin, args, opts, cb) => {
    calls.push({ exec: `${path.basename(bin)} ${args.join(' ')}` });
    try {
      if (path.basename(bin) === 'unzip') {
        const tmp = args[args.indexOf('-d') + 1];
        const asset = setupMod.bunAsset();
        fs.mkdirSync(path.join(tmp, asset), { recursive: true });
        fs.writeFileSync(path.join(tmp, asset, 'bun'), '#!/bin/sh\n');
      } else if (path.basename(bin) === 'tar') {
        const tmp = args[args.indexOf('-C') + 1];
        fs.mkdirSync(path.join(tmp, 'package'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'package', 'claude'), 'CLAUDE');
      } else if (args[0] === 'install') {
        const dir = path.join(opts.cwd, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      }
      cb(null, '', '');
    } catch (e) { cb(e, '', e.message); }
  };
  return { fetchImpl, exec };
}

test('setup fetches only the gaps, and reports each step', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-setup-'));
  const dataDir = path.join(base, 'data');
  const runtimeDir = path.join(base, 'rt');
  fs.mkdirSync(path.join(runtimeDir, 'container', 'agent-runner'), { recursive: true });
  const calls = [];
  const steps = [];
  const out = await setupMod.setup({ runtimeDir, dataDir, found: { bun: null, claude: null, runnerDeps: false }, deps: fakeDeps(calls), onProgress: (m) => steps.push(m) });

  assert.equal(out.bun, setupMod.managedBun(dataDir));
  assert.equal(out.claude, setupMod.managedClaude(dataDir));
  assert.ok(fs.existsSync(out.bun), 'bun landed in the managed dir');
  assert.ok(fs.existsSync(out.claude), 'claude landed in the managed dir');
  assert.ok(fs.existsSync(path.join(runtimeDir, 'container', 'agent-runner', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json')), 'runner deps installed');
  // it downloaded bun + claude (registry + tarball) and ran unzip/tar/bun install
  assert.ok(calls.some((c) => c.fetch && c.fetch.includes('bun-darwin')), 'downloaded bun');
  assert.ok(calls.some((c) => c.fetch && c.fetch.includes('claude-code-darwin')), 'resolved claude');
  assert.ok(calls.some((c) => c.exec && c.exec.startsWith('bun install')), 'ran bun install');
  assert.ok(steps.includes('workspace ready'));

  fs.rmSync(base, { recursive: true, force: true });
});

test('setup fetches nothing when the machine already has everything', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-setup-'));
  const dataDir = path.join(base, 'data');
  const runtimeDir = path.join(base, 'rt');
  // a present bun + claude on the machine, and runner deps already installed
  const bun = path.join(base, 'bun'); fs.writeFileSync(bun, '');
  const claude = path.join(base, 'claude'); fs.writeFileSync(claude, '');
  const sdk = path.join(runtimeDir, 'container', 'agent-runner', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true }); fs.writeFileSync(path.join(sdk, 'package.json'), '{}');
  const calls = [];
  const out = await setupMod.setup({ runtimeDir, dataDir, found: { bun, claude, runnerDeps: true }, deps: fakeDeps(calls) });
  assert.equal(out.bun, bun);
  assert.equal(out.claude, claude);
  assert.deepEqual(calls, [], 'no downloads, no shell-outs');
  fs.rmSync(base, { recursive: true, force: true });
});
