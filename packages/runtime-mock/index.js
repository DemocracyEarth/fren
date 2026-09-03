'use strict';
/**
 * The mock runtime: a FrenRuntime that runs nothing.
 *
 * It exists so the product layer can be built and tested on a machine with
 * no container runtime and no model key, and so the contract tests have a
 * deterministic reference. Every method behaves like a real runtime would
 * from the outside — accepted runs, then events, then terminal states — with
 * canned content and a fake clock for schedules.
 *
 * It is also what `FREN_LLM_PROVIDER=mock` uses, so `npm start` without keys
 * shows the whole loop: chat through the runtime, automations, approvals.
 */
const { RuntimeUnavailable, newId, isTerminal } = require('../runtime');
const { parseCron, nextCron } = require('../shared/cron');

const CAPABILITIES = Object.freeze({
  tokenStreaming: false,
  toolEvents: false,
  turnBoundary: 'exact',
  scheduleTrigger: 'cron',
  maxFiresPerDay: null,
  isolation: 'none',
  files: false,
});

/**
 * @param {object} [opts]
 * @param {number} [opts.replyDelayMs]   how long a "turn" takes
 * @param {(input: {text?: string, instruction?: string, kind: string}) => string} [opts.reply]
 * @param {(text: string) => boolean} [opts.asksWhen]   which inputs raise a permission request
 * @param {() => number} [opts.now]
 * @param {boolean} [opts.unavailable]   start() throws, to test the unavailable path
 * @param {(text: string) => boolean} [opts.failsWhen]   which inputs make the turn fail
 * @param {number} [opts.pauseAfterFailures]   failures in a row before a schedule is given up on
 */
function createMockRuntime(opts = {}) {
  const replyDelayMs = opts.replyDelayMs ?? 5;
  const now = opts.now || Date.now;
  const reply = opts.reply || defaultReply;
  const asksWhen = opts.asksWhen || ((text) => /\[ask\]/i.test(text || ''));
  const failsWhen = opts.failsWhen || ((text) => /\[fail\]/i.test(text || ''));
  const pauseAfterFailures = opts.pauseAfterFailures ?? 3;

  let state = 'stopped';
  let since = 0;
  const sessions = new Map();
  const runs = new Map();
  const schedules = new Map();
  const pendingAsks = new Map(); // requestId -> { runId, resolve }
  const timers = new Map();      // runId -> timeout handle
  const listeners = new Set();

  function emit(event) {
    for (const fn of [...listeners]) {
      try { fn(event); } catch { /* a listener's bug is not the runtime's */ }
    }
  }

  function status() {
    if (state === 'ready') {
      const inFlight = [...runs.values()].filter((r) => !isTerminal(r.status)).length;
      return { state, since, sessions: sessions.size, runs: inFlight };
    }
    return { state };
  }

  function requireReady() {
    if (state !== 'ready') throw new Error(`mock runtime is ${state}`);
  }

  function snapshot(run) {
    return { ...run, messages: run.messages.map((m) => ({ ...m })) };
  }

  function finish(run, statusName, error) {
    if (isTerminal(run.status)) return;
    run.status = statusName;
    run.endedAt = now();
    if (error) run.error = error;
    clearTimeout(timers.get(run.id));
    timers.delete(run.id);
    emit({ type: 'agent.working', runId: run.id, sessionId: run.sessionId || undefined, on: false });
    emit({ type: `run.${statusName}`, runId: run.id, ...(error ? { error } : {}) });
  }

  function deliver(run, text, extra = {}) {
    const message = { seq: run.messages.length + 1, at: now(), text, final: true };
    run.messages.push(message);
    emit({ type: 'agent.message', runId: run.id, ...extra, message: { ...message } });
  }

  /** The "turn": working, maybe a question, a message, done. */
  function begin(run, input, extra = {}) {
    run.status = 'running';
    emit({ type: 'run.started', runId: run.id });
    emit({ type: 'agent.working', runId: run.id, sessionId: run.sessionId || undefined, on: true });
    const text = input.text ?? input.instruction ?? '';
    if (asksWhen(text)) {
      const request = {
        id: newId('perm'), action: 'mock.ask', title: 'The mock runtime wants to act',
        question: `Allow the mock to "${text.replace(/\[ask\]\s*/i, '').slice(0, 80)}"?`,
        options: ['approve', 'deny'], sessionId: run.sessionId || undefined,
      };
      pendingAsks.set(request.id, { runId: run.id, input, extra });
      emit({ type: 'permission.request', request });
      return;
    }
    if (failsWhen(text)) {
      schedule(run, () => finish(run, 'failed', 'the mock was told to fail'));
      return;
    }
    schedule(run, () => {
      deliver(run, reply({ ...input, kind: run.kind }), extra);
      finish(run, 'completed');
    });
  }

  function schedule(run, fn) {
    const handle = setTimeout(() => {
      timers.delete(run.id);
      if (!isTerminal(run.status)) fn();
    }, replyDelayMs);
    if (handle.unref) handle.unref();
    timers.set(run.id, handle);
  }

  function makeRun({ id, sessionId, kind }) {
    const run = { id, sessionId: sessionId || null, kind, status: 'queued', startedAt: now(), messages: [] };
    runs.set(id, run);
    return run;
  }

  const rt = {
    kind: 'mock',

    async start() {
      if (state === 'ready') return;
      if (opts.unavailable) {
        state = 'unavailable';
        emit({ type: 'runtime.status', status: { state, reason: 'mock runtime configured unavailable', hint: 'set unavailable: false' } });
        throw new RuntimeUnavailable('mock runtime configured unavailable', 'set unavailable: false');
      }
      state = 'ready';
      since = now();
      emit({ type: 'runtime.status', status: status() });
    },

    async stop() {
      if (state === 'stopped') return;
      for (const run of runs.values()) {
        if (!isTerminal(run.status)) finish(run, 'interrupted', 'runtime stopped');
      }
      pendingAsks.clear();
      state = 'stopped';
      emit({ type: 'runtime.status', status: status() });
    },

    async getStatus() {
      return status();
    },

    getCapabilities() {
      return { ...CAPABILITIES };
    },

    async createSession({ name, persona }) {
      requireReady();
      const session = { id: newId('ses'), name: String(name || 'session'), createdAt: now(), runtimeRef: { persona: persona || '' } };
      sessions.set(session.id, session);
      return { ...session };
    },

    async listSessions() {
      return [...sessions.values()].map((s) => ({ ...s }));
    },

    async sendMessage({ sessionId, runId, text }) {
      requireReady();
      if (!sessions.has(sessionId)) throw new Error(`unknown session ${sessionId}`);
      if (runs.has(runId)) return snapshot(runs.get(runId)); // a retry, not a second run
      const run = makeRun({ id: runId, sessionId, kind: 'chat' });
      setImmediate(() => begin(run, { text }));
      return snapshot(run);
    },

    async runAgent({ runId, instruction }) {
      requireReady();
      if (runs.has(runId)) return snapshot(runs.get(runId));
      const run = makeRun({ id: runId, sessionId: null, kind: 'agent' });
      setImmediate(() => begin(run, { instruction }));
      return snapshot(run);
    },

    async getRun(id) {
      const run = runs.get(id);
      if (!run) throw new Error(`unknown run ${id}`);
      return snapshot(run);
    },

    async cancelRun(id) {
      const run = runs.get(id);
      if (!run || isTerminal(run.status)) return;
      for (const [reqId, ask] of pendingAsks) if (ask.runId === id) pendingAsks.delete(reqId);
      finish(run, 'cancelled');
    },

    async createSchedule(input) {
      requireReady();
      if (input.cron) parseCron(input.cron); // throws INVALID_CRON
      else if (!Number.isFinite(input.at)) throw new Error('a schedule needs a cron or a moment');
      const id = newId('sch');
      const schedule = {
        ...input, id, enabled: input.enabled !== false, runs: 0, failedRuns: 0,
        nextRunAt: input.cron ? (nextCron(input.cron, now()) ?? undefined) : input.at, runtimeRef: { mock: true },
      };
      schedules.set(id, schedule);
      return { ...schedule };
    },

    async updateSchedule(id, patch) {
      const schedule = schedules.get(id);
      if (!schedule) throw new Error(`unknown schedule ${id}`);
      if (patch.cron !== undefined) {
        parseCron(patch.cron);
        schedule.cron = patch.cron;
        schedule.nextRunAt = nextCron(patch.cron, now()) ?? undefined;
      }
      if (patch.at !== undefined) {
        schedule.at = patch.at;
        schedule.nextRunAt = patch.at;
      }
      for (const key of ['name', 'instruction', 'deliveryName', 'timezone', 'overrideFireLimit']) {
        if (patch[key] !== undefined) schedule[key] = patch[key];
      }
      if (patch.enabled !== undefined) {
        schedule.enabled = !!patch.enabled;
        if (schedule.enabled) {
          delete schedule.pausedByRuntime;
          schedule.streak = 0;
          schedule.nextRunAt = nextCron(schedule.cron, now()) ?? undefined;
        }
      }
      return { ...schedule };
    },

    async deleteSchedule(id) {
      schedules.delete(id);
    },

    async listSchedules() {
      return [...schedules.values()].map((s) => ({ ...s }));
    },

    async triggerSchedule(id) {
      requireReady();
      const schedule = schedules.get(id);
      if (!schedule) throw new Error(`unknown schedule ${id}`);
      return fire(schedule);
    },

    async resolvePermission(requestId, decision) {
      const ask = pendingAsks.get(requestId);
      if (!ask) return; // late or unknown: the run has already moved on
      pendingAsks.delete(requestId);
      const run = runs.get(ask.runId);
      if (!run || isTerminal(run.status)) return;
      const text = ask.input.text ?? ask.input.instruction ?? '';
      if (decision === 'approve') {
        schedule(run, () => {
          deliver(run, `approved: ${reply({ ...ask.input, kind: run.kind })}`, ask.extra);
          finish(run, 'completed');
        });
      } else {
        schedule(run, () => {
          deliver(run, `I did not do "${text.replace(/\[ask\]\s*/i, '')}" — you declined.`, ask.extra);
          finish(run, 'completed');
        });
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Test-only: advance the fake clock and fire due schedules. Returns the
     * runs it started. A real runtime's timer lives inside it; the mock's
     * lives in the test.
     */
    /** Test-only: the runtime gives up on a schedule, as after repeated failures. */
    giveUp(id, detail = 'it kept failing') {
      const schedule = schedules.get(id);
      if (!schedule) throw new Error(`unknown schedule ${id}`);
      giveUp(schedule, detail);
    },

    tick(nowMs = now()) {
      const started = [];
      for (const schedule of schedules.values()) {
        if (!schedule.enabled || !schedule.nextRunAt || schedule.nextRunAt > nowMs) continue;
        started.push(fire(schedule, nowMs));
        if (schedule.cron) schedule.nextRunAt = nextCron(schedule.cron, nowMs) ?? undefined;
        else { schedule.nextRunAt = undefined; schedule.enabled = false; } // a moment comes once
      }
      return started;
    },
  };

  function fire(schedule, at = now()) {
    const run = makeRun({ id: newId('run'), sessionId: null, kind: 'schedule' });
    schedule.runs += 1;
    schedule.lastRunAt = at;
    emit({ type: 'schedule.fired', scheduleId: schedule.id, automationId: schedule.automationId, runId: run.id });
    const extra = { automationId: schedule.automationId };
    const unsubscribe = rt.subscribe((e) => {
      if (e.runId !== run.id || !/^run\.(completed|failed|cancelled|interrupted)$/.test(e.type)) return;
      unsubscribe();
      const ok = e.type === 'run.completed';
      if (ok) schedule.streak = 0;
      else { schedule.failedRuns += 1; schedule.streak = (schedule.streak || 0) + 1; }
      emit({
        type: ok ? 'schedule.completed' : 'schedule.failed',
        scheduleId: schedule.id, automationId: schedule.automationId, runId: run.id,
        ...(ok ? {} : { detail: e.error || e.type }),
      });
      // Like the real thing: enough failures in a row and the runtime gives up.
      if (!ok && schedule.enabled && schedule.streak >= pauseAfterFailures) giveUp(schedule, `it failed ${schedule.streak} times in a row`);
    });
    setImmediate(() => begin(run, { instruction: schedule.instruction, name: schedule.name }, extra));
    return snapshot(run);
  }

  function giveUp(schedule, detail) {
    schedule.enabled = false;
    schedule.pausedByRuntime = detail;
    schedule.nextRunAt = undefined;
    emit({ type: 'schedule.paused', scheduleId: schedule.id, automationId: schedule.automationId, detail });
  }

  return rt;
}

function defaultReply({ text, instruction, name, kind }) {
  if (kind === 'schedule') return `(mock) ${name || 'automation'} ran: ${instruction || ''}`.trim();
  if (kind === 'agent') return `(mock) done: ${instruction || ''}`.trim();
  return `(mock) you said: ${text || ''}`.trim();
}

module.exports = { createMockRuntime, CAPABILITIES };
