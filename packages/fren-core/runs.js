'use strict';
/**
 * Runs: one request to an agent, from accepted to finished.
 *
 * A run is FREN's record. The runtime executes it and reports back as
 * events; this service persists what came back, keeps the status honest, and
 * republishes each step on the Core event log so the desktop can draw it.
 *
 * Sessions are resolved lazily. FREN's session ("main") is durable in
 * core.db; the runtime's session behind it may or may not survive a runtime
 * restart, so the mapping is re-established on demand and remembered as an
 * opaque runtimeRef.
 */
const { newId, isTerminal } = require('../runtime');

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** A scheduled run answers to the runtime's own clock and may work a long while in silence. */
const SCHEDULE_TIMEOUT_MS = 60 * 60 * 1000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function createRunService({ store, events, getRuntime, now = Date.now, log = () => {}, runTimeoutMs = RUN_TIMEOUT_MS, scheduleTimeoutMs = SCHEDULE_TIMEOUT_MS }) {
  const runtimeSessions = new Map(); // fren session id -> runtime session id (this runtime life)
  const timeouts = new Map();

  function runtime() {
    const rt = getRuntime();
    if (!rt) throw httpError(503, 'no runtime is configured');
    return rt;
  }

  /** FREN session by name, created on first use. */
  function ensureSession(name = 'main') {
    let session = store.getSessionByName(name);
    if (!session) {
      session = { id: newId('ses'), name, createdAt: now(), runtimeRef: null };
      store.upsertSession(session);
    }
    return session;
  }

  async function resolveRuntimeSession(session, persona) {
    const cached = runtimeSessions.get(session.id);
    if (cached) return cached;
    const rt = runtime();
    const ref = session.runtimeRef;
    if (ref && ref.kind === rt.kind && ref.id) {
      const existing = (await rt.listSessions()).find((s) => s.id === ref.id);
      if (existing) {
        runtimeSessions.set(session.id, existing.id);
        return existing.id;
      }
    }
    const created = await rt.createSession({ name: session.name, persona });
    store.upsertSession({ ...session, runtimeRef: { kind: rt.kind, id: created.id } });
    runtimeSessions.set(session.id, created.id);
    return created.id;
  }

  function armTimeout(runId) {
    clearTimeout(timeouts.get(runId));
    const armed = store.getRun(runId);
    const budget = armed && armed.kind === 'schedule' ? scheduleTimeoutMs : runTimeoutMs;
    const handle = setTimeout(() => {
      timeouts.delete(runId);
      const run = store.getRun(runId);
      if (!run || isTerminal(run.status)) return;
      finish(runId, 'failed', 'the agent stopped responding');
      runtime().cancelRun(runId).catch(() => {});
    }, budget);
    if (handle.unref) handle.unref();
    timeouts.set(runId, handle);
  }

  function finish(runId, status, error) {
    const run = store.getRun(runId);
    if (!run || isTerminal(run.status)) return;
    clearTimeout(timeouts.get(runId));
    timeouts.delete(runId);
    store.updateRun(runId, { status, endedAt: now(), ...(error ? { error } : {}) });
    events.emit(`run.${status}`, { runId, sessionId: run.sessionId, kind: run.kind, automationId: run.automationId, ...(error ? { error } : {}) });
  }

  /**
   * Accept a chat message. Resolves as soon as the runtime accepted the run;
   * everything after that is events.
   */
  async function start({ id, sessionName = 'main', text, persona }) {
    const clean = String(text || '').trim().slice(0, 4000);
    if (!clean) throw httpError(400, 'text is required');
    const runId = id && /^run_[0-9a-f]{16}$/.test(id) ? id : newId('run');
    const existing = store.getRun(runId);
    if (existing) return existing; // a retry, not a second run
    const session = ensureSession(sessionName);
    const rt = runtime();
    let runtimeSessionId;
    try {
      runtimeSessionId = await resolveRuntimeSession(session, persona);
    } catch (err) {
      throw httpError(503, `the secure execution environment is not available: ${err.message}`);
    }
    store.insertRun({ id: runId, sessionId: session.id, kind: 'chat', input: { text: clean }, startedAt: now() });
    try {
      await rt.sendMessage({ sessionId: runtimeSessionId, runId, text: clean });
    } catch (err) {
      finish(runId, 'failed', err.message);
      throw httpError(503, `the secure execution environment is not available: ${err.message}`);
    }
    armTimeout(runId);
    return store.getRun(runId);
  }

  /** A one-off agent run with an instruction, no conversation. */
  async function startAgent({ id, instruction, automationId = null, sessionName }) {
    const clean = String(instruction || '').trim().slice(0, 8000);
    if (!clean) throw httpError(400, 'instruction is required');
    const runId = id && /^run_[0-9a-f]{16}$/.test(id) ? id : newId('run');
    if (store.getRun(runId)) return store.getRun(runId);
    const rt = runtime();
    store.insertRun({ id: runId, sessionId: null, kind: 'agent', automationId, input: { instruction: clean }, startedAt: now() });
    try {
      await rt.runAgent({ runId, instruction: clean, sessionName });
    } catch (err) {
      finish(runId, 'failed', err.message);
      throw httpError(503, `the secure execution environment is not available: ${err.message}`);
    }
    armTimeout(runId);
    return store.getRun(runId);
  }

  /** A run the runtime started itself (a schedule firing). */
  function adopt({ runId, kind = 'schedule', automationId = null }) {
    if (store.getRun(runId)) return store.getRun(runId);
    store.insertRun({ id: runId, sessionId: null, kind, automationId, status: 'running', startedAt: now() });
    armTimeout(runId);
    return store.getRun(runId);
  }

  function get(id) {
    const run = store.getRun(id);
    if (!run) throw httpError(404, 'no such run');
    return run;
  }

  async function cancel(id) {
    const run = get(id);
    if (isTerminal(run.status)) return run;
    try { await runtime().cancelRun(id); } catch (err) { log(`[core] cancel ${id}: ${err.message}`); }
    finish(id, 'cancelled');
    return store.getRun(id);
  }

  /** Feed a runtime event through. Returns true when it was about a run we know. */
  function onRuntimeEvent(event) {
    const runId = event.runId;
    switch (event.type) {
      case 'run.started': {
        if (!runId) return false;
        const run = store.getRun(runId);
        if (!run) return false;
        if (run.status === 'queued') store.updateRun(runId, { status: 'running' });
        events.emit('run.started', { runId, sessionId: run.sessionId, kind: run.kind, automationId: run.automationId });
        return true;
      }
      case 'agent.working': {
        events.emit('agent.working', { runId: runId || null, sessionId: event.sessionId || null, on: !!event.on });
        return true;
      }
      case 'agent.message': {
        if (!runId || !store.getRun(runId)) {
          // Something the agent volunteered, or a run this Core life does not
          // know. Not a run of ours, but not nothing either.
          if (!runId && event.message && (event.message.text || event.message.files)) {
            events.emit('agent.message', { runId: null, sessionId: event.sessionId || null, kind: 'chat', automationId: event.automationId || null, automationName: event.automationName || null, message: { ...event.message } });
            return true;
          }
          return false;
        }
        const m = event.message || {};
        const run = store.getRun(runId);
        const seq = typeof m.seq === 'number' ? m.seq : run.messages.length + 1;
        store.addRunMessage(runId, { seq, at: m.at || now(), text: m.text ?? null, files: m.files ?? null, card: m.card ?? null, final: !!m.final });
        armTimeout(runId);
        events.emit('agent.message', {
          runId, sessionId: run.sessionId, kind: run.kind, automationId: run.automationId || event.automationId || null,
          automationName: event.automationName || null,
          message: { seq, at: m.at || now(), text: m.text ?? null, files: m.files ?? null, card: m.card ?? null, final: !!m.final },
        });
        return true;
      }
      case 'agent.question': {
        if (!runId) return false;
        events.emit('agent.question', { runId, questionId: event.questionId, title: event.title, question: event.question, options: event.options || [] });
        return true;
      }
      case 'run.completed': finish(runId, 'completed'); return true;
      case 'run.failed': finish(runId, 'failed', event.error || 'the run failed'); return true;
      case 'run.cancelled': finish(runId, 'cancelled'); return true;
      case 'run.interrupted': finish(runId, 'interrupted', event.error || 'interrupted'); return true;
      default:
        return false;
    }
  }

  /** On boot: nothing that was running before this process can still be. */
  function recover() {
    let n = 0;
    for (const run of store.openRuns()) {
      store.updateRun(run.id, { status: 'interrupted', endedAt: now(), error: 'Core restarted' });
      n += 1;
    }
    return n;
  }

  /** The runtime went away: everything in flight is over. */
  function interruptAll(reason) {
    for (const run of store.openRuns()) finish(run.id, 'interrupted', reason);
    runtimeSessions.clear();
  }

  return {
    start, startAgent, adopt, get, cancel, onRuntimeEvent, recover, interruptAll, ensureSession,
    list: (opts) => store.listRuns(opts),
    sessions: () => store.listSessions(),
    createSession: (name) => ensureSession(String(name || '').trim().slice(0, 80) || 'main'),
  };
}

module.exports = { createRunService, httpError, RUN_TIMEOUT_MS };
