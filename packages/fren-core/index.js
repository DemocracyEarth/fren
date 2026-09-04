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
const { createPermissionBroker } = require('./permission-broker');
const { createObservationBus } = require('../observer');

const REPROBE_MS = 30_000;
/** Handlers return their JSON payload; this key carries a non-200 status alongside it. */
const HTTP_STATUS = Symbol('httpStatus');
const accepted = (payload) => ({ ...payload, [HTTP_STATUS]: 202 });
const PRUNE_AFTER_MS = 30 * 24 * 3600 * 1000;

function createCore({ runTimeoutMs, scheduleTimeoutMs, store, runtime, complete = null, now = Date.now, log = console.log, reprobeMs = REPROBE_MS, egress = {} }) {
  if (runtime) assertRuntime(runtime);
  const events = createEventLog({ store, now, log });
  const observations = createObservationBus();
  let runtimeStatus = runtime ? { state: 'stopped' } : { state: 'unavailable', reason: 'no runtime configured' };
  let unsubscribeRuntime = null;
  let reprobeTimer = null;
  let starting = null;

  // The environment's egress reach, set on the sandbox proxy: the union of the
  // domains enabled automations declare, plus the domains a person has trusted
  // "always" through an ask-card. `grantHost` records an "allow once" answer.
  const setEgressDefault = egress.setDefault || (() => {});
  const grantEgressHost = egress.grantSessionHost || (() => {});
  let trustedDomains = [];
  try { trustedDomains = JSON.parse(store.getSetting('egress.trusted') || '[]'); } catch { trustedDomains = []; }
  function pushEgress(autoPolicy) {
    if (autoPolicy && autoPolicy.mode === 'open') return setEgressDefault({ mode: 'open', hosts: [] });
    const hosts = new Set(trustedDomains);
    if (autoPolicy && autoPolicy.mode === 'list') autoPolicy.hosts.forEach((h) => hosts.add(h));
    setEgressDefault(hosts.size ? { mode: 'list', hosts: [...hosts] } : { mode: 'off', hosts: [] });
  }
  function trustDomain(host) {
    const h = String(host || '').toLowerCase();
    if (!h || trustedDomains.includes(h)) return;
    trustedDomains.push(h);
    store.setSetting('egress.trusted', JSON.stringify(trustedDomains));
    pushEgress(automations.egressPolicy());
  }

  const runs = createRunService({ store, events, getRuntime: () => runtime, now, log, runTimeoutMs, scheduleTimeoutMs });
  const automations = createAutomationService({ store, events, getRuntime: () => runtime, runs, complete, now, log, setEgress: pushEgress });
  const permissions = createPermissionBroker({ store, events, getRuntime: () => runtime, now, log });
  const services = { runs, automations, permissions };

  // Hosts the agent reaches that are noise, not the task — refuse them silently
  // rather than ask about them. Telemetry and infra the environment should not
  // reach anyway; asking would be a card storm.
  const EGRESS_NOISE = [/(^|\.)anthropic\.com$/, /(^|\.)statsig\.(com|anthropic\.com)$/, /(^|\.)sentry\.io$/, /(^|\.)segment\.(io|com)$/, /(^|\.)datadoghq\.com$/, /(^|\.)amplitude\.com$/, /(^|\.)google-analytics\.com$/, /(^|\.)doubleclick\.net$/];
  const askedHosts = new Map(); // sessionId -> Set<host>, so one host is asked once a session
  /** Is a person present and waiting — an interactive chat run underway? */
  function interactivePresent() {
    try { return store.listRuns({ status: 'running' }).some((r) => r.kind === 'chat'); } catch { return false; }
  }
  /**
   * The proxy refused a host. Decide whether to ask, and answer whether it may
   * proceed: never for noise, never twice for the same host in a session, never
   * when no one is present to answer. Otherwise raise a card and wait; on yes,
   * record the grant ("once" for the session, "always" persisted) and allow.
   */
  async function askEgress(sessionId, host) {
    const h = String(host || '').toLowerCase();
    if (!h || EGRESS_NOISE.some((re) => re.test(h))) return false;
    const asked = askedHosts.get(sessionId) || new Set();
    if (asked.has(h)) return false;
    if (!interactivePresent()) return false;
    asked.add(h);
    askedHosts.set(sessionId, asked);
    let answer;
    try { answer = await permissions.askEgress({ sessionId, host: h }); } catch { return false; }
    if (!answer || answer.decision !== 'approve') return false;
    if (answer.remember === 'always') trustDomain(h);
    else grantEgressHost(sessionId, h);
    return true;
  }

  // ---- FREN tools: what an agent can ask fren to do for it, each gated -------
  // The manifest the tool server (the proxy's /mcp lane) hands the agent.
  const TOOL_MANIFEST = [
    {
      name: 'notify',
      description:
        'Show the person a desktop notification: a short title and an optional line of body. Use it to reach ' +
        'them about something worth their attention — a result they asked to be alerted about, a heads-up while ' +
        'they are away. It is not for conversation; ordinary replies still go through send_message.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A few words: the headline of the notification.' },
          body: { type: 'string', description: 'One or two sentences of detail. Optional.' },
        },
        required: ['title'],
      },
    },
  ];
  function toolManifest() {
    return TOOL_MANIFEST;
  }

  // Whether the person has let fren show them notifications. Asked once (like an
  // OS notification prompt) and remembered, so an automation can alert them
  // later even while they are away.
  let notifyAllowed = store.getSetting('tools.notify') === 'allowed';
  async function askNotify({ title, body }) {
    if (!notifyAllowed) {
      let answer;
      try {
        answer = await permissions.ask({
          kind: 'notify', scope: 'notification.send', subject: {},
          title: 'send you a notification',
          question: `fren wants to send you a notification: "${title}". Allow it?`,
          options: ['once', 'always', 'deny'],
        });
      } catch {
        return false;
      }
      if (!answer || answer.decision !== 'approve') return false;
      if (answer.remember === 'always') { notifyAllowed = true; store.setSetting('tools.notify', 'allowed'); }
    }
    events.emit('notify', { title: String(title).slice(0, 120), body: String(body || '').slice(0, 400), at: now() });
    return true;
  }

  /** Run a tool the agent called, gating each through the broker before it acts. */
  async function handleToolCall(name, args) {
    const a = args && typeof args === 'object' ? args : {};
    if (name === 'notify') {
      const title = String(a.title || '').trim().slice(0, 120);
      if (!title) return { isError: true, text: 'a notification needs a title' };
      const ok = await askNotify({ title, body: a.body });
      return ok ? { text: 'Shown.' } : { isError: true, text: 'The person did not allow that notification.' };
    }
    return { isError: true, text: `unknown tool: ${name}` };
  }
  // What the desktop notices reaches the automations that wait for it.
  observations.subscribe(null, (obs) => { automations.onObservation(obs).catch((err) => log(`[automations] observation: ${err.message}`)); });

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
    permissions.runtimeGone();
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
    permissions.expireStale();
    permissions.start();
    startRuntime(); // in the background; the desktop is never blocked on it
  }

  async function stop() {
    permissions.stop();
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

  route('GET', '/v1/permissions/requests', (_p, _b, query) => ({ requests: permissions.list({ status: query.status || undefined }) }));
  route('GET', '/v1/permissions/requests/:id', (p) => ({ request: permissions.get(p.id) }));
  route('POST', '/v1/permissions/requests/:id/decision', async (p, body) => ({ request: await permissions.decide(p.id, body || {}) }));

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
    events, observations, runs, automations, permissions, services, askEgress, handleToolCall, toolManifest,
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
