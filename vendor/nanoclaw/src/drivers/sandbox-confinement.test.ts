/**
 * The proof that the no-container tier holds: a probe runs under the rendered
 * profile exactly as the agent runner would, and must be unable to do what a
 * rogue agent would try. macOS only; elsewhere the suite skips, which is why
 * the process driver is only offered where this test can run.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderSandboxProfile } from './sandbox-profile.js';

const HAS_SEATBELT = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

const PROBE = `
const fs = require('fs');
const cp = require('child_process');
const out = {};
const t0 = Date.now(); const tryIt = (name, fn) => { const s = Date.now(); try { const r = fn(); out[name] = { ok: true, value: r === undefined ? null : String(r).slice(0, 40), ms: Date.now() - s }; } catch (e) { out[name] = { ok: false, code: e.code || (e.status !== undefined ? 'EXIT' + e.status : e.message.slice(0, 40)), ms: Date.now() - s }; } };
const [work, secret, home, port] = process.argv.slice(2);
tryIt('readHome', () => fs.readdirSync(home).length);
tryIt('readSecret', () => fs.readFileSync(secret + '/key.txt', 'utf8'));
tryIt('readSiblingSession', () => fs.readFileSync(secret + '/other-session.db', 'utf8'));
tryIt('writeWork', () => fs.writeFileSync(work + '/out.txt', 'hi'));
tryIt('readWork', () => fs.readFileSync(work + '/out.txt', 'utf8'));
tryIt('writeTmp', () => fs.writeFileSync('/tmp/fren-confinement-escape.txt', 'x'));
tryIt('writeHome', () => fs.writeFileSync(home + '/fren-confinement-escape.txt', 'x'));
tryIt('writeSecret', () => fs.writeFileSync(secret + '/planted.txt', 'x'));
tryIt('readEtcHosts', () => fs.readFileSync('/etc/hosts', 'utf8').length);
tryIt('spawnLs', () => cp.execFileSync('/bin/ls', [work]).toString().trim());
tryIt('spawnOsascript', () => cp.execFileSync('/usr/bin/osascript', ['-e', 'return 1'], { stdio: 'pipe', timeout: 1500 }).toString());
tryIt('spawnOpen', () => cp.execFileSync('/usr/bin/open', ['--help'], { stdio: 'pipe', timeout: 1500 }).toString());
tryIt('spawnSecurity', () => cp.execFileSync('/usr/bin/security', ['list-keychains'], { stdio: 'pipe', timeout: 1500 }).toString());
tryIt('spawnDefaults', () => cp.execFileSync('/usr/bin/defaults', ['read', 'com.apple.finder'], { stdio: 'pipe', timeout: 1500 }).toString());
tryIt('spawnScreencapture', () => cp.execFileSync('/usr/bin/screencapture', ['-x', work + '/shot.png'], { stdio: 'pipe', timeout: 1500 }).toString());
tryIt('envSecrets', () => Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k)).join(','));
const done = () => { out.totalMs = Date.now() - t0; process.stdout.write(JSON.stringify(out), () => process.exit(0)); };
fetch('http://127.0.0.1:' + port + '/ok').then((r) => { out.netProxy = { ok: r.status === 200 }; })
  .catch((e) => { out.netProxy = { ok: false, code: e.cause ? e.cause.code : e.message.slice(0, 30) }; })
  .then(() => fetch('http://127.0.0.1:' + (Number(port) + 1) + '/ok', { signal: AbortSignal.timeout(3000) }))
  .then((r) => { out.netOtherPort = { ok: r.status === 200 }; }).catch((e) => { out.netOtherPort = { ok: false, code: e.cause ? e.cause.code : e.message.slice(0, 30) }; })
  .then(() => fetch('https://example.com', { signal: AbortSignal.timeout(4000) }))
  .then((r) => { out.netInternet = { ok: r.status === 200 }; }).catch((e) => { out.netInternet = { ok: false, code: e.cause ? e.cause.code : e.message.slice(0, 30) }; })
  .finally(done);
`;

describe.skipIf(!HAS_SEATBELT)('the no-container sandbox, live', { timeout: 120_000 }, () => {
  let root: string;
  let work: string;
  let secret: string;
  let home: string;
  let app: string;
  let tmp: string;
  let server: http.Server;
  let other: http.Server;
  let port = 0;

  beforeAll(async () => {
    // Under /private/tmp so the paths are short and outside any home folder.
    root = fs.mkdtempSync('/private/tmp/fren-sb-');
    work = path.join(root, 'work');
    secret = path.join(root, 'secret');
    home = path.join(root, 'home');
    app = path.join(root, 'app');
    tmp = path.join(root, 'tmp');
    for (const d of [work, secret, home, app, tmp]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(secret, 'key.txt'), 'SECRET');
    fs.writeFileSync(path.join(secret, 'other-session.db'), 'OTHER');
    fs.writeFileSync(path.join(home, '.zshrc'), 'export SECRET=1');
    fs.writeFileSync(path.join(app, 'probe.js'), PROBE);
    server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
    other = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>((r) => other.listen(port + 1, '127.0.0.1', () => r()));
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => other.close(r));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync('/tmp/fren-confinement-escape.txt', { force: true });
  });

  const runs = new Map<string, Record<string, { ok: boolean; code?: string; value?: string }>>();
  async function run(network: 'none' | 'proxy' | 'internet'): Promise<Record<string, { ok: boolean; code?: string; value?: string }>> {
    const cached = runs.get(network);
    if (cached) return cached;
    const nodeDir = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
    const profile = renderSandboxProfile({ runtimeDir: nodeDir, writableDirs: [work], readableDirs: [app], tmpDir: tmp, network, proxyPort: port });
    const profilePath = path.join(root, `profile-${network}.sb`);
    fs.writeFileSync(profilePath, profile);
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, process.execPath, path.join(app, 'probe.js'), work, secret, home, String(port)], {
      cwd: work,
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, FREN_SANDBOX_TOKEN: 'fren-not-a-secret-handle' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const [status, signal] = await new Promise<[number | null, string | null]>((resolve) => child.on('close', (c, sg) => resolve([c, sg])));
    clearTimeout(killer);
    if (!stdout) throw new Error(`probe did not run: status=${status} signal=${signal} stderr=${stderr.slice(-400)}`);
    const out = JSON.parse(stdout) as Record<string, { ok: boolean; code?: string; value?: string }>;
    runs.set(network, out);
    return out;
  }

  it("cannot read the person's home, other sessions, or anything beside its own folders", async () => {
    const out = await run('proxy');
    expect(out.readHome.ok).toBe(false);
    expect(out.readSecret.ok).toBe(false);
    expect(out.readSiblingSession.ok).toBe(false);
    expect(out.readEtcHosts.ok).toBe(true);
  });

  it('writes only inside its own folders', async () => {
    const out = await run('proxy');
    expect(out.writeWork.ok).toBe(true);
    expect(out.readWork.value).toBe('hi');
    expect(out.writeTmp.ok).toBe(false);
    expect(out.writeHome.ok).toBe(false);
    expect(out.writeSecret.ok).toBe(false);
    expect(fs.existsSync('/tmp/fren-confinement-escape.txt')).toBe(false);
    expect(fs.existsSync(path.join(home, 'fren-confinement-escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(secret, 'planted.txt'))).toBe(false);
  });

  it('cannot open applications, script the desktop, read the keychain, change settings, or capture the screen', async () => {
    const out = await run('proxy');
    expect(out.spawnLs.ok).toBe(true);
    for (const k of ['spawnOsascript', 'spawnOpen', 'spawnSecurity', 'spawnDefaults', 'spawnScreencapture']) expect(out[k].ok, k).toBe(false);
    expect(fs.existsSync(path.join(work, 'shot.png'))).toBe(false);
  });

  it('reaches only the credential proxy under the proxy grant, and nothing under none', async () => {
    const proxy = await run('proxy');
    expect(proxy.netProxy.ok).toBe(true);
    expect(proxy.netOtherPort.ok).toBe(false);
    expect(proxy.netInternet.ok).toBe(false);
    const none = await run('none');
    expect(none.netProxy.ok).toBe(false);
    expect(none.netInternet.ok).toBe(false);
  });

  it('sees no provider secret in its environment, only the proxy handle', async () => {
    const out = await run('proxy');
    expect(out.envSecrets.value).toBe('FREN_SANDBOX_TOKEN');
  });
});
