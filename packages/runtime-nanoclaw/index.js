'use strict';
/**
 * The runtime adapter for the vendored host (docs/runtime-architecture.md).
 *
 * Everything FREN knows about how agents actually run lives in this package
 * and in vendor/. From the outside it is a FrenRuntime: sessions, runs,
 * schedules, permission requests, events. Inside, it supervises the host as
 * a child process, drives its control socket for entities and schedules,
 * and speaks to the host's fren channel over the bridge for everything that
 * moves: messages in, messages out, cards, typing, the end of a turn.
 *
 * What the host does not tell us, we say honestly: no token streaming, no
 * tool events, and a cancelled run is cancelled for FREN — the agent inside
 * finishes on its own.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { RuntimeUnavailable, newId, isTerminal } = require('../runtime');
const { parseCron } = require('../shared/cron');
const containerRuntime = require('./container-runtime');
const processRuntime = require('./process-runtime');
const { createNclClient } = require('./ncl-client');
const { createBridge } = require('./bridge');
const { createSupervisor } = require('./supervisor');
const { ensureEntities, OWNER_HANDLE, GROUP_FOLDER } = require('./bootstrap');
const { createScheduleStore, platformIdFor, DEFAULT_FAILURE } = require('./schedules');
const { createScheduleWatch, POLL_MS: SCHEDULE_WATCH_MS } = require('./schedule-watch');

const CAPABILITIES = Object.freeze({
  tokenStreaming: false,
  toolEvents: false,
  turnBoundary: 'exact',
  scheduleTrigger: 'cron',
  maxFiresPerDay: 4,
  isolation: 'container',
  files: true,
});

/**
 * The host names its image, its containers and its labels after a hash of
 * its own directory, in its TypeScript and in its shell build script alike.
 * Deriving the same value here keeps the image the build produces the one
 * the host looks for; forcing a different id would split them.
 */
function installSlug(runtimeDir) {
  return crypto.createHash('sha1').update(runtimeDir).digest('hex').slice(0, 8);
}
const CONNECT_TIMEOUT_MS = 30_000;
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];
const APPROVAL_OPTIONS = new Set(['approve', 'reject', 'reject_with_reason']);
const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
/** How long a scheduled run may wait on the host, across its watch windows and retries. */
const SCHEDULE_CEILING_MS = 2 * 60 * 60 * 1000;
/** How long a run the counters say has ended waits for its words and the turn frame that follows them. */
const SETTLE_GRACE_MS = 5_000;
/** How long a turn frame for a row no run is open for yet is kept. */
const LATE_TURN_MS = 30_000;

/**
 * Unix socket paths are capped at about 104 bytes on macOS. The app data
 * folder fits; a deep development or test directory may not, so the socket
 * then lives in a short private directory named after the data dir.
 */
function bridgeSocketPath(dataDir) {
  const preferred = path.join(dataDir, 'fren-runtime.sock');
  if (preferred.length <= 90) return preferred;
  const dir = path.join('/tmp', `fren-${crypto.createHash('sha1').update(dataDir).digest('hex').slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, 'runtime.sock');
}

/**
 * What the agent is told it is, before anything FREN's owner wrote. The host
 * composes its own contract around this file at every spawn; this file is the
 * one place FREN's voice enters the container. Never names the host.
 */
function composePersona(persona, { workspace = null } = {}) {
  return [
    '# fren',
    '',
    'You are fren, a small desktop companion that lives on this person\'s computer. When you act for',
    'them you do it from an isolated workspace with your own tools; the person sees what you send',
    'back and nothing else. You are fren: not an agent of the software that hosts you, and you do',
    'not describe that software or its internals unless asked directly.',
    '',
    'Be brief and warm: one to three short sentences, conversational, the way you would say it out',
    'loud. No lists, headings or bullet points unless the person asks for a list. Say what you did,',
    'not how. If you could not do something, say what stopped you in one sentence. If something truly',
    'needs more, give the short version first and offer the rest.',
    '',
    ...(workspace ? [`Your workspace folder on this machine is \`${workspace}\`. Where the base instructions name`, '/workspace/agent, that is this folder; use it, not the container path.', ''] : []),
    ...(persona ? ['What your owner wrote about who you are:', '', String(persona).trim(), ''] : []),
  ].join('\n');
}

function createNanoclawRuntime(opts) {
  const {
    dataDir, runtimeDir, sandboxUrl, sandboxToken, model, timezone,
    now = Date.now, log = console.log, probe = containerRuntime, processProbe = processRuntime,
    tier = 'auto', hostCommand = null, skipContainerProbe = false, connectTimeoutMs = CONNECT_TIMEOUT_MS,
    scheduleWatchMs = SCHEDULE_WATCH_MS, settleGraceMs = SETTLE_GRACE_MS,
  } = opts;
  if (!dataDir || !runtimeDir) throw new Error('the runtime needs dataDir and runtimeDir');

  let state = 'stopped';
  let since = 0;
  let reason = null;
  let hint = null;
  let restarts = 0;
  let restartTimer = null;
  let stopping = false;
  let agentGroupId = null;
  let personaText = null;
  let tierChosen = null;   // 'process' | 'container', once ensureHostReady decided
  let tierFound = null;    // what the process probe found, for the host's env

  const listeners = new Set();
  const sessions = new Map();     // id -> Session
  const runs = new Map();         // runId -> run
  const openByThread = new Map(); // threadId -> runId
  const seqByRun = new Map();
  const seqByAutomation = new Map();
  const pending = new Map();      // questionId -> { kind, runId }
  const watched = new Map();      // host row id -> FREN run id, for the turn and for watching again
  const earlyTurns = new Map();   // host row id -> turn frame that came before its run was open
  const runtimeToken = crypto.randomBytes(24).toString('hex');
  const slug = installSlug(runtimeDir);
  const socketPath = bridgeSocketPath(dataDir);
  const nclPath = path.join(runtimeDir, 'data', 'ncl.sock');

  const bridge = createBridge({ socketPath, token: runtimeToken, onFrame, log });
  const ncl = createNclClient({ socketPath: nclPath });
  let supervisor = null;
  let schedules = null;
  let scheduleWatch = null;

  // ------------------------------------------------------------ events
  function emit(event) {
    for (const fn of [...listeners]) {
      try { fn(event); } catch (err) { log(`[runtime] listener failed: ${err.message}`); }
    }
  }

  function status() {
    const base = tierChosen ? { state, tier: tierChosen } : { state };
    if (state === 'ready') return { ...base, since, sessions: sessions.size, runs: [...runs.values()].filter((r) => !isTerminal(r.status)).length };
    if (reason) base.reason = reason;
    if (hint) base.hint = hint;
    return base;
  }

  function setState(next, extra = {}) {
    state = next;
    reason = extra.reason || null;
    hint = extra.hint || null;
    if (next === 'ready') since = now();
    emit({ type: 'runtime.status', status: status() });
  }

  function snapshot(run) {
    return { ...run, messages: run.messages.map((m) => ({ ...m })) };
  }

  function finishRun(runId, statusName, error, detail, { fromHost = false } = {}) {
    const run = runs.get(runId);
    if (!run || isTerminal(run.status)) return;
    run.status = statusName;
    run.endedAt = now();
    if (error) run.error = error;
    if (run.sessionId && openByThread.get(run.sessionId) === runId) openByThread.delete(run.sessionId);
    emit({ type: 'agent.working', runId, sessionId: run.sessionId || undefined, on: false });
    emit({ type: `run.${statusName}`, runId, ...(error ? { error } : {}) });
    if (run.kind === 'schedule' && run.scheduleId) {
      if (run.rowId && watched.get(run.rowId) === runId) watched.delete(run.rowId);
      // The host's counters move for this end a sweep later. An end the host
      // confirmed is remembered so that move is not a second record; one the
      // watch already read off the counters needs nothing; one FREN decided on
      // its own (a cancel, a stop) only lets go of the row, so what the host
      // does with it is still reported.
      if (scheduleWatch && run.rowId && !run.counted) {
        if (fromHost) scheduleWatch.settled(run.scheduleId, run.rowId, statusName === 'completed');
        else scheduleWatch.release(run.scheduleId, run.rowId);
      }
      const why = error || detail;
      emit({
        type: statusName === 'completed' ? 'schedule.completed' : 'schedule.failed',
        scheduleId: run.scheduleId, automationId: run.automationId, runId, ...(why ? { detail: why } : {}),
      });
    }
  }


  function nextSeq(map, key) {
    const n = (map.get(key) || 0) + 1;
    map.set(key, n);
    return n;
  }

  // ------------------------------------------------------ bridge frames
  function onFrame(frame, reply) {
    switch (frame.type) {
      case 'connected':
        if (state === 'degraded') setState('ready');
        // Runs still waiting on the host are watched again on this connection.
        for (const [rowId, runId] of watched) {
          const run = runs.get(runId);
          if (run && !isTerminal(run.status)) bridge.send({ type: 'watch', runId: rowId });
        }
        return;
      case 'disconnected':
        if (state === 'ready' && !stopping) setState('degraded', { reason: 'the runtime host dropped its connection; reconnecting' });
        return;
      case 'deliver':
        return onDeliver(frame, reply);
      case 'typing': {
        const runId = openByThread.get(frame.threadId) || null;
        emit({ type: 'agent.working', runId: runId || undefined, sessionId: frame.threadId || undefined, on: frame.on !== false });
        return;
      }
      case 'turn': {
        const runId = watched.get(frame.runId) || frame.runId;
        const run = runs.get(runId);
        if (!run) {
          // The row's run is not open yet: a reading is on its way (a delivery
          // asked for one). Kept, and applied once the run is open and the
          // words have landed on it.
          earlyTurns.set(frame.runId, { frame, at: now() });
          return;
        }
        if (frame.status === 'completed') return finishRun(runId, 'completed', undefined, undefined, { fromHost: true });
        const timedOut = frame.detail === 'no acknowledgement in time';
        if (timedOut && run.kind === 'schedule' && run.rowId && now() - run.startedAt < SCHEDULE_CEILING_MS) {
          // The host's watch ran out, not the task: watch again. The
          // acknowledgement or the counters end it; the host's own ceiling
          // guarantees one of them comes.
          bridge.send({ type: 'watch', runId: run.rowId });
          return;
        }
        const why = frame.detail || (run.kind === 'schedule' ? DEFAULT_FAILURE : 'the agent did not finish');
        return finishRun(runId, 'failed', why, undefined, { fromHost: !timedOut });
      }
      case 'provenance':
        return; // logged by the host; nothing to do beyond the deliver itself
      default:
        return;
    }
  }

  function onDeliver(frame, reply) {
    const platformId = String(frame.platformId || '');
    const threadId = typeof frame.threadId === 'string' ? frame.threadId : null;
    const content = frame.content && typeof frame.content === 'object' ? frame.content : { text: String(frame.content || '') };
    const files = Array.isArray(frame.files) ? frame.files.map((f) => f.filename).filter(Boolean) : undefined;
    reply({ ok: true });

    // A card: an approval from the host's guard, or a question from the agent.
    if (content.type === 'ask_question' && typeof content.questionId === 'string') {
      const options = (content.options || []).map((o) => (typeof o === 'string' ? o : (o && (o.value || o.label)) || '')).filter(Boolean);
      // A card on the owner's DM has no thread. If exactly one run is waiting,
      // it is the one asking.
      const open = [...runs.values()].filter((r) => !isTerminal(r.status) && r.sessionId);
      const runId = openByThread.get(threadId) || (threadId === null && open.length === 1 ? open[0].id : null);
      const sessionId = threadId || (runId && runs.get(runId) ? runs.get(runId).sessionId : null);
      const isApproval = options.length > 0 && options.every((o) => APPROVAL_OPTIONS.has(o));
      if (isApproval || !runId) {
        pending.set(content.questionId, { kind: 'permission', runId });
        emit({
          type: 'permission.request',
          request: {
            id: content.questionId, action: String(content.title || 'approval'), title: String(content.title || ''),
            question: String(content.question || ''), options: options.length ? options : ['approve', 'reject'],
            sessionId: sessionId || undefined, automationId: automationIdFrom(platformId) || undefined,
          },
        });
      } else {
        pending.set(content.questionId, { kind: 'question', runId });
        emit({ type: 'agent.question', runId, questionId: content.questionId, title: String(content.title || ''), question: String(content.question || ''), options });
      }
      return;
    }
    if (content.operation) return; // edits and reactions have no FREN surface yet

    const text = typeof content.text === 'string' ? content.text : (typeof content.markdown === 'string' ? content.markdown : '');
    if (!text && !files) return;

    const automationId = automationIdFrom(platformId);
    if (automationId) return void landOnAutomation(automationId, text, files);

    const runId = openByThread.get(threadId) || null;
    if (!runId) {
      // Nobody asked: something the agent volunteered. Still a message.
      emit({ type: 'agent.message', sessionId: threadId || undefined, message: { seq: nextSeq(seqByAutomation, `thread:${threadId}`), at: now(), text, files, final: true } });
      return;
    }
    const run = runs.get(runId);
    if (run.status === 'queued') {
      run.status = 'running';
      emit({ type: 'run.started', runId });
    }
    const message = { seq: nextSeq(seqByRun, runId), at: now(), text, files, final: true };
    run.messages.push(message);
    emit({ type: 'agent.message', runId, message: { ...message } });
  }

  /**
   * What the schedule watch found on the host's task list. A fire the host
   * started on its own becomes a run like one FREN started, watched to its
   * acknowledgement; a fire that came and went becomes a run opened and
   * closed in one breath; a pause becomes the event Core switches the
   * automation off with.
   */
  async function onFinding(f) {
    const ref = schedules && schedules.refs.get(f.seriesId);
    if (!ref) return;
    const base = { scheduleId: f.seriesId, automationId: ref.automationId };
    const openRun = (synthetic) => {
      const run = { id: newId('run'), sessionId: null, kind: 'schedule', status: 'running', startedAt: now(), messages: [], scheduleId: f.seriesId, automationId: ref.automationId, ...(synthetic ? { synthetic: true } : {}) };
      runs.set(run.id, run);
      emit({ type: 'schedule.fired', ...base, runId: run.id });
      emit({ type: 'run.started', runId: run.id });
      return run;
    };
    switch (f.kind) {
      case 'fired': {
        const already = watched.has(f.rowId) ? runs.get(watched.get(f.rowId)) : null;
        if (already && !isTerminal(already.status)) return;
        const run = openRun(false);
        run.rowId = f.rowId;
        watched.set(f.rowId, run.id);
        bridge.send({ type: 'watch', runId: f.rowId });
        // A turn that came early applies after whatever delivery asked for this reading has landed.
        if (earlyTurns.has(f.rowId)) { const t = setTimeout(() => applyEarlyTurn(f.rowId), 50); if (t.unref) t.unref(); }
        return;
      }
      case 'settled': {
        const run = watched.has(f.rowId) ? runs.get(watched.get(f.rowId)) : null;
        if (!run || isTerminal(run.status)) return;
        return settleSoon(run, f.ok);
      }
      case 'missed': {
        // A counter moved with no fired row open. A run of this series still
        // open (a run-now, whose row the list hides) is what it explains.
        const open = [...runs.values()].find((r) => r.scheduleId === f.seriesId && !isTerminal(r.status) && !r.synthetic && !r.counted);
        if (open) return settleSoon(open, f.ok);
        const run = openRun(true);
        return finishRun(run.id, f.ok ? 'completed' : 'failed', f.ok ? undefined : DEFAULT_FAILURE, f.ok ? 'it ran, but sent nothing' : undefined);
      }
      case 'paused':
        if (ref.enabled === false) return; // FREN paused it; nothing to report
        emit({ type: 'schedule.paused', ...base, detail: f.detail });
        return;
      default:
        return;
    }
  }

  /**
   * Something sent to an automation's surface lands on its open run. When none
   * is open, the task list is read right now before giving up on one: a warm
   * container picks a due row up the moment it is due and can answer within
   * seconds, ahead of the watch's next reading.
   */
  async function landOnAutomation(automationId, text, files) {
    const openRunFor = () => [...runs.values()].find((r) => r.automationId === automationId && !isTerminal(r.status));
    let run = openRunFor();
    if (!run && scheduleWatch) {
      await scheduleWatch.pollNow();
      run = openRunFor();
    }
    const seq = run ? nextSeq(seqByRun, run.id) : nextSeq(seqByAutomation, automationId);
    const message = { seq, at: now(), text, files, final: true };
    if (run) run.messages.push(message);
    emit({ type: 'agent.message', ...(run ? { runId: run.id } : {}), automationId, message: { ...message } });
    if (run && run.rowId) applyEarlyTurn(run.rowId);
  }

  /** A turn frame kept for a run that was not open yet, applied now that it is. */
  function applyEarlyTurn(rowId) {
    const early = earlyTurns.get(rowId);
    if (!early) return;
    earlyTurns.delete(rowId);
    if (now() - early.at < LATE_TURN_MS) onFrame(early.frame, () => {});
  }

  /**
   * The host's counters say this run ended, but its words may still be on
   * their way (the host delivers on a poll of its own, a moment after the
   * container acknowledges) and the turn frame, which waits for them, is the
   * better end. Give it a moment; then end the run on the counters' word if
   * nothing else has.
   */
  function settleSoon(run, ok) {
    if (run.counted) return;
    run.counted = true; // this end is already off the counters; nothing to remember later
    const timer = setTimeout(() => {
      if (!runs.has(run.id) || isTerminal(run.status)) return;
      finishRun(run.id, ok ? 'completed' : 'failed', ok ? undefined : DEFAULT_FAILURE);
    }, settleGraceMs);
    if (timer.unref) timer.unref();
  }

  function automationIdFrom(platformId) {
    return platformId.startsWith('automation:') ? platformId.slice('automation:'.length) : null;
  }

  /** Write the standing instructions when they changed. Takes effect at the next spawn. */
  function writePersona(persona) {
    const text = composePersona(persona, { workspace: tierChosen === 'process' ? path.join(runtimeDir, 'groups', GROUP_FOLDER) : null });
    if (text === personaText) return;
    const dir = path.join(runtimeDir, 'groups', GROUP_FOLDER);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'instructions.prepend.md');
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (current !== text) fs.writeFileSync(file, text);
      personaText = text;
    } catch (err) {
      log(`[runtime] persona not written: ${err.message}`);
    }
  }

  // -------------------------------------------------------- lifecycle
  /**
   * Which tier runs the agents. 'process' is the no-container tier: the runner
   * as a sandboxed process on this machine, nothing to install. 'container'
   * needs a container runtime and the agent image. 'auto' takes the process
   * tier when this machine can, the container tier when it must.
   */
  async function ensureHostReady() {
    if (!skipContainerProbe) {
      const want = String(tier || 'auto').toLowerCase();
      const proc = want === 'container' ? null : processProbe.detect({ runtimeDir });
      if (proc && proc.available) {
        tierChosen = 'process';
        tierFound = proc;
      } else if (want === 'process') {
        throw new RuntimeUnavailable(proc.reason, proc.hint);
      } else {
        const rt = await probe.detect();
        if (!rt.running) {
          throw new RuntimeUnavailable(proc ? `${proc.reason}; and ${rt.reason}` : rt.reason, proc ? proc.hint : rt.hint);
        }
        const image = `nanoclaw-agent-v2-${slug}:latest`;
        if (!(await probe.imagePresent(image))) {
          throw new RuntimeUnavailable('the agent image is not built', 'Run: npm run runtime:build -- --image (this takes a few minutes the first time)');
        }
        tierChosen = 'container';
        tierFound = null;
      }
      if (!fs.existsSync(path.join(runtimeDir, 'dist', 'index.js'))) {
        throw new RuntimeUnavailable('the runtime host is not built', 'Run: npm run runtime:build');
      }
    }
    stampUpgradeMarker();
  }

  /** The host refuses to boot unless this marker matches the checkout (see §11.2). */
  function stampUpgradeMarker() {
    let version = '0.0.0';
    try { version = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'package.json'), 'utf8')).version || version; } catch { /* unknown */ }
    const git = (args) => {
      try { return execFileSync('git', ['-C', runtimeDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'unknown'; }
    };
    const marker = { version, commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), updatedAt: new Date(now()).toISOString(), via: 'fren-core' };
    fs.mkdirSync(path.join(runtimeDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'data', 'upgrade-state.json'), JSON.stringify(marker, null, 2) + '\n');
  }

  function hostEnv() {
    return {
      // The host shells `docker` by name; it gets the directory the probe found it in.
      PATH: probe.pathWithDocker ? probe.pathWithDocker(process.env) : (process.env.PATH || '/usr/local/bin:/usr/bin:/bin'),
      HOME: process.env.HOME || '',
      TZ: timezone || process.env.TZ || '',
      LANG: process.env.LANG || 'en_US.UTF-8',
      FREN_CORE_SOCKET: socketPath,
      FREN_RUNTIME_TOKEN: runtimeToken,
      FREN_SANDBOX_URL: (tierChosen === 'process' ? processProbe.sandboxUrlFor(sandboxUrl) : sandboxUrl) || '',
      FREN_SANDBOX_TOKEN: sandboxToken || '',
      NANOCLAW_GATEWAY_PROVIDER: 'fren',
      NANOCLAW_NO_DIAGNOSTICS: '1',
      LOG_LEVEL: process.env.FREN_RUNTIME_LOG_LEVEL || 'info',
      ...(tierChosen === 'process' ? processProbe.hostEnv(tierFound) : {}),
    };
  }

  async function waitForNcl(timeoutMs) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (fs.existsSync(nclPath) && (await ncl.alive())) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('the runtime host did not open its control socket in time');
  }

  async function boot() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, 'data'), { recursive: true });
    await bridge.listen();
    supervisor = createSupervisor({
      runtimeDir, env: hostEnv(), logDir: path.join(dataDir, 'logs'), log,
      command: hostCommand ? hostCommand[0] : process.execPath,
      args: hostCommand ? hostCommand[1] : ['dist/index.js'],
    });
    supervisor.onExit(onHostExit);
    supervisor.start();
    await Promise.all([bridge.waitForPeer(connectTimeoutMs), waitForNcl(connectTimeoutMs)]);
    const entities = await ensureEntities({ ncl, timezone, model, log });
    agentGroupId = entities.agentGroupId;
    writePersona(null);
    schedules = createScheduleStore({ ncl, agentGroupId, log });
    scheduleWatch = createScheduleWatch({ list: () => schedules.list(), onFinding, ready: () => state === 'ready', now, log, intervalMs: scheduleWatchMs });
    scheduleWatch.start();
    log(`[runtime] host ready (${Object.entries(entities.steps).map(([k, v]) => `${k}: ${v}`).join(', ')})`);
  }

  function onHostExit(info) {
    if (stopping) return;
    // A run waiting on a host row keeps waiting: the host retries the row and the
    // acknowledgement is watched for again once it is back. Chat turns end here.
    for (const run of runs.values()) if (!isTerminal(run.status) && !(run.kind === 'schedule' && run.rowId)) finishRun(run.id, 'failed', 'the secure execution environment restarted');
    if (restarts >= RESTART_BACKOFF_MS.length) {
      setState('unavailable', { reason: 'the runtime host keeps exiting', hint: (info && info.stderr && info.stderr.slice(-3).join(' ')) || 'see logs/runtime.log' });
      return;
    }
    const delay = RESTART_BACKOFF_MS[restarts];
    restarts += 1;
    setState('degraded', { reason: `the runtime host exited; restarting in ${Math.round(delay / 1000)} s` });
    restartTimer = setTimeout(async () => {
      try {
        supervisor.start();
        await Promise.all([bridge.waitForPeer(connectTimeoutMs), waitForNcl(connectTimeoutMs)]);
        restarts = 0;
        setState('ready');
      } catch (err) {
        setState('degraded', { reason: err.message });
      }
    }, delay);
    if (restartTimer.unref) restartTimer.unref();
  }

  const rt = {
    kind: 'nanoclaw',

    async start() {
      if (state === 'ready') return;
      stopping = false;
      setState('starting');
      try {
        await ensureHostReady();
        await boot();
        setState('ready');
      } catch (err) {
        await teardown();
        const unavailable = err instanceof RuntimeUnavailable ? err : new RuntimeUnavailable(err.message, 'see logs/runtime.log in the data folder');
        setState('unavailable', { reason: unavailable.reason, hint: unavailable.hint });
        throw unavailable;
      }
    },

    async stop() {
      if (state === 'stopped') return;
      stopping = true;
      clearTimeout(restartTimer);
      for (const run of runs.values()) if (!isTerminal(run.status)) finishRun(run.id, 'interrupted', 'runtime stopped');
      await teardown();
      setState('stopped');
    },

    async getStatus() { return status(); },
    getCapabilities() { return { ...CAPABILITIES }; },

    async createSession({ name, persona }) {
      requireReady();
      const id = ID_RE.test(String(name || '')) ? String(name) : `s-${crypto.createHash('sha1').update(String(name || 'session')).digest('hex').slice(0, 12)}`;
      if (persona) writePersona(persona);
      if (!sessions.has(id)) sessions.set(id, { id, name: String(name || id), createdAt: now(), runtimeRef: { thread: id, persona: persona ? true : false } });
      return { ...sessions.get(id) };
    },

    async listSessions() { return [...sessions.values()].map((s) => ({ ...s })); },

    async sendMessage({ sessionId, runId, text }) {
      requireReady();
      if (!sessions.has(sessionId)) throw new Error(`unknown session ${sessionId}`);
      if (runs.has(runId)) return snapshot(runs.get(runId));
      return startRun({ runId, sessionId, kind: 'chat', text });
    },

    async runAgent({ runId, instruction, sessionName }) {
      requireReady();
      if (runs.has(runId)) return snapshot(runs.get(runId));
      const session = await rt.createSession({ name: sessionName || `agent-${runId}` });
      return startRun({ runId, sessionId: session.id, kind: 'agent', text: instruction });
    },

    async getRun(id) {
      const run = runs.get(id);
      if (!run) throw new Error(`unknown run ${id}`);
      return snapshot(run);
    },

    async cancelRun(id) {
      // The host has no cancel; the agent finishes on its own. FREN stops listening.
      finishRun(id, 'cancelled');
    },

    async createSchedule(input) {
      requireReady();
      if (input.cron) parseCron(input.cron);
      else if (!Number.isFinite(input.at)) throw new Error('a schedule needs a cron or a moment');
      return schedules.create(input);
    },
    async updateSchedule(id, patch) { requireReady(); if (patch.cron) parseCron(patch.cron); return schedules.update(id, patch); },
    async deleteSchedule(id) { if (state !== 'ready') return; await schedules.remove(id); if (scheduleWatch) scheduleWatch.forget(id); },
    async listSchedules() { return state === 'ready' ? schedules.list() : []; },

    async triggerSchedule(id) {
      requireReady();
      const schedule = await schedules.get(id);
      if (!schedule) throw new Error(`unknown schedule ${id}`);
      const fired = await schedules.trigger(id);
      const run = { id: newId('run'), rowId: fired.rowId, sessionId: null, kind: 'schedule', status: 'queued', startedAt: now(), messages: [], scheduleId: id, automationId: schedule.automationId };
      runs.set(run.id, run);
      watched.set(fired.rowId, run.id);
      bridge.send({ type: 'watch', runId: fired.rowId });
      emit({ type: 'schedule.fired', scheduleId: id, automationId: schedule.automationId, runId: run.id });
      emit({ type: 'run.started', runId: run.id });
      run.status = 'running';
      return snapshot(run);
    },

    async resolvePermission(requestId, decision) {
      const p = pending.get(requestId);
      if (!p) return;
      pending.delete(requestId);
      bridge.send({ type: 'action', questionId: requestId, value: decision === 'approve' ? 'approve' : 'reject', userId: OWNER_HANDLE });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  function requireReady() {
    if (state !== 'ready') throw new Error(`the secure execution environment is ${state}${reason ? `: ${reason}` : ''}`);
  }

  function startRun({ runId, sessionId, kind, text }) {
    const run = { id: runId, sessionId, kind, status: 'queued', startedAt: now(), messages: [] };
    runs.set(runId, run);
    openByThread.set(sessionId, runId);
    const sent = bridge.send({
      type: 'inbound', id: runId, platformId: OWNER_HANDLE, threadId: sessionId, text,
      sender: 'you', senderId: `fren:${OWNER_HANDLE}`, timestamp: new Date(now()).toISOString(),
    });
    if (!sent) {
      runs.delete(runId);
      openByThread.delete(sessionId);
      throw new Error('the runtime host is not connected');
    }
    setImmediate(() => {
      const r = runs.get(runId);
      if (r && r.status === 'queued') { r.status = 'running'; emit({ type: 'run.started', runId }); }
    });
    return snapshot(run);
  }

  async function teardown() {
    clearTimeout(restartTimer);
    if (scheduleWatch) { scheduleWatch.stop(); scheduleWatch = null; }
    if (supervisor) await supervisor.stop();
    if (!skipContainerProbe && tierChosen === 'process') {
      try { await processProbe.stopAll(runtimeDir); } catch (err) { log(`[runtime] agent processes not stopped: ${err.message}`); }
    } else if (!skipContainerProbe && tierChosen === 'container') {
      try { await probe.stopLabeled(`nanoclaw-install=${slug}`); } catch (err) { log(`[runtime] containers not stopped: ${err.message}`); }
    }
    await bridge.close();
    openByThread.clear();
    pending.clear();
    watched.clear();
    earlyTurns.clear();
  }

  return rt;
}

module.exports = { createNanoclawRuntime, CAPABILITIES, installSlug };
