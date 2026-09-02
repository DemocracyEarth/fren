'use strict';
/**
 * Automations: things fren does at a time, or when asked, without being
 * asked again.
 *
 * The Automation is FREN's product model (docs/runtime-architecture.md §8):
 * a name, a trigger, a body, the permissions granted at creation, and a run
 * history with output that stays on this machine. The runtime owns the timer
 * for `agent` bodies with a schedule; this service compiles the automation
 * into a runtime schedule, keeps the two in step, and turns what the runtime
 * reports into FREN's own records and events.
 *
 * Only `agent` bodies are created through this service today. `question`
 * bodies (today's routines) and `script` bodies (today's host scripts) keep
 * their existing code paths until phase 5 folds them in.
 */
const { newId, isTerminal } = require('../runtime');
const { parseCron, nextCron, firesPerDay, describeCron } = require('../shared/cron');
const { isScope } = require('../permissions');
const { httpError } = require('./runs');
const intelligence = require('../intelligence');

const MAX_FIRES_PER_DAY = 24;
const BODIES = ['agent', 'question', 'script'];
const TRIGGERS = ['schedule', 'manual', 'event'];

/**
 * The prompt a runtime agent gets for an automation. The delivery contract
 * exists because a scheduled run has no conversation attached: whatever the
 * agent does not send, nobody sees.
 */
function compileInstruction({ name, instruction, deliveryName }) {
  return [
    `You are running FREN's automation "${name}" on behalf of its owner.`,
    '',
    'Instruction:',
    instruction,
    '',
    'Delivery contract: your final text is not shown to anyone. When you have a result, send it with',
    `send_message to the destination named "${deliveryName}". Send exactly one message unless the`,
    'instruction asks for more. Keep it under 250 words. If you could not do the task, send one',
    'sentence saying what stopped you.',
  ].join('\n');
}

function localTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function createAutomationService({ store, events, getRuntime, runs, complete = null, now = Date.now, log = () => {} }) {
  const timezone = localTimezone();

  function runtime() {
    return getRuntime();
  }

  function runtimeReady() {
    const rt = runtime();
    return !!rt && rt.kind && ready;
  }
  let ready = false;

  // ---------------------------------------------------------- validation
  function validate(input, { partial = false } = {}) {
    const out = {};
    if (!partial || input.name !== undefined) {
      const name = String(input.name || '').trim().slice(0, 80);
      if (!name) throw httpError(400, 'an automation needs a name');
      out.name = name;
    }
    if (!partial || input.trigger !== undefined) {
      const t = input.trigger || {};
      if (!TRIGGERS.includes(t.type)) throw httpError(400, `trigger must be one of ${TRIGGERS.join(', ')}`);
      if (t.type === 'schedule') {
        try { parseCron(t.cron); } catch (err) { throw httpError(400, err.message); }
        const caps = runtime() ? runtime().getCapabilities() : null;
        const limit = Math.min(caps && caps.maxFiresPerDay ? caps.maxFiresPerDay : MAX_FIRES_PER_DAY, MAX_FIRES_PER_DAY);
        if (firesPerDay(t.cron) > limit && !input.overrideFireLimit) {
          throw httpError(400, `that would run ${firesPerDay(t.cron)} times a day; the limit is ${limit}`);
        }
        out.trigger = { type: 'schedule', cron: parseCron(t.cron).expr, timezone: t.timezone || timezone };
      } else if (t.type === 'event') {
        if (!t.event || typeof t.event !== 'string') throw httpError(400, 'an event trigger needs an event name');
        out.trigger = { type: 'event', event: t.event.slice(0, 80), filter: t.filter && typeof t.filter === 'object' ? t.filter : undefined };
      } else {
        out.trigger = { type: 'manual' };
      }
    }
    if (!partial || input.body !== undefined) {
      const b = input.body || {};
      if (!BODIES.includes(b.kind)) throw httpError(400, `body must be one of ${BODIES.join(', ')}`);
      if (b.kind !== 'agent') throw httpError(400, `${b.kind} automations are managed elsewhere for now`);
      const instruction = String(b.instruction || '').trim().slice(0, 4000);
      if (!instruction) throw httpError(400, 'an agent automation needs an instruction');
      out.body = { kind: 'agent', instruction };
    }
    if (!partial || input.permissions !== undefined) {
      const list = Array.isArray(input.permissions) ? input.permissions : [];
      const bad = list.filter((p) => !isScope(p));
      if (bad.length) throw httpError(400, `unknown permission: ${bad.join(', ')}`);
      out.permissions = [...new Set(list)];
    }
    if (input.enabled !== undefined) out.enabled = !!input.enabled;
    return out;
  }

  function nextRunFor(a) {
    if (!a.enabled || a.trigger.type !== 'schedule') return null;
    return nextCron(a.trigger.cron, now());
  }

  function present(a) {
    if (!a) return null;
    return {
      ...a,
      describe: a.trigger.type === 'schedule' ? describeCron(a.trigger.cron) : a.trigger.type,
      nextRunAt: nextRunFor(a) ?? null,
      runs: store.listAutomationRuns(a.id, 8),
      runtimeState: a.runtimeRef && runtime() && a.runtimeRef.kind === runtime().kind ? 'scheduled' : (a.body.kind === 'agent' && a.trigger.type === 'schedule' ? 'waiting' : 'local'),
    };
  }

  // ------------------------------------------------ runtime schedule sync
  function scheduleInputFor(a) {
    return {
      automationId: a.id, name: a.name, cron: a.trigger.cron, timezone: a.trigger.timezone || timezone,
      instruction: compileInstruction({ name: a.name, instruction: a.body.instruction, deliveryName: `automation-${a.id}` }),
      deliveryName: `automation-${a.id}`, enabled: a.enabled,
    };
  }

  /** Make the runtime agree with this automation. Never throws; logs. */
  async function sync(a, { known, intent } = {}) {
    const rt = runtime();
    if (!rt || !ready || a.body.kind !== 'agent' || a.trigger.type !== 'schedule') return a;
    try {
      const ref = a.runtimeRef && a.runtimeRef.kind === rt.kind ? a.runtimeRef : null;
      const list = known || (await rt.listSchedules());
      const existing = ref && list.find((s) => s.id === ref.id);
      if (existing) {
        if (a.enabled && !existing.enabled && existing.pausedByRuntime && intent !== 'user') {
          // The runtime gave up on it while nobody was looking. Its verdict
          // stands; resuming a failing automation quietly is not a fix.
          return applyRuntimePause(a, existing.pausedByRuntime);
        }
        const drift = existing.cron !== a.trigger.cron || existing.enabled !== a.enabled ||
          existing.name !== a.name || existing.instruction !== scheduleInputFor(a).instruction;
        if (drift) await rt.updateSchedule(ref.id, scheduleInputFor(a));
        return a;
      }
      const created = await rt.createSchedule(scheduleInputFor(a));
      store.updateAutomation(a.id, { runtimeRef: { kind: rt.kind, id: created.id } });
      return store.getAutomation(a.id);
    } catch (err) {
      log(`[automations] could not sync "${a.name}" with the runtime: ${err.message}`);
      return a;
    }
  }

  /** The runtime stopped a schedule on its own: the automation goes off, with the reason. */
  function applyRuntimePause(a, detail) {
    store.updateAutomation(a.id, { enabled: false, pausedByRuntime: detail, nextRunAt: null, updatedAt: now() });
    events.emit('automation.paused', { automationId: a.id, name: a.name, detail });
    return store.getAutomation(a.id);
  }

  async function unsync(a) {
    const rt = runtime();
    if (!rt || !a.runtimeRef || a.runtimeRef.kind !== rt.kind) return;
    try { await rt.deleteSchedule(a.runtimeRef.id); } catch (err) { log(`[automations] could not remove "${a.name}" from the runtime: ${err.message}`); }
  }

  /** The runtime just became ready: every automation gets a schedule again. */
  async function reconcile() {
    const rt = runtime();
    if (!rt) return;
    ready = true;
    let known = [];
    try { known = await rt.listSchedules(); } catch (err) { log(`[automations] listSchedules: ${err.message}`); return; }
    const mine = store.listAutomations();
    for (const a of mine) await sync(a, { known });
    const ids = new Set(mine.map((a) => a.id));
    for (const s of known) {
      if (s.automationId && !ids.has(s.automationId)) {
        events.emit('schedule.orphan', { scheduleId: s.id, automationId: s.automationId, name: s.name });
      }
    }
  }

  function runtimeGone() {
    ready = false;
  }

  // ------------------------------------------------------------- the API
  function list() {
    return store.listAutomations().map(present);
  }

  function get(id) {
    const a = store.getAutomation(id);
    if (!a) throw httpError(404, 'no such automation');
    return present(a);
  }

  async function create(input) {
    const clean = validate(input);
    const id = newId('atm');
    const at = now();
    const a = {
      id, name: clean.name, trigger: clean.trigger, body: clean.body, permissions: clean.permissions,
      enabled: clean.enabled !== false, createdAt: at, updatedAt: at,
      source: ['user', 'suggestion', 'agent'].includes(input.source) ? input.source : 'user',
    };
    store.insertAutomation({ ...a, nextRunAt: nextRunFor(a) });
    const synced = await sync(store.getAutomation(id));
    events.emit('automation.created', { automationId: id, name: a.name, describe: describeCron(a.trigger.cron || '') });
    return present(synced);
  }

  async function update(id, patch) {
    const before = store.getAutomation(id);
    if (!before) throw httpError(404, 'no such automation');
    if (patch.expectedRevision !== undefined && Number(patch.expectedRevision) !== before.revision) {
      throw httpError(409, 'the automation changed since you loaded it');
    }
    const clean = validate({ ...patch, overrideFireLimit: patch.overrideFireLimit }, { partial: true });
    const merged = { ...before, ...clean };
    store.updateAutomation(id, {
      ...clean, updatedAt: now(), nextRunAt: nextRunFor(merged), bumpRevision: true,
      ...(clean.enabled === true ? { pausedByRuntime: null } : {}),
    });
    const synced = await sync(store.getAutomation(id), { intent: 'user' });
    events.emit('automation.updated', { automationId: id, name: synced.name, enabled: synced.enabled });
    return present(synced);
  }

  async function remove(id) {
    const a = store.getAutomation(id);
    if (!a) return { deleted: false };
    await unsync(a);
    store.deleteAutomation(id);
    events.emit('automation.deleted', { automationId: id, name: a.name });
    return { deleted: true };
  }

  /** Run it now, whatever its schedule says. */
  async function runNow(id) {
    const a = store.getAutomation(id);
    if (!a) throw httpError(404, 'no such automation');
    const rt = runtime();
    if (!rt || !ready) throw httpError(503, 'the secure execution environment is not available');
    let run;
    if (a.runtimeRef && a.runtimeRef.kind === rt.kind) {
      try {
        run = await rt.triggerSchedule(a.runtimeRef.id);
      } catch (err) {
        throw httpError(503, `could not start it: ${err.message}`);
      }
      runs.adopt({ runId: run.id, kind: 'schedule', automationId: a.id });
    } else {
      run = await runs.startAgent({
        instruction: compileInstruction({ name: a.name, instruction: a.body.instruction, deliveryName: `automation-${a.id}` }),
        automationId: a.id,
      });
    }
    const automationRun = recordStart(a, run.id, 'manual');
    return { run: runs.get(run.id), automationRun };
  }

  function recordStart(a, runId, trigger) {
    const existing = store.getAutomationRunByRunId(runId);
    if (existing) {
      // The runtime may report the fire before the manual path gets here; a
      // person pressing the button is still the reason it ran.
      if (trigger === 'manual' && existing.trigger !== 'manual') {
        store.updateAutomationRun(existing.id, { trigger: 'manual' });
        return store.getAutomationRun(existing.id);
      }
      return existing;
    }
    const id = newId('ar');
    store.insertAutomationRun({ id, automationId: a.id, trigger, startedAt: now(), runId });
    store.updateAutomation(a.id, { nextRunAt: nextRunFor(a) });
    events.emit('automation.triggered', { automationId: a.id, name: a.name, runId, trigger });
    return store.getAutomationRun(id);
  }

  /**
   * The runtime fired a schedule by itself and delivered a result without a
   * run FREN opened. Make the run now, from the message, and close it: a fire
   * with a result is a completed run.
   */
  function deliveredWithoutRun(a, message) {
    const runId = newId('run');
    runs.adopt({ runId, kind: 'schedule', automationId: a.id });
    recordStart(a, runId, 'schedule');
    runs.onRuntimeEvent({ type: 'agent.message', runId, automationId: a.id, automationName: a.name, message });
    runs.onRuntimeEvent({ type: 'run.completed', runId });
    finishRun(runId, true);
  }

  /** Close the record for a run, once, from whichever signal arrives first. */
  function finishRun(runId, ok, detail) {
    const ar = store.getAutomationRunByRunId(runId);
    if (!ar || ar.status !== 'started') return;
    const a = store.getAutomation(ar.automationId);
    const run = store.getRun(runId);
    const texts = run ? run.messages.map((m) => m.text).filter(Boolean) : [];
    const output = texts.join('\n\n') || detail || '';
    store.updateAutomationRun(ar.id, { status: ok ? 'ok' : 'failed', endedAt: now(), output, delivered: texts.length > 0 });
    if (a) store.updateAutomation(a.id, { nextRunAt: nextRunFor(a) });
    events.emit(ok ? 'automation.run.completed' : 'automation.run.failed', {
      automationId: ar.automationId, name: a ? a.name : null, runId, status: ok ? 'ok' : 'failed',
      output: output.slice(0, 2000), delivered: texts.length > 0, ...(detail ? { detail } : {}),
    });
  }

  /**
   * What the runtime reports about schedules and their runs. Returns true when
   * the event was entirely about schedules; run events are enriched and left
   * for the run service.
   */
  function onRuntimeEvent(event) {
    switch (event.type) {
      case 'schedule.fired': {
        const a = store.getAutomation(event.automationId);
        if (!a) return true;
        if (event.runId) {
          runs.adopt({ runId: event.runId, kind: 'schedule', automationId: a.id });
          recordStart(a, event.runId, 'schedule');
        }
        return true;
      }
      case 'schedule.completed':
        if (event.runId) finishRun(event.runId, true, event.detail);
        return true;
      case 'schedule.failed':
        if (event.runId) finishRun(event.runId, false, event.detail);
        return true;
      case 'schedule.paused': {
        const a = store.getAutomation(event.automationId);
        if (a && a.enabled) applyRuntimePause(a, event.detail || 'it kept failing');
        return true;
      }
      case 'agent.message': {
        const run = event.runId ? store.getRun(event.runId) : null;
        const automationId = (run && run.automationId) || event.automationId;
        if (automationId) {
          const a = store.getAutomation(automationId);
          if (a) event.automationName = a.name;
          // A scheduled fire the runtime started on its own: no run of ours is
          // open, but the result is real. Record it and let the person see it.
          if (a && !run && event.message && (event.message.text || event.message.files)) {
            deliveredWithoutRun(a, event.message);
            return true;
          }
        }
        return false;
      }
      case 'run.completed':
      case 'run.failed':
      case 'run.cancelled':
      case 'run.interrupted': {
        // Let the run service record the end first, then close ours.
        const runId = event.runId;
        setImmediate(() => {
          const run = runId ? store.getRun(runId) : null;
          if (run && run.automationId && isTerminal(run.status)) finishRun(runId, event.type === 'run.completed', event.error);
        });
        return false;
      }
      default:
        return false;
    }
  }

  /** Is this text asking for an automation, and if so which? */
  async function intent(text) {
    const clean = String(text || '').trim().slice(0, 2000);
    if (!clean) throw httpError(400, 'text is required');
    const heuristic = intelligence.heuristicIntent(clean);
    let parsed = null;
    if (complete) {
      try {
        const raw = await complete(intelligence.buildAutomationIntentRequest({ text: clean, now: now() }));
        const obj = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
        if (typeof obj.isAutomation === 'boolean') parsed = obj;
      } catch (err) {
        log(`[automations] intent model unreadable: ${err.message}`);
      }
    }
    let result;
    if (parsed && parsed.isAutomation) {
      let cron = String(parsed.cron || '').trim();
      try { cron = parseCron(cron).expr; } catch { cron = heuristic.confident ? heuristic.cron : ''; }
      const instruction = String(parsed.instruction || '').trim().slice(0, 4000) || heuristic.instruction;
      result = cron && instruction
        ? { isAutomation: true, name: String(parsed.name || heuristic.name || 'automation').slice(0, 60), cron, instruction, reason: '', source: 'model' }
        : { isAutomation: false, name: '', cron: '', instruction: '', reason: 'could not read a time from that', source: 'model' };
    } else if (parsed) {
      result = { isAutomation: false, name: '', cron: '', instruction: '', reason: String(parsed.reason || '').slice(0, 200), source: 'model' };
    } else {
      result = { ...heuristic, source: 'heuristic' };
      delete result.confident;
    }
    if (result.isAutomation) result.describe = describeCron(result.cron);
    return result;
  }

  return { list, get, create, update, remove, runNow, intent, reconcile, runtimeGone, onRuntimeEvent, compileInstruction };
}

module.exports = { createAutomationService, compileInstruction, MAX_FIRES_PER_DAY };
