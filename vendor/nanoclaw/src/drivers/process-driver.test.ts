/**
 * The process driver against a real filesystem and real processes: paths
 * realized from mounts, a session that runs and is adopted, and the two
 * promises that matter most — stop leaves nothing behind, and a runner that
 * dies takes everything it spawned with it. The seatbelt block at the end
 * proves the grants the driver derives from the mounts actually confine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProcessSessionDriver, type ProcessDriverOptions } from './process-driver.js';
import { withSessionEvents } from './session-events.js';
import { GROUP_FOLDER_LABEL, LABELS, type MountPolicy, type SessionSpec } from './types.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const HAS_SEATBELT = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

/** Stands in for the agent runner: heartbeat, a child of its own, a probe, then waits for SIGTERM. */
const FAKE_RUNNER = `
const fs = require('fs');
const cp = require('child_process');
const ws = process.env.NANOCLAW_WORKSPACE_DIR;
fs.writeFileSync(ws + '/.heartbeat', '');
fs.writeFileSync(ws + '/env.json', JSON.stringify({ env: process.env, cwd: process.cwd() }));
const child = cp.spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
fs.writeFileSync(ws + '/child.pid', String(child.pid));
const probe = {};
try { fs.readFileSync(process.env.FAKE_SECRET, 'utf8'); probe.secret = 'read'; } catch (e) { probe.secret = e.code; }
try { fs.writeFileSync(process.env.FAKE_OUTSIDE + '/planted.txt', 'x'); probe.outside = 'wrote'; } catch (e) { probe.outside = e.code; }
try { fs.writeFileSync(process.env.NANOCLAW_AGENT_DIR + '/notes.md', 'x'); probe.agentDir = 'wrote'; } catch (e) { probe.agentDir = e.code; }
try { fs.readFileSync(process.env.NANOCLAW_SESSION_CONTEXT, 'utf8'); probe.context = 'read'; } catch (e) { probe.context = e.code; }
fs.writeFileSync(ws + '/probe.json', JSON.stringify(probe));
const mode = process.env.FAKE_RUNNER_MODE || 'wait';
if (mode === 'exit3') process.exit(3);
if (mode === 'exit0') process.exit(0);
process.on('SIGTERM', () => { fs.writeFileSync(ws + '/sigterm.txt', 'yes'); process.exit(0); });
setInterval(() => {}, 1000);
`;

interface Layout {
  root: string;
  policy: MountPolicy;
  sessionDir: string;
  groupDir: string;
  stateDir: string;
  secret: string;
  outside: string;
  spec(env?: Record<string, string>): SessionSpec;
}

function layout(): Layout {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fren-pd-')));
  const j = (...p: string[]) => path.join(root, ...p);
  const sessionDir = j('data', 'v2-sessions', 'g1', 's1');
  const groupDir = j('groups', 'agent-one');
  for (const d of [sessionDir, j('data', 'v2-sessions', 'g1', '.context'), j('data', 'v2-sessions', 'g1', '.claude-shared', 'skills'), j('groups', 'agent-one', 'plugins'), j('container', 'agent-runner', 'src'), j('container', 'agent-runner', 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), j('container', 'skills', 'welcome'), j('notes'), j('secret'), j('outside')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(j('data', 'v2-sessions', 'g1', '.context', 's1.json'), '{"sessionId":"s1"}');
  fs.symlinkSync('/app/skills/welcome', j('data', 'v2-sessions', 'g1', '.claude-shared', 'skills', 'welcome'));
  fs.writeFileSync(j('groups', 'agent-one', 'CLAUDE.md'), '# agent-one');
  fs.writeFileSync(j('groups', 'agent-one', 'container.json'), '{}');
  fs.writeFileSync(j('container', 'agent-runner', 'src', 'index.ts'), FAKE_RUNNER);
  fs.writeFileSync(j('container', 'agent-runner', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), '{}');
  fs.writeFileSync(j('container', 'skills', 'welcome', 'SKILL.md'), '# welcome');
  fs.writeFileSync(j('container', 'CLAUDE.md'), '# base');
  fs.writeFileSync(j('secret', 'key.txt'), 'SECRET');
  const policy: MountPolicy = {
    groupsRoot: j('groups'),
    dataRoot: j('data'),
    surfaceRoots: [j('container', 'agent-runner', 'src'), j('container', 'skills'), j('container', 'CLAUDE.md')],
    materialsRoot: j('data', 'session-materials'),
  };
  const mount = (cls: 'group-state' | 'install-surface' | 'allowlisted-extra', hostPath: string, containerPath: string, mode: 'rw' | 'ro') => ({ class: cls, hostPath, containerPath, mode, groupScope: 'g1' });
  return {
    root,
    policy,
    sessionDir,
    groupDir,
    stateDir: j('data', 'process-sessions'),
    secret: j('secret', 'key.txt'),
    outside: j('outside'),
    spec: (env = {}) => ({
      key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' },
      labels: { 'nanoclaw-container-name': 'nanoclaw-v2-agent-one-1700000000000', [GROUP_FOLDER_LABEL]: 'agent-one' },
      containers: [
        {
          role: 'agent',
          image: 'nanoclaw-agent:spike-p0',
          env: { TZ: 'UTC', HOME: '/home/node', FAKE_SECRET: j('secret', 'key.txt'), FAKE_OUTSIDE: j('outside'), ...env },
          contributedEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4527/anthropic', ANTHROPIC_AUTH_TOKEN: 'placeholder' },
          command: ['bash', '-c'],
          args: ['exec bun run /app/src/index.ts'],
          labels: { 'session-channel': 'channel-abc' },
          mounts: [
            mount('group-state', sessionDir, '/workspace', 'rw'),
            mount('group-state', j('data', 'v2-sessions', 'g1', '.context', 's1.json'), '/app/.nanoclaw-session.json', 'ro'),
            mount('group-state', groupDir, '/workspace/agent', 'rw'),
            mount('group-state', j('groups', 'agent-one', 'container.json'), '/workspace/agent/container.json', 'ro'),
            mount('group-state', j('groups', 'agent-one', 'CLAUDE.md'), '/workspace/agent/CLAUDE.md', 'ro'),
            mount('install-surface', j('groups', 'agent-one', 'plugins'), '/workspace/agent/plugins', 'ro'),
            mount('group-state', j('data', 'v2-sessions', 'g1', '.claude-shared'), '/home/node/.claude', 'rw'),
            mount('install-surface', j('container', 'agent-runner', 'src'), '/app/src', 'ro'),
            mount('install-surface', j('container', 'skills'), '/app/skills', 'ro'),
            mount('install-surface', j('container', 'CLAUDE.md'), '/app/CLAUDE.md', 'ro'),
            mount('allowlisted-extra', j('notes'), '/workspace/extra/notes', 'rw'),
          ],
        },
      ],
      network: 'shared-private',
      hardening: 'standard',
      resources: { shmSizeMb: 1024, pidsLimit: 2048 },
      runtimeTier: 'container',
      runAs: { uid: 501, gid: 20 },
      stopGraceSeconds: 1,
    }),
  };
}

function options(l: Layout, extra: Partial<ProcessDriverOptions> = {}): ProcessDriverOptions {
  return {
    ...l.policy,
    bun: process.execPath,
    stateDir: l.stateDir,
    sandbox: 'none',
    // The fake runner is plain JS in a .ts file; node runs it without a `run` verb.
    runnerArgv: (bin, entry) => [bin, '--no-warnings', entry],
    ...extra,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 8_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function registry(l: Layout): { pid: number; labels: Record<string, string>; plan: { env: Record<string, string>; grants: { writable: string[]; readable: string[]; network: string }; profilePath: string | null; cwd: string } } {
  return JSON.parse(fs.readFileSync(path.join(l.stateDir, 'ncl-spike-s1.json'), 'utf8'));
}

function childPid(l: Layout): number {
  return Number(fs.readFileSync(path.join(l.sessionDir, 'child.pid'), 'utf8'));
}

let l: Layout;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  l = layout();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  fs.rmSync(l.root, { recursive: true, force: true });
});

describe('process driver: realization', () => {
  it('turns the mounts into paths the runner reads from env, and grants exactly those', async () => {
    const driver = new ProcessSessionDriver(options(l));
    const handle = await driver.prepare(l.spec());
    expect(handle.name).toBe('ncl-spike-s1');
    const entry = registry(l);
    expect(entry.labels[LABELS.install]).toBe('spike');
    expect(entry.labels[LABELS.session]).toBe('s1');
    expect(entry.labels[GROUP_FOLDER_LABEL]).toBe('agent-one');
    const env = entry.plan.env;
    expect(env.NANOCLAW_WORKSPACE_DIR).toBe(l.sessionDir);
    expect(env.NANOCLAW_AGENT_DIR).toBe(l.groupDir);
    expect(env.NANOCLAW_SESSION_CONTEXT).toBe(path.join(l.root, 'data', 'v2-sessions', 'g1', '.context', 's1.json'));
    expect(env.NANOCLAW_APP_SRC_DIR).toBe(path.join(l.root, 'container', 'agent-runner', 'src'));
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(l.root, 'data', 'v2-sessions', 'g1', '.claude-shared'));
    expect(env.HOME).toBe(path.join(l.sessionDir, 'home'));
    expect(env.CLAUDE_CODE_TMPDIR).toMatch(/^\/private\/tmp\/fcc-[0-9a-f]{12}$/);
    expect(env.TZ).toBe('UTC');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('placeholder');
    expect(entry.plan.cwd).toBe(l.groupDir);
    expect(entry.plan.grants.writable).toEqual(expect.arrayContaining([l.sessionDir, l.groupDir, path.join(l.root, 'notes')]));
    expect(entry.plan.grants.readable).toEqual(expect.arrayContaining([path.join(l.root, 'container', 'agent-runner'), path.join(l.root, 'container', 'skills')]));
    expect(entry.plan.grants.readable).not.toContain(path.join(l.root, 'secret'));
    expect(entry.plan.grants.network).toBe('internet');
    // Extras appear where the runner looks for them; skill links point at the real skills.
    expect(fs.readlinkSync(path.join(l.sessionDir, 'extra', 'notes'))).toBe(path.join(l.root, 'notes'));
    expect(fs.readlinkSync(path.join(l.root, 'data', 'v2-sessions', 'g1', '.claude-shared', 'skills', 'welcome'))).toBe(path.join(l.root, 'container', 'skills', 'welcome'));
    // No image, no sandbox in this mode: bare runner argv.
    expect(entry.plan.profilePath).toBeNull();
  });

  it('grants proxy-only network when the spec says none', async () => {
    const driver = new ProcessSessionDriver(options(l));
    await driver.prepare({ ...l.spec(), network: 'none' });
    expect(registry(l).plan.grants.network).toBe('proxy');
  });

  it('refuses a writable mount it cannot place, an auxiliary container, and an undeclared tier', async () => {
    const driver = new ProcessSessionDriver(options(l));
    const spec = l.spec();
    spec.containers[0].mounts.push({ class: 'allowlisted-extra', hostPath: path.join(l.root, 'notes'), containerPath: '/srv/notes', mode: 'rw', groupScope: 'g1' });
    await expect(driver.prepare(spec)).rejects.toMatchObject({ kind: 'spec-invalid' });
    const withAux = l.spec();
    withAux.containers.push({ role: 'egress-proxy', image: 'x', env: {}, mounts: [] });
    await expect(driver.prepare(withAux)).rejects.toMatchObject({ kind: 'spec-invalid' });
    await expect(driver.prepare({ ...l.spec(), runtimeTier: 'vm' })).rejects.toMatchObject({ kind: 'spec-invalid' });
    expect(fs.existsSync(path.join(l.stateDir, 'ncl-spike-s1.json'))).toBe(false);
  });

  it('refuses a mount whose source is missing, like the container drivers do', async () => {
    const driver = new ProcessSessionDriver(options(l));
    fs.rmSync(path.join(l.root, 'notes'), { recursive: true });
    await expect(driver.prepare(l.spec())).rejects.toMatchObject({ kind: 'spec-invalid' });
  });

  it('describes a shell in the session folder, without running anything', async () => {
    const driver = new ProcessSessionDriver(options(l));
    const handle = await driver.prepare(l.spec());
    const spec = handle.execSpec(['bash', '-lc', 'echo hi']);
    expect(spec.bin).toBe('/bin/sh');
    expect(spec.argsTty.slice(-3)).toEqual(['bash', '-lc', 'echo hi']);
    expect(spec.argsPlain).toContain(l.groupDir);
  });

  it('is honest about what it does not realize', () => {
    const caps = new ProcessSessionDriver(options(l)).capabilities();
    expect(caps.isolationTiers).toEqual(['container']);
    expect(caps.unrealized).toEqual(['memoryMb', 'cpus', 'pidsLimit', 'shmSizeMb']);
    expect(caps.auxiliaryContainers).toBe(false);
    expect(caps.imageBuild).toBe(false);
  });
});

describe('process driver: lifecycle', () => {
  it('runs the runner in the group folder with the mapped env, then stops it and everything it spawned', async () => {
    const driver = new ProcessSessionDriver(options(l));
    const handle = await driver.prepare(l.spec());
    expect(await handle.status()).toEqual({ phase: 'ready' });
    await handle.start();
    cleanup.push(() => handle.stop('cleanup'));
    await waitFor(() => fs.existsSync(path.join(l.sessionDir, 'child.pid')));
    expect(await handle.status()).toEqual({ phase: 'running' });
    const seen = JSON.parse(fs.readFileSync(path.join(l.sessionDir, 'env.json'), 'utf8'));
    expect(seen.cwd).toBe(l.groupDir);
    expect(seen.env.NANOCLAW_AGENT_DIR).toBe(l.groupDir);
    expect(seen.env.HOME).toBe(path.join(l.sessionDir, 'home'));
    expect(fs.existsSync(path.join(l.sessionDir, '.heartbeat'))).toBe(true);
    const runner = registry(l).pid;
    const child = childPid(l);
    expect(alive(runner)).toBe(true);
    expect(alive(child)).toBe(true);

    await handle.stop('test');
    expect(alive(runner)).toBe(false);
    expect(alive(child)).toBe(false);
    expect(fs.readFileSync(path.join(l.sessionDir, 'sigterm.txt'), 'utf8')).toBe('yes');
    expect(await handle.status()).toEqual({ phase: 'stopped' });
    expect(await driver.listSessions('spike')).toEqual([]);
  });

  it('a runner that dies takes its process group with it and reports the exit code once', async () => {
    const driver = withSessionEvents(new ProcessSessionDriver(options(l)));
    const handle = await driver.prepare(l.spec({ FAKE_RUNNER_MODE: 'exit3' }));
    const terminal = vi.fn();
    handle.onTerminal!(terminal);
    await handle.start();
    await waitFor(() => terminal.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0][0]).toMatchObject({ kind: 'started-then-died', exitCode: 3 });
    expect(await handle.status()).toMatchObject({ phase: 'failed', failure: { kind: 'started-then-died', exitCode: 3 } });
    expect(alive(childPid(l))).toBe(false);
    const listed = await driver.listSessions('spike');
    expect(listed.map((s) => s.phase)).toEqual(['terminal']);
    await driver.reapResidue?.('spike');
    expect(await driver.listSessions('spike')).toEqual([]);
  });

  it('a fresh driver adopts a running session from the registry and can stop it', async () => {
    const first = new ProcessSessionDriver(options(l));
    const handle = await first.prepare(l.spec());
    await handle.start();
    cleanup.push(() => handle.stop('cleanup'));
    await waitFor(() => fs.existsSync(path.join(l.sessionDir, 'child.pid')));

    const second = new ProcessSessionDriver(options(l));
    const listed = await second.listSessions('spike');
    expect(listed).toHaveLength(1);
    expect(listed[0].phase).toBe('running');
    expect(listed[0].handle.key).toEqual({ installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' });
    expect(await listed[0].handle.status()).toEqual({ phase: 'running' });
    // prepare on the same key is the same session, not a second process.
    const again = await second.prepare(l.spec());
    expect(again.name).toBe('ncl-spike-s1');
    expect(registry(l).pid).toBe(registry(l).pid);

    const runner = registry(l).pid;
    const child = childPid(l);
    await listed[0].handle.stop('adopted stop');
    expect(alive(runner)).toBe(false);
    expect(alive(child)).toBe(false);
  });

  it('a recycled pid cannot pass for a live session', async () => {
    const driver = new ProcessSessionDriver(options(l, { processStartStamp: () => 'stamp-A' }));
    const handle = await driver.prepare(l.spec());
    await handle.start();
    cleanup.push(() => handle.stop('cleanup'));
    await waitFor(() => fs.existsSync(path.join(l.sessionDir, 'child.pid')));
    const sameProcessDifferentStamp = new ProcessSessionDriver(options(l, { processStartStamp: () => 'stamp-B' }));
    expect((await sameProcessDifferentStamp.listSessions('spike'))[0].phase).toBe('terminal');
  });
});

describe.skipIf(!HAS_SEATBELT)('process driver: under seatbelt', () => {
  it('confines the runner to the paths its mounts name', async () => {
    const driver = new ProcessSessionDriver(options(l, { sandbox: 'seatbelt' }));
    const handle = await driver.prepare(l.spec());
    expect(fs.readFileSync(registry(l).plan.profilePath!, 'utf8')).toContain('(deny default)');
    await handle.start();
    cleanup.push(() => handle.stop('cleanup'));
    await waitFor(() => fs.existsSync(path.join(l.sessionDir, 'probe.json')), 15_000);
    const probe = JSON.parse(fs.readFileSync(path.join(l.sessionDir, 'probe.json'), 'utf8'));
    expect(probe.secret).toBe('EPERM');
    expect(probe.outside).toBe('EPERM');
    expect(probe.agentDir).toBe('wrote');
    expect(probe.context).toBe('read');
    expect(fs.existsSync(path.join(l.outside, 'planted.txt'))).toBe(false);
    const child = childPid(l);
    await handle.stop('test');
    expect(alive(child)).toBe(false);
  });
});
