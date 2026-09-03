/**
 * Process driver — the no-container realization.
 *
 * Runs the agent runner as a plain process on the host, confined by the
 * operating system's own sandbox (macOS seatbelt through `sandbox-exec`).
 * There is no image, no daemon, and nothing to install beside a Bun binary
 * and the runner source this tree already carries.
 *
 * What the seam calls a container is here a process group under a sandbox
 * profile rendered per session (`sandbox-profile.ts`). Mounts become paths:
 * the runner learns its locations from env (`container/agent-runner/src/paths.ts`)
 * and the profile grants exactly those paths, writable or read-only as the
 * mount says. Resource limits are not realized and `capabilities()` says so;
 * this tier is lighter than a container and never claims otherwise.
 *
 * Identity and adoption: every session this driver starts is written to a
 * registry file under the data root, carrying the canonical labels, the pid,
 * and the kernel's start stamp for that pid. `listSessions` reads the
 * registry and asks the kernel whether each pid is still the same process —
 * a recycled pid cannot pass for a live session because its start stamp
 * differs.
 */
import { spawn as nodeSpawn, execFileSync, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

import { validateRuntimeName } from './cli.js';
import { NEVER_EXEC, renderSandboxProfile, type NetworkGrant } from './sandbox-profile.js';
import {
  labelsForKey,
  specInvalid,
  validateSpec,
  type ContainerSpec,
  type DriverCapabilities,
  type MountPolicy,
  type SessionDriver,
  type SessionEvent,
  type SessionExecSpec,
  type SessionFailure,
  type SessionHandle,
  type SessionKey,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

export interface ProcessDriverOptions extends MountPolicy {
  /** The Bun binary that runs the runner and its MCP server. */
  bun: string;
  /** The Claude Code executable the runner's SDK drives. Unset leaves the runner's default. */
  claude?: string;
  /** Further executables the sandbox may run (a bundled node, say). */
  tools?: string[];
  /** Further read-only roots the runtime needs (a bundled CLI's install dir, say). */
  readable?: string[];
  /** Registry, profiles, and logs. Default: `<dataRoot>/process-sessions`. */
  stateDir?: string;
  /** 'seatbelt' confines through /usr/bin/sandbox-exec; 'none' runs bare and is for tests only. */
  sandbox?: 'seatbelt' | 'none';
  /** The network a session gets. Default: proxy-only when the spec says 'none', the internet otherwise. */
  networkFor?: (spec: SessionSpec) => NetworkGrant;
  /** How the runner is invoked: `[bun, 'run', entry]` by default. Test seam. */
  runnerArgv?: (bun: string, entry: string) => string[];
  /** Test seams. */
  spawn?: typeof nodeSpawn;
  processStartStamp?: (pid: number) => string | null;
}

/** Container-side locations the composer's mounts land on (see the runner's paths.ts). */
const CONTAINER = {
  workspace: '/workspace',
  agent: '/workspace/agent',
  extra: '/workspace/extra',
  context: '/app/.nanoclaw-session.json',
  appSrc: '/app/src',
  skills: '/app/skills',
  claudeDir: '/home/node/.claude',
} as const;

const RUN_CWD_ROOT = '/private/tmp/fren-process';
/** Claude Code's runtime dir root; kept short (socket paths cap near 104 bytes). */
const CLAUDE_TMP_ROOT = '/private/tmp';
const POLL_MS = 1_000;
const KILL_WAIT_MS = 5_000;
const STDERR_TAIL = 10;

/** One session as the registry records it: enough to rebuild a handle from. */
interface RegistryEntry {
  name: string;
  key: SessionKey;
  labels: Record<string, string>;
  pid?: number;
  /** The kernel's start stamp for `pid`; liveness requires it to match. */
  startStamp?: string;
  startedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  exitedAt?: string;
  stopRequested?: boolean;
  /** The realized plan, so an adopted handle can still stop and describe itself. */
  plan: RunPlan;
}

interface RunPlan {
  argv: string[];
  /** The bun process's own cwd. Under the sandbox this is a neutral dir OUTSIDE
   *  the install tree: bun walks up from cwd reading .env/config, and a denied
   *  read of the repo's own .env (which holds the real keys) wipes its whole
   *  environment. The runner reads its locations from env, never from cwd. */
  cwd: string;
  /** Where an operator's attach lands: the group folder. */
  attachDir: string;
  runCwd: string | null;
  /** Claude Code's own runtime dir (sockets, per-cwd state), short and per-session,
   *  so the agent never touches the host user's shared /tmp/claude-<uid>. */
  claudeTmp: string;
  env: Record<string, string>;
  profilePath: string | null;
  logPath: string;
  stopGraceSeconds: number;
  /** The paths this session was granted, for the record. */
  grants: { writable: string[]; readable: string[]; network: NetworkGrant };
}

interface InstallWatch {
  subscribers: Set<(event: SessionEvent) => void>;
  timer: NodeJS.Timeout | null;
  /** Names seen alive on the last poll, to emit terminal exactly on the transition. */
  alive: Set<string>;
}

export class ProcessSessionDriver implements SessionDriver {
  readonly kind = 'process' as const;
  readonly #policy: MountPolicy;
  readonly #opts: ProcessDriverOptions;
  readonly #stateDir: string;
  readonly #spawn: typeof nodeSpawn;
  readonly #startStamp: (pid: number) => string | null;
  readonly #watches = new Map<string, InstallWatch>();
  /** Children this incarnation started, by session name. */
  readonly #children = new Map<string, ChildProcess>();

  constructor(opts: ProcessDriverOptions) {
    this.#opts = opts;
    this.#policy = opts;
    this.#stateDir = opts.stateDir ?? path.join(opts.dataRoot, 'process-sessions');
    this.#spawn = opts.spawn ?? nodeSpawn;
    this.#startStamp = opts.processStartStamp ?? processStartStamp;
  }

  capabilities(): DriverCapabilities {
    return {
      // The seam has no lighter tier name; the composer defaults to
      // 'container' and this driver realizes it with an OS sandbox instead.
      isolationTiers: ['container'],
      admissionEnforced: false,
      networkPolicy: 'declarative',
      encryptedVolumes: false,
      // A process has no cgroup: none of the resource limits are realized.
      unrealized: ['memoryMb', 'cpus', 'pidsLimit', 'shmSizeMb'],
      // The runner shares the host's loopback.
      sharedNetworkNamespace: true,
      auxiliaryContainers: false,
      imageBuild: false,
    };
  }

  async ensureReady(): Promise<void> {
    const sandbox = this.#opts.sandbox ?? 'seatbelt';
    if (sandbox === 'seatbelt' && !fs.existsSync('/usr/bin/sandbox-exec')) {
      throw new Error('process driver: /usr/bin/sandbox-exec is missing; the no-container tier needs macOS');
    }
    try {
      fs.accessSync(this.#opts.bun, fs.constants.X_OK);
    } catch {
      throw new Error(`process driver: Bun is not executable at ${this.#opts.bun}`);
    }
    const runnerRoot = path.dirname(this.#policy.surfaceRoots[0] ?? '');
    if (!fs.existsSync(path.join(runnerRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'))) {
      throw new Error(`process driver: runner dependencies are not installed under ${runnerRoot} (bun install)`);
    }
    fs.mkdirSync(this.#stateDir, { recursive: true });
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.#policy, this.capabilities());
    const extra = spec.containers.filter((c) => c.role !== 'agent');
    if (extra.length > 0) {
      throw specInvalid(
        `process driver does not manage container role '${extra[0].role}'; ` +
          `auxiliary containers require a driver with capabilities().auxiliaryContainers`,
      );
    }
    const agent = spec.containers.find((c) => c.role === 'agent')!;
    const name = validateRuntimeName(sessionName(spec), 'process session');
    fs.mkdirSync(this.#stateDir, { recursive: true });

    // Idempotency on key: a live process for this key is the session.
    const existing = this.#read(name);
    if (existing && sameKey(existing.key, spec.key) && this.#alive(existing)) {
      return this.#handleFor(existing);
    }
    if (existing && !sameKey(existing.key, spec.key)) {
      throw Object.assign(new Error(`session name '${name}' belongs to another key`), {
        kind: 'unknown',
        retryable: false,
        opaqueRef: 'name-collision',
      });
    }

    const plan = this.#realize(spec, agent, name);
    const entry: RegistryEntry = { name, key: spec.key, labels: labelsForKey(spec.key, 'agent', spec.labels), plan };
    this.#write(entry);
    return this.#handleFor(entry);
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    const out: SessionSnapshot[] = [];
    for (const entry of this.#entries()) {
      if (entry.key.installSlug !== installSlug) continue;
      const alive = this.#alive(entry);
      const phase = alive ? 'running' : entry.pid === undefined ? 'starting' : 'terminal';
      const failure = !alive && entry.pid !== undefined ? failureOf(entry) : undefined;
      out.push(failure ? { handle: this.#handleFor(entry), phase, failure } : { handle: this.#handleFor(entry), phase });
    }
    return out;
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    let watch = this.#watches.get(installSlug);
    if (!watch) {
      watch = { subscribers: new Set(), timer: null, alive: new Set() };
      this.#watches.set(installSlug, watch);
    }
    watch.subscribers.add(onEvent);
    if (!watch.timer) {
      for (const entry of this.#entries()) if (entry.key.installSlug === installSlug && this.#alive(entry)) watch.alive.add(entry.name);
      watch.timer = setInterval(() => this.#poll(installSlug), POLL_MS);
      watch.timer.unref();
    }
    return {
      stop: () => {
        const w = this.#watches.get(installSlug);
        if (!w) return;
        w.subscribers.delete(onEvent);
        if (w.subscribers.size === 0) {
          if (w.timer) clearInterval(w.timer);
          this.#watches.delete(installSlug);
        }
      },
    };
  }

  async reapResidue(installSlug: string): Promise<void> {
    for (const entry of this.#entries()) {
      if (entry.key.installSlug !== installSlug) continue;
      if (entry.pid !== undefined && !this.#alive(entry)) this.#forget(entry);
    }
  }

  // ---- realization ---------------------------------------------------------

  #realize(spec: SessionSpec, agent: ContainerSpec, name: string): RunPlan {
    const at = new Map<string, { hostPath: string; ro: boolean }>();
    for (const m of agent.mounts) {
      if (!fs.existsSync(m.hostPath)) throw specInvalid(`mount source does not exist: ${m.hostPath}`);
      at.set(m.containerPath, { hostPath: m.hostPath, ro: m.mode === 'ro' });
    }
    const need = (containerPath: string): string => {
      const m = at.get(containerPath);
      if (!m) throw specInvalid(`process driver needs a mount at '${containerPath}'`);
      return m.hostPath;
    };
    const workspace = need(CONTAINER.workspace);
    const agentDir = need(CONTAINER.agent);
    const context = need(CONTAINER.context);
    const appSrc = need(CONTAINER.appSrc);
    const skills = at.get(CONTAINER.skills)?.hostPath ?? null;
    const claudeDir = at.get(CONTAINER.claudeDir)?.hostPath ?? path.join(workspace, 'home', '.claude');

    const extras: Array<{ name: string; hostPath: string; ro: boolean }> = [];
    const writable = new Set<string>([workspace, agentDir, claudeDir]);
    const readable = new Set<string>([path.dirname(appSrc), context, ...(this.#opts.readable ?? [])]);
    if (skills) readable.add(skills);
    for (const [containerPath, m] of at) {
      if (containerPath === CONTAINER.workspace || containerPath === CONTAINER.agent || containerPath === CONTAINER.context) continue;
      if (containerPath === CONTAINER.appSrc || containerPath === CONTAINER.skills || containerPath === CONTAINER.claudeDir) continue;
      if (containerPath.startsWith(`${CONTAINER.extra}/`)) {
        const rel = containerPath.slice(CONTAINER.extra.length + 1);
        if (rel.includes('/') || rel === '') throw specInvalid(`process driver cannot place a mount at '${containerPath}'`);
        extras.push({ name: rel, hostPath: m.hostPath, ro: m.ro });
        (m.ro ? readable : writable).add(m.hostPath);
        continue;
      }
      if (containerPath.startsWith(`${CONTAINER.agent}/`) && within(m.hostPath, agentDir)) {
        // Nested in place: the group's own files already sit inside the group folder on the host.
        continue;
      }
      if (m.ro) {
        // A read-only mount the runner never looks up by its container path
        // (the base CLAUDE.md the host inlines, say) costs nothing to grant.
        readable.add(m.hostPath);
        continue;
      }
      throw specInvalid(`process driver cannot place a writable mount at '${containerPath}'`);
    }

    const entry = runnerEntry(agent, appSrc);
    // Claude Code opens sockets under CLAUDE_CODE_TMPDIR; without it, the fixed
    // /tmp/claude-<uid> (the host user's own, holding every other project's
    // sessions) which the sandbox denies. A short per-session dir keeps socket
    // paths under the ~104-byte limit and isolates the agent's runtime state.
    const claudeTmp = path.join(CLAUDE_TMP_ROOT, `fcc-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`);
    const home = path.join(workspace, 'home');
    const tmp = path.join(workspace, 'tmp');
    const extraDir = path.join(workspace, 'extra');
    for (const d of [home, tmp, extraDir, claudeDir, claudeTmp]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    writable.add(claudeTmp);
    for (const e of extras) {
      const link = path.join(extraDir, e.name);
      unlinkIfPresent(link);
      fs.symlinkSync(e.hostPath, link);
    }
    if (skills) repointSkillLinks(claudeDir, skills);

    const bun = fs.realpathSync(this.#opts.bun);
    const tools = [...(this.#opts.tools ?? [])];
    if (this.#opts.claude) {
      const claude = fs.realpathSync(this.#opts.claude);
      tools.push(claude);
      readable.add(path.dirname(claude));
    }
    for (const t of tools) if (NEVER_EXEC.includes(t)) throw specInvalid(`process driver refuses to allow ${t}`);

    const env: Record<string, string> = {
      ...agent.env,
      ...(agent.contributedEnv ?? {}),
      HOME: home,
      TMPDIR: tmp,
      PATH: `${path.dirname(bun)}:/usr/bin:/bin`,
      CLAUDE_CONFIG_DIR: claudeDir,
      NANOCLAW_WORKSPACE_DIR: workspace,
      NANOCLAW_AGENT_DIR: agentDir,
      NANOCLAW_APP_SRC_DIR: appSrc,
      NANOCLAW_SESSION_CONTEXT: context,
      NANOCLAW_EXTRA_DIR: extraDir,
      CLAUDE_CODE_TMPDIR: claudeTmp,
    };
    if (this.#opts.claude) env.NANOCLAW_CLAUDE_EXECUTABLE = fs.realpathSync(this.#opts.claude);

    const network = this.#opts.networkFor ? this.#opts.networkFor(spec) : spec.network === 'none' ? 'proxy' : 'internet';
    const proxyPort = proxyPortOf(env);
    if (network === 'proxy' && proxyPort === null) {
      throw specInvalid('process driver: the proxy grant needs a loopback ANTHROPIC_BASE_URL to allow');
    }

    const sandbox = this.#opts.sandbox ?? 'seatbelt';
    const runner = (this.#opts.runnerArgv ?? ((b, e) => [b, 'run', e]))(bun, entry);
    let profilePath: string | null = null;
    let runCwd: string | null = null;
    let cwd = agentDir;
    let argv = runner;
    if (sandbox === 'seatbelt') {
      runCwd = path.join(RUN_CWD_ROOT, name);
      fs.mkdirSync(runCwd, { recursive: true, mode: 0o700 });
      cwd = runCwd;
      writable.add(runCwd);
      const profile = renderSandboxProfile({
        runtimeDir: path.dirname(bun),
        writableDirs: [...writable],
        readableDirs: [...readable],
        tmpDir: tmp,
        tools,
        network,
        proxyPort: proxyPort ?? undefined,
      });
      profilePath = path.join(this.#stateDir, `${name}.sb`);
      fs.writeFileSync(profilePath, profile, { mode: 0o600 });
      argv = ['/usr/bin/sandbox-exec', '-f', profilePath, ...runner];
    }
    return {
      argv,
      cwd,
      attachDir: agentDir,
      runCwd,
      claudeTmp,
      env,
      profilePath,
      logPath: path.join(this.#stateDir, `${name}.log`),
      stopGraceSeconds: Math.max(1, spec.stopGraceSeconds),
      grants: { writable: [...writable], readable: [...readable], network },
    };
  }

  // ---- lifecycle ----------------------------------------------------------

  #handleFor(entry: RegistryEntry): SessionHandle {
    return new ProcessHandle(entry, this);
  }

  /** @internal */
  async start(name: string): Promise<void> {
    const entry = this.#read(name);
    if (!entry) throw new Error(`process driver: no registry entry for ${name}`);
    if (entry.pid !== undefined) return;
    const { plan } = entry;
    fs.mkdirSync(path.dirname(plan.logPath), { recursive: true });
    const logFd = fs.openSync(plan.logPath, 'a');
    let child: ChildProcess;
    try {
      child = this.#spawn(plan.argv[0], plan.argv.slice(1), {
        cwd: plan.cwd,
        env: plan.env,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      fs.closeSync(logFd);
      throw runtimeUnavailable(error);
    }
    const tail: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      fs.writeSync(logFd, chunk);
      for (const line of chunk.toString().split('\n')) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > STDERR_TAIL) tail.shift();
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => reject(runtimeUnavailable(error)));
    }).catch((error) => {
      fs.closeSync(logFd);
      throw error;
    });
    const pid = child.pid!;
    entry.pid = pid;
    entry.startStamp = this.#startStamp(pid) ?? '';
    entry.startedAt = new Date().toISOString();
    this.#write(entry);
    this.#children.set(name, child);
    child.on('exit', (code, signal) => {
      fs.closeSync(logFd);
      this.#children.delete(name);
      // Nothing outlives the runner: whatever it spawned goes with it.
      killGroup(pid, 'SIGKILL');
      const now = this.#read(name);
      if (now) {
        now.exitCode = code;
        now.signal = signal;
        now.exitedAt = new Date().toISOString();
        this.#write(now);
        if (code !== 0 && !now.stopRequested) {
          log.warn(`[process-driver] session ${name} exited ${code ?? signal}`, { stderrTail: tail });
        }
      }
      this.#emit(entry.key, 'terminal');
    });
  }

  /** @internal */
  async status(name: string): Promise<SessionStatus> {
    const entry = this.#read(name);
    if (!entry) return { phase: 'stopped' };
    if (entry.pid === undefined) return { phase: 'ready' };
    if (this.#alive(entry)) return { phase: 'running' };
    const failure = failureOf(entry);
    return failure ? { phase: 'failed', failure } : { phase: 'stopped' };
  }

  /** @internal */
  async stop(name: string): Promise<void> {
    const entry = this.#read(name);
    if (!entry) return;
    if (entry.pid !== undefined && this.#alive(entry)) {
      entry.stopRequested = true;
      this.#write(entry);
      killGroup(entry.pid, 'SIGTERM');
      const grace = entry.plan.stopGraceSeconds * 1_000;
      if (!(await this.#waitGone(entry, grace))) {
        killGroup(entry.pid, 'SIGKILL');
        if (!(await this.#waitGone(entry, KILL_WAIT_MS))) {
          throw new Error(`process driver: session ${name} (pid ${entry.pid}) would not die`);
        }
      }
      killGroup(entry.pid, 'SIGKILL');
    }
    this.#forget(entry);
  }

  async #waitGone(entry: RegistryEntry, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!this.#alive(entry)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !this.#alive(entry);
  }

  #poll(installSlug: string): void {
    const watch = this.#watches.get(installSlug);
    if (!watch) return;
    const seen = new Set<string>();
    for (const entry of this.#entries()) {
      if (entry.key.installSlug !== installSlug) continue;
      const alive = this.#alive(entry);
      if (alive) seen.add(entry.name);
      if (!alive && watch.alive.has(entry.name)) this.#emit(entry.key, 'terminal');
    }
    watch.alive = seen;
  }

  #emit(key: SessionKey, kind: SessionEvent['kind']): void {
    const watch = this.#watches.get(key.installSlug);
    if (!watch) return;
    watch.alive.delete(sessionNameFor(key));
    for (const fn of watch.subscribers) {
      try {
        fn({ key, kind });
      } catch (error) {
        log.warn('[process-driver] watch subscriber threw', { error: String(error) });
      }
    }
  }

  // ---- registry -----------------------------------------------------------

  #alive(entry: RegistryEntry): boolean {
    if (entry.pid === undefined) return false;
    if (entry.exitedAt) return false;
    try {
      process.kill(entry.pid, 0);
    } catch {
      return false;
    }
    const stamp = this.#startStamp(entry.pid);
    return stamp !== null && stamp === (entry.startStamp ?? '');
  }

  #file(name: string): string {
    return path.join(this.#stateDir, `${name}.json`);
  }

  #read(name: string): RegistryEntry | null {
    try {
      return JSON.parse(fs.readFileSync(this.#file(name), 'utf8')) as RegistryEntry;
    } catch {
      return null;
    }
  }

  #write(entry: RegistryEntry): void {
    const file = this.#file(entry.name);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(entry, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  #forget(entry: RegistryEntry): void {
    fs.rmSync(this.#file(entry.name), { force: true });
    if (entry.plan.profilePath) fs.rmSync(entry.plan.profilePath, { force: true });
    if (entry.plan.runCwd) fs.rmSync(entry.plan.runCwd, { recursive: true, force: true });
    if (entry.plan.claudeTmp) fs.rmSync(entry.plan.claudeTmp, { recursive: true, force: true });
  }

  #entries(): RegistryEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.#stateDir);
    } catch {
      return [];
    }
    const out: RegistryEntry[] = [];
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      const entry = this.#read(f.slice(0, -'.json'.length));
      if (entry) out.push(entry);
    }
    return out;
  }
}

class ProcessHandle implements SessionHandle {
  readonly key: SessionKey;
  readonly name: string;
  readonly #cwd: string;

  constructor(entry: RegistryEntry, private readonly driver: ProcessSessionDriver) {
    this.key = entry.key;
    this.name = entry.name;
    this.#cwd = entry.plan.attachDir;
  }

  start(): Promise<void> {
    return this.driver.start(this.name);
  }

  status(): Promise<SessionStatus> {
    return this.driver.status(this.name);
  }

  stop(_reason: string): Promise<void> {
    return this.driver.stop(this.name);
  }

  /** A shell in the session's folder; the sandbox does not apply to an operator's attach. */
  execSpec(command: string[]): SessionExecSpec {
    const args = ['-c', 'cd "$0" && exec "$@"', this.#cwd, ...command];
    return { bin: '/bin/sh', argsTty: args, argsPlain: args };
  }
}

// ---- helpers ---------------------------------------------------------------

function sessionName(spec: SessionSpec): string {
  return sessionNameFor(spec.key);
}

/** `ncl-<slug>-<session>`, shortened with a hash past 48 chars — the Docker driver's shape. */
function sessionNameFor(key: SessionKey): string {
  const raw = `ncl-${key.installSlug}-${key.sessionId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
  if (raw.length <= 48) return raw;
  const digest = createHash('sha256').update(`${key.installSlug} ${key.sessionId}`).digest('hex').slice(0, 8);
  return `ncl-${raw.slice(4, 43)}-${digest}`;
}

function sameKey(a: SessionKey, b: SessionKey): boolean {
  return a.installSlug === b.installSlug && a.agentGroupId === b.agentGroupId && a.sessionId === b.sessionId;
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The runner entry the composer names, mapped from its container path to the host. */
function runnerEntry(agent: ContainerSpec, appSrc: string): string {
  const command = agent.command ?? [];
  const args = agent.args ?? [];
  const shell = command.join(' ') === 'bash -c' ? (args[0] ?? '') : '';
  const m = /^exec bun run (\S+)$/.exec(shell);
  if (!m) throw specInvalid(`process driver cannot run '${[...command, ...args].join(' ')}'`);
  const entry = m[1];
  if (!entry.startsWith(`${CONTAINER.appSrc}/`)) throw specInvalid(`process driver cannot run '${entry}' outside ${CONTAINER.appSrc}`);
  return path.join(appSrc, entry.slice(CONTAINER.appSrc.length + 1));
}

/** The host writes container-side skill links; on the host they must point at the real skills dir. */
function repointSkillLinks(claudeDir: string, skills: string): void {
  const dir = path.join(claudeDir, 'skills');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const link = path.join(dir, n);
    let target: string;
    try {
      target = fs.readlinkSync(link);
    } catch {
      continue;
    }
    if (!target.startsWith(`${CONTAINER.skills}/`)) continue;
    unlinkIfPresent(link);
    fs.symlinkSync(path.join(skills, target.slice(CONTAINER.skills.length + 1)), link);
  }
}

/** Removes a link or file if present; `rmSync({ force })` skips a dangling link because its stat fails. */
function unlinkIfPresent(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* not there */
  }
}

/** The loopback port of ANTHROPIC_BASE_URL, or null when it points anywhere else. */
function proxyPortOf(env: Record<string, string>): number | null {
  const raw = env.ANTHROPIC_BASE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null;
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  } catch {
    return null;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

function failureOf(entry: RegistryEntry): SessionFailure | undefined {
  if (entry.stopRequested) return undefined;
  if (entry.exitCode === 0) return undefined;
  const exitCode = typeof entry.exitCode === 'number' ? entry.exitCode : undefined;
  return exitCode === undefined ? { kind: 'started-then-died', retryable: false } : { kind: 'started-then-died', retryable: false, exitCode };
}

function runtimeUnavailable(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(`session realization failed: ${message}`), { kind: 'runtime-unavailable', retryable: true, detail: message });
}

/**
 * Driver options from the host's environment, for the registry factory that
 * only receives the mount policy. Nothing here is a secret.
 *
 *   NANOCLAW_PROCESS_BUN       Bun binary (default: the first `bun` on PATH)
 *   NANOCLAW_PROCESS_CLAUDE    Claude Code executable for the runner's SDK
 *   NANOCLAW_PROCESS_TOOLS     further executables the sandbox may run, ':'-separated
 *   NANOCLAW_PROCESS_READABLE  further read-only roots, ':'-separated
 *   NANOCLAW_PROCESS_NETWORK   'proxy' | 'internet' for every session (default: per spec)
 *   NANOCLAW_PROCESS_SANDBOX   'seatbelt' (default) | 'none' — bare processes, for development only
 */
export function processDriverOptionsFromEnv(env: NodeJS.ProcessEnv): Omit<ProcessDriverOptions, keyof MountPolicy> {
  const list = (v: string | undefined) => (v ?? '').split(':').filter(Boolean);
  const network = env.NANOCLAW_PROCESS_NETWORK;
  return {
    bun: env.NANOCLAW_PROCESS_BUN || findOnPath('bun', env.PATH) || 'bun',
    claude: env.NANOCLAW_PROCESS_CLAUDE || undefined,
    tools: list(env.NANOCLAW_PROCESS_TOOLS),
    readable: list(env.NANOCLAW_PROCESS_READABLE),
    sandbox: env.NANOCLAW_PROCESS_SANDBOX === 'none' ? 'none' : 'seatbelt',
    networkFor: network === 'proxy' || network === 'internet' ? () => network : undefined,
  };
}

function findOnPath(bin: string, PATH: string | undefined): string | null {
  for (const dir of (PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

/** The kernel's start stamp for a pid; the same pid with a different stamp is a different process. */
export function processStartStamp(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}
