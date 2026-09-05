'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pr = require('../process-runtime');

const HOME = '/Users/someone';
const env = { HOME, PATH: '/usr/bin:/bin' };
const runtimeDir = '/install/vendor/nanoclaw';
const deps = path.join(runtimeDir, 'container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/package.json');
const appClaude = (v) => path.join(HOME, 'Library/Application Support/Claude/claude-code', v, 'claude.app/Contents/MacOS/claude');

function machine(files, { native = () => true, readdir } = {}) {
  const set = new Set(files);
  return { runtimeDir, env, platform: 'darwin', exists: (p) => set.has(p), native, readdir: readdir || (() => ['2.1.181', '2.1.255', 'notes.txt']) };
}

test('finds the sandbox, a Bun, the runner, and the newest desktop Claude Code', () => {
  const found = pr.detect(machine([pr.SANDBOX_EXEC, path.join(HOME, '.bun/bin/bun'), deps, appClaude('2.1.181'), appClaude('2.1.255')]));
  assert.equal(found.available, true);
  assert.equal(found.bun, path.join(HOME, '.bun/bin/bun'));
  assert.equal(found.claude, appClaude('2.1.255'));
  assert.equal(found.reason, null);
  assert.deepEqual(pr.hostEnv(found), { NANOCLAW_RUNTIME_DRIVER: 'process', NANOCLAW_PROCESS_BUN: found.bun, NANOCLAW_PROCESS_CLAUDE: found.claude, NANOCLAW_PROCESS_NETWORK: 'proxy' });
});

test('an explicit FREN_BUN and FREN_CLAUDE win over whatever else is around', () => {
  const m = machine([pr.SANDBOX_EXEC, '/opt/fren/bun', '/opt/fren/claude', path.join(HOME, '.bun/bin/bun'), deps, appClaude('2.1.255')]);
  const found = pr.detect({ ...m, env: { ...env, FREN_BUN: '/opt/fren/bun', FREN_CLAUDE: '/opt/fren/claude' } });
  assert.equal(found.bun, '/opt/fren/bun');
  assert.equal(found.claude, '/opt/fren/claude');
});

test('a shell shim that only prints an error is not Claude Code', () => {
  const shim = '/usr/bin/claude';
  const found = pr.detect(machine([pr.SANDBOX_EXEC, path.join(HOME, '.bun/bin/bun'), deps, shim], { native: (p) => p !== shim }));
  assert.equal(found.available, false);
  assert.equal(found.claude, null);
  assert.match(found.reason, /Claude Code is not installed/);
  assert.match(found.hint, /FREN_CLAUDE/);
});

test('says what is missing, the first thing to do first', () => {
  const found = pr.detect(machine([pr.SANDBOX_EXEC, appClaude('2.1.255')]));
  assert.equal(found.available, false);
  assert.equal(found.reason, 'Bun is not installed; the agent runner is not installed');
  assert.match(found.hint, /first run|FREN_BUN/);
});

test('is not offered outside macOS', () => {
  const found = pr.detect({ ...machine([pr.SANDBOX_EXEC]), platform: 'linux' });
  assert.equal(found.available, false);
  assert.match(found.reason, /macOS/);
});

test('the native check reads the executable header', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-pr-'));
  const shim = path.join(dir, 'shim');
  const macho = path.join(dir, 'macho');
  fs.writeFileSync(shim, '#!/bin/sh\necho no\n');
  fs.writeFileSync(macho, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  assert.equal(pr.isNativeExecutable(shim), false);
  assert.equal(pr.isNativeExecutable(macho), true);
  assert.equal(pr.isNativeExecutable(path.join(dir, 'missing')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the proxy address a process uses is loopback, not the container alias', () => {
  assert.equal(pr.sandboxUrlFor('http://host.docker.internal:4527/anthropic'), 'http://127.0.0.1:4527/anthropic');
  assert.equal(pr.sandboxUrlFor('http://127.0.0.1:4527/anthropic'), 'http://127.0.0.1:4527/anthropic');
  assert.equal(pr.sandboxUrlFor(''), '');
});

test('stopAll signals every recorded process group, politely first, and forgets them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-pr-'));
  const reg = pr.registryDir(dir);
  fs.mkdirSync(reg, { recursive: true });
  fs.writeFileSync(path.join(reg, 'ncl-a.json'), JSON.stringify({ name: 'ncl-a', pid: 4242 }));
  fs.writeFileSync(path.join(reg, 'ncl-a.sb'), '(version 1)');
  fs.writeFileSync(path.join(reg, 'ncl-old.json'), JSON.stringify({ name: 'ncl-old', pid: 99, exitedAt: '2026-09-01T00:00:00Z' }));
  const calls = [];
  const n = await pr.stopAll(dir, { kill: (pid, sig) => calls.push([pid, sig]), sleep: async () => {} });
  assert.equal(n, 1);
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [4242, 'SIGTERM'], [-4242, 'SIGKILL'], [4242, 'SIGKILL']]);
  assert.deepEqual(fs.readdirSync(reg), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
