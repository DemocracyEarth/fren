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
const { parseCron, nextCron, firesPerDay, describeTrigger } = require('../shared/cron');
const { isScope } = require('../permissions');
const { httpError } = require('./runs');
const intelligence = require('../intelligence');

const MAX_FIRES_PER_DAY = 24;
const BODIES = ['agent', 'question', 'script'];
const TRIGGERS = ['schedule', 'at', 'manual', 'event'];
/** Triggers the runtime keeps a clock for. */
const TIMED = new Set(['schedule', 'at']);
/** A window that stays in front is one sighting, not one every tick. */
const EVENT_COOLDOWN_MS = 30 * 60 * 1000;

/** A host as a bare allowlist domain: no scheme, no www, no path, lower-case. */
function normalizeDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '').replace(/:\d+$/, '').slice(0, 120);
}

/** The trigger an intent reading names, ready for the model. */
function triggerFromIntent(r) {
  if (r.when === 'once') return { type: 'at', at: r.at };
  if (r.when === 'event') return { type: 'event', filter: r.app ? { app: r.app } : { site: r.site } };
  return { type: 'schedule', cron: r.cron };
}

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

function createAutomationService({ store, events, getRuntime, runs, complete = null, now = Date.now, log = () => {}, setEgress = () => {} }) {
  const timezone = localTimezone();

  /**
   * The environment's egress allowlist: the union of the domains every enabled
   * agent automation declares. Deny by default — an automation that declares
   * none contributes nothing, and an install with no declared domain reaches
   * nothing but the model. Pushed to the sandbox proxy after any change.
   */
  function egressPolicy() {
    const domains = new Set();
    for (const a of store.listAutomations()) {
      if (!a.enabled || !a.body || a.body.kind !== 'agent') continue;
      if (a.network && Array.isArray(a.network.domains)) a.network.domains.forEach((d) => domains.add(d));
    }
    return domains.size ? { mode: 'list', hosts: [...domains] } : { mode: 'off', hosts: [] };
  }
  function pushEgress() {
    try { setEgress(egressPolicy()); } catch (err) { log(`[automations] egress push: ${err.message}`); }
  }

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
      } else if (t.type === 'at') {
        const at = Number(t.at);
        if (!Number.isFinite(at)) throw httpError(400, 'a one-off needs a moment');
        if (at < now() - 60_000) throw httpError(400, 'that moment has already passed');
        out.trigger = { type: 'at', at: Math.round(at), timezone: t.timezone || timezone };
      } else if (t.type === 'event') {
        const f = t.filter && typeof t.filter === 'object' ? t.filter : {};
        const app = String(f.app || '').trim().slice(0, 80);
        const site = normalizeDomain(f.site);
        if (!app && !site) throw httpError(400, 'a "whenever" needs an app or a site to watch for');
        out.trigger = { type: 'event', event: 'observation', filter: app ? { app } : { site } };
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
    if (!partial || input.network !== undefined) {
      // The domains an agent automation may reach. null (or absent) means no
      // allowlist was declared — the environment keeps its current reach; a
      // list confines it to hosts under those domains and nothing else.
      const raw = input.network && typeof input.network === 'object' && !Array.isArray(input.network) ? input.network.domains : input.network;
      const domains = [...new Set((Array.isArray(raw) ? raw : []).map(normalizeDomain).filter(Boolean))].slice(0, 30);
      out.network = domains.length ? { domains } : null;
    }
    if (input.enabled !== undefined) out.enabled = !!input.enabled;
    return out;
  }

  function nextRunFor(a) {
    if (!a.enabled) return null;
    if (a.trigger.type === 'at') return a.trigger.at > now() ? a.trigger.at : null;
    if (a.trigger.type !== 'schedule') return null;
    return nextCron(a.trigger.cron, now());
  }

  function present(a) {
    if (!a) return null;
    return {
      ...a,
      describe: describeTrigger(a.trigger, now()),
      nextRunAt: nextRunFor(a) ?? null,
      runs: store.listAutomationRuns(a.id, 8),
      runtimeState: a.runtimeRef && runtime() && a.runtimeRef.kind === runtime().kind ? 'scheduled' : (a.body.kind === 'agent' && TIMED.has(a.trigger.type) && a.enabled ? 'waiting' : 'local'),
    };
  }

  // ------------------------------------------------ runtime schedule sync
  function scheduleInputFor(a) {
    return {
      automationId: a.id, name: a.name, cron: a.trigger.cron, at: a.trigger.at, timezone: a.trigger.timezone || timezone,
      instruction: compileInstruction({ name: a.name, instruction: a.body.instruction, deliveryName: `automation-${a.id}` }),
      deliveryName: `automation-${a.id}`, enabled: a.enabled,
      domains: a.network && Array.isArray(a.network.domains) ? a.network.domains : null,
    };
  }

  /** Make the runtime agree with this automation. Never throws; logs. */
  async function sync(a, { known, intent } = {}) {
    const rt = runtime();
    if (!rt || !ready || a.body.kind !== 'agent' || !TIMED.has(a.trigger.type)) return a;
    if (a.trigger.type === 'at' && a.trigger.at <= now()) {
      // The moment passed while nobody was looking: nothing left to schedule.
      if (a.enabled) finishOneOff(a, 'the moment passed while fren was away');
      return store.getAutomation(a.id);
    }
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
        const drift = existing.cron !== a.trigger.cron || (existing.at || null) !== (a.trigger.at || null) || existing.enabled !== a.enabled ||
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
    pushEgress();
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
      network: clean.network || null,
      enabled: clean.enabled !== false, createdAt: at, updatedAt: at,
      source: ['user', 'suggestion', 'agent'].includes(input.source) ? input.source : 'user',
    };
    store.insertAutomation({ ...a, nextRunAt: nextRunFor(a) });
    const synced = await sync(store.getAutomation(id));
    events.emit('automation.created', { automationId: id, name: a.name, describe: describeTrigger(a.trigger, now()) });
    pushEgress();
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
    pushEgress();
    return present(synced);
  }

  async function remove(id) {
    const a = store.getAutomation(id);
    if (!a) return { deleted: false };
    await unsync(a);
    store.deleteAutomation(id);
    events.emit('automation.deleted', { automationId: id, name: a.name });
    pushEgress();
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

  /** A moment comes once: after it, the automation is done and off. */
  function finishOneOff(a, why) {
    store.updateAutomation(a.id, { enabled: false, nextRunAt: null, runtimeRef: null, updatedAt: now() });
    events.emit('automation.updated', { automationId: a.id, name: a.name, enabled: false, done: true, ...(why ? { detail: why } : {}) });
    pushEgress();
  }

  /**
   * Something was noticed on the desktop. An automation that runs "whenever
   * I open X" runs once per sighting, with a cooldown so a window that stays
   * in front is one sighting and not one every tick.
   */
  async function onObservation(obs) {
    const payload = obs && obs.payload && typeof obs.payload === 'object' ? obs.payload : {};
    const app = String(payload.app || '').toLowerCase();
    const where = String(payload.domain || payload.url || '').toLowerCase();
    if (!app && !where) return;
    const rt = runtime();
    for (const a of store.listAutomations()) {
      if (!a.enabled || a.trigger.type !== 'event' || a.body.kind !== 'agent') continue;
      const f = a.trigger.filter || {};
      const hit = (f.app && app.includes(String(f.app).toLowerCase())) || (f.site && where.includes(String(f.site).toLowerCase()));
      if (!hit) continue;
      if (a.lastRunAt && now() - a.lastRunAt < EVENT_COOLDOWN_MS) continue;
      if (!rt || !ready) { log(`[automations] "${a.name}" was triggered, but the secure execution environment is not ready`); continue; }
      const seen = f.app ? `${payload.app}${payload.title ? ` (${String(payload.title).slice(0, 80)})` : ''}` : String(payload.url || payload.domain).slice(0, 200);
      store.updateAutomation(a.id, { lastRunAt: now() });
      try {
        const run = await runs.startAgent({
          instruction: compileInstruction({ name: a.name, instruction: a.body.instruction, deliveryName: `automation-${a.id}` }) +
            `\n\nWhy now: the owner has just ${f.app ? 'opened' : 'gone to'} ${seen}.`,
          automationId: a.id,
        });
        recordStart(a, run.id, 'event');
      } catch (err) {
        log(`[automations] "${a.name}" could not start: ${err.message}`);
      }
    }
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
    if (a && a.trigger.type === 'at' && a.enabled) finishOneOff(a);
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
      const when = ['repeat', 'once', 'event'].includes(parsed.when) ? parsed.when : (parsed.cron ? 'repeat' : heuristic.when);
      const instruction = String(parsed.instruction || '').trim().slice(0, 4000) || heuristic.instruction;
      const name = String(parsed.name || heuristic.name || 'automation').slice(0, 60);
      let cron = '';
      let at = null;
      let app = '';
      let site = '';
      if (when === 'repeat') {
        cron = String(parsed.cron || '').trim();
        try { cron = parseCron(cron).expr; } catch { cron = heuristic.when === 'repeat' ? heuristic.cron : ''; }
      } else if (when === 'once') {
        at = intelligence.fromIsoLocal(parsed.at);
        if (!Number.isFinite(at) && heuristic.when === 'once') at = heuristic.at;
      } else if (when === 'event') {
        app = String(parsed.app || '').trim().slice(0, 80);
        site = String(parsed.site || '').trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '').slice(0, 120);
        if (!app && !site && heuristic.when === 'event') { app = heuristic.app; site = heuristic.site; }
      }
      const modelDomains = Array.isArray(parsed.domains) ? parsed.domains : [];
      const domains = [...new Set(modelDomains.concat(intelligence.guessDomains(instruction)).map(normalizeDomain).filter(Boolean))].slice(0, 30);
      const readable = !!instruction && (
        (when === 'repeat' && !!cron) || (when === 'once' && Number.isFinite(at) && at > now()) || (when === 'event' && !!(app || site)));
      result = readable
        ? { isAutomation: true, when, name, cron, at, app, site, instruction, domains, reason: '', source: 'model' }
        : { isAutomation: false, when: 'none', name: '', cron: '', at: null, app: '', site: '', instruction: '', domains: [], reason: 'could not read a time from that', source: 'model' };
    } else if (parsed) {
      result = { isAutomation: false, when: 'none', name: '', cron: '', at: null, app: '', site: '', instruction: '', reason: String(parsed.reason || '').slice(0, 200), source: 'model' };
    } else {
      result = { ...heuristic, source: 'heuristic' };
      delete result.confident;
    }
    if (result.isAutomation) {
      result.trigger = triggerFromIntent(result);
      result.describe = describeTrigger(result.trigger, now());
    }
    return result;
  }

  pushEgress();
  return { list, get, create, update, remove, runNow, intent, reconcile, runtimeGone, onRuntimeEvent, onObservation, compileInstruction, egressPolicy };
}

module.exports = { createAutomationService, compileInstruction, MAX_FIRES_PER_DAY };
