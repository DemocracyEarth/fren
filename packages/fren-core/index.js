'use strict';
/**
 * FREN Core: the control plane between the desktop and whatever runs agents.
 *
 * It lives in the gateway process (the one that already holds credentials
 * and a loopback HTTP server) and owns: the runtime's lifetime, runs,
 * sessions, automations, permission requests, the event log, and the
 * observation bus. The desktop talks to it over the same HTTP + bearer token
 * it already uses, plus one server-sent-events stream for push.
 *
 * The runtime behind it is anything that keeps the FrenRuntime contract.
 * Core never asks which one; it reads `kind` for an About box and
 * `getCapabilities()` to decide what the interface may promise.
 */
const { assertRuntime, RuntimeUnavailable } = require('../runtime');
const { createEventLog } = require('./events');
const { createRunService, httpError } = require('./runs');
const { createAutomationService } = require('./automations');
const { createObservationBus } = require('../observer');

const REPROBE_MS = 30_000;
/** Handlers return their JSON payload; this key carries a non-200 status alongside it. */
const HTTP_STATUS = Symbol('httpStatus');
const accepted = (payload) => ({ ...payload, [HTTP_STATUS]: 202 });
const PRUNE_AFTER_MS = 30 * 24 * 3600 * 1000;

function createCore({ store, runtime, complete = null, now = Date.now, log = console.log, reprobeMs = REPROBE_MS }) {
  if (runtime) assertRuntime(runtime);
  const events = createEventLog({ store, now, log });
  const observations = createObservationBus();
  let runtimeStatus = runtime ? { state: 'stopped' } : { state: 'unavailable', reason: 'no runtime configured' };
  let unsubscribeRuntime = null;
  let reprobeTimer = null;
  let starting = null;

  const runs = createRunService({ store, events, getRuntime: () => runtime, now, log });
  const automations = createAutomationService({ store, events, getRuntime: () => runtime, runs, complete, now, log });
  // The permission broker arrives in the next step; the slot keeps the bridge's shape.
  const services = { runs, automations, permissions: null };

  function setStatus(status) {
    runtimeStatus = status;
    events.emit('runtime.status', { status });
  }

  function onRuntimeEvent(event) {
    if (event.type === 'runtime.status') {
      runtimeStatus = event.status;
      events.emit('runtime.status', { status: event.status });
      return;
    }
    if (services.automations && services.automations.onRuntimeEvent(event)) return;
    if (services.permissions && services.permissions.onRuntimeEvent(event)) return;
    runs.onRuntimeEvent(event);
  }

  async function startRuntime() {
    if (!runtime) return runtimeStatus;
    if (starting) return starting;
    starting = (async () => {
      if (!unsubscribeRuntime) unsubscribeRuntime = runtime.subscribe(onRuntimeEvent);
      setStatus({ state: 'starting', step: 'starting the secure execution environment' });
      try {
        await runtime.start();
        runtimeStatus = await runtime.getStatus();
        events.emit('runtime.status', { status: runtimeStatus });
        clearInterval(reprobeTimer);
        reprobeTimer = null;
        if (services.automations) await services.automations.reconcile();
      } catch (err) {
        const reason = err instanceof RuntimeUnavailable ? err.reason : err.message;
        const hint = err instanceof RuntimeUnavailable ? err.hint : '';
        setStatus({ state: 'unavailable', reason, hint });
        log(`[core] runtime unavailable: ${reason}${hint ? ` (${hint})` : ''}`);
        if (!reprobeTimer && reprobeMs > 0) {
          reprobeTimer = setInterval(() => { starting = null; startRuntime(); }, reprobeMs);
          if (reprobeTimer.unref) reprobeTimer.unref();
        }
      } finally {
        starting = null;
      }
      return runtimeStatus;
    })();
    return starting;
  }

  async function stopRuntime(reason = 'stopped') {
    clearInterval(reprobeTimer);
    reprobeTimer = null;
    runs.interruptAll(reason);
    automations.runtimeGone();
    if (runtime) {
      try { await runtime.stop(); } catch (err) { log(`[core] runtime stop: ${err.message}`); }
      runtimeStatus = await runtime.getStatus().catch(() => ({ state: 'stopped' }));
    } else {
      runtimeStatus = { state: 'stopped' };
    }
    events.emit('runtime.status', { status: runtimeStatus });
  }

  async function start() {
    const interrupted = runs.recover();
    if (interrupted) log(`[core] ${interrupted} run(s) from a previous life marked interrupted`);
    const pruned = store.prune({ beforeMs: now() - PRUNE_AFTER_MS });
    if (pruned.runs || pruned.events) log(`[core] pruned ${pruned.runs} runs, ${pruned.events} events`);
    if (services.permissions) services.permissions.expireStale();
    startRuntime(); // in the background; the desktop is never blocked on it
  }

  async function stop() {
    await stopRuntime('Core stopped');
    if (unsubscribeRuntime) { unsubscribeRuntime(); unsubscribeRuntime = null; }
  }

  // ------------------------------------------------------------ HTTP routes
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/v1/runtime/status', () => ({
    status: runtimeStatus, kind: runtime ? runtime.kind : null, capabilities: runtime ? runtime.getCapabilities() : null,
  }));
  route('POST', '/v1/runtime/start', async () => ({ status: await startRuntime() }));
  route('POST', '/v1/runtime/stop', async () => { await stopRuntime('stopped by request'); return { status: runtimeStatus }; });

  route('GET', '/v1/sessions', () => ({ sessions: runs.sessions() }));
  route('POST', '/v1/sessions', (_p, body) => ({ session: runs.createSession(body && body.name) }));

  route('POST', '/v1/runs', async (_p, body) => {
    const run = await runs.start({ id: body && body.id, sessionName: body && body.sessionName, text: body && body.text, persona: body && body.persona });
    return accepted({ run });
  });
  route('GET', '/v1/runs', (_p, _b, query) => ({
    runs: runs.list({ limit: Math.min(Number(query.limit) || 50, 200), sessionId: query.sessionId, automationId: query.automationId }),
  }));
  route('GET', '/v1/runs/:id', (p) => ({ run: runs.get(p.id) }));
  route('POST', '/v1/runs/:id/cancel', async (p) => ({ run: await runs.cancel(p.id) }));

  route('GET', '/v1/automations', () => ({ automations: automations.list() }));
  route('POST', '/v1/automations', async (_p, body) => ({ ...({ automation: await automations.create(body || {}) }), [HTTP_STATUS]: 201 }));
  route('POST', '/v1/automations/intent', async (_p, body) => automations.intent(body && body.text));
  route('GET', '/v1/automations/:id', (p) => ({ automation: automations.get(p.id) }));
  route('PATCH', '/v1/automations/:id', async (p, body) => ({ automation: await automations.update(p.id, body || {}) }));
  route('DELETE', '/v1/automations/:id', async (p) => automations.remove(p.id));
  route('POST', '/v1/automations/:id/run', async (p) => accepted(await automations.runNow(p.id)));

  route('POST', '/v1/observations', (_p, body) => {
    const list = Array.isArray(body && body.observations) ? body.observations : body ? [body] : [];
    let count = 0;
    for (const obs of list.slice(0, 100)) if (observations.publish(obs)) count += 1;
    return accepted({ accepted: count });
  });

  route('GET', '/v1/events', (_p, _b, query, req, res) => {
    let since = req.headers['last-event-id'] || query.since || 0;
    if (since === 'latest') since = events.lastId(); // no history, only what happens next
    events.attach(res, { since });
    return null; // the response stays open
  });

  function owns(pathname) {
    return /^\/v1\/(runtime|sessions|runs|automations|permissions|observations|events)(\/|$)/.test(pathname);
  }

  /**
   * Serve one request. The gateway has already checked the bearer token and
   * parsed the JSON body (null for GET). Returns after writing the response,
   * except for the event stream, which stays open.
   */
  async function handle(req, res, pathname, body, query = {}) {
    const found = routes.find((r) => r.method === req.method && r.re.test(pathname));
    if (!found) {
      const known = routes.some((r) => r.re.test(pathname));
      return send(res, known ? 405 : 404, { error: known ? 'method not allowed' : 'not found' });
    }
    const params = {};
    const m = pathname.match(found.re);
    found.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try {
      const result = await found.handler(params, body, query, req, res);
      if (result === null) return;
      send(res, (result && result[HTTP_STATUS]) || 200, result || {});
    } catch (err) {
      send(res, err.status || 500, { error: err.message || 'internal error' });
    }
  }

  return {
    events, observations, runs, automations, services,
    handle, owns, start, stop, startRuntime, stopRuntime,
    runtimeStatus: () => runtimeStatus,
    runtimeKind: () => (runtime ? runtime.kind : null),
    capabilities: () => (runtime ? runtime.getCapabilities() : null),
  };
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

module.exports = { createCore, httpError };
