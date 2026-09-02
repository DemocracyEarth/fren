'use strict';
// FREN Core over HTTP: the gateway process with the mock runtime behind it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createServer } = require('../server');
const { createMockProvider } = require('../providers/mock');
const { createCore } = require('../../../packages/fren-core');
const { openCoreStore } = require('../../../packages/fren-core/store');
const { createMockRuntime } = require('../../../packages/runtime-mock');
const { config } = require('../../../packages/shared');

const AUTH = { authorization: `Bearer ${config.GATEWAY_TOKEN}` };
const JSON_HEADERS = { 'content-type': 'application/json', ...AUTH };

let server;
let base;
let core;

const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
const get = (p) => fetch(`${base}${p}`, { headers: AUTH });

async function until(fn, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Read SSE frames from a fetch body until one satisfies `pred`. */
async function readEvents(res, pred, timeoutMs = 3000) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const seen = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        seen.push(event);
        if (pred(event)) return seen;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`no matching event; saw ${seen.map((e) => e.type).join(', ')}`);
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-core-http-'));
  const store = openCoreStore(path.join(dir, 'core.db'));
  core = createCore({ store, runtime: createMockRuntime({ replyDelayMs: 5 }), log: () => {}, reprobeMs: 0 });
  server = createServer(createMockProvider(), null, null, { core });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  await core.start();
  await core.startRuntime();
});

test.after(async () => {
  await core.stop();
  await new Promise((resolve) => server.close(resolve));
});

test('core routes need the bearer token', async () => {
  const res = await fetch(`${base}/v1/runtime/status`);
  assert.equal(res.status, 401);
});

test('/health reports the runtime without naming a product', async () => {
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(body.runtime.state, 'ready');
  assert.equal(body.runtimeKind, 'mock');
});

test('GET /v1/runtime/status has state, kind and capabilities', async () => {
  const body = await (await get('/v1/runtime/status')).json();
  assert.equal(body.status.state, 'ready');
  assert.equal(body.kind, 'mock');
  assert.equal(body.capabilities.tokenStreaming, false);
});

test('POST /v1/runs is accepted, then completes with a message; retries are idempotent', async () => {
  const res = await post('/v1/runs', { text: 'hello core' });
  assert.equal(res.status, 202);
  const { run } = await res.json();
  assert.match(run.id, /^run_/);
  assert.ok(['queued', 'running'].includes(run.status));
  const again = await (await post('/v1/runs', { id: run.id, text: 'hello core' })).json();
  assert.equal(again.run.id, run.id);

  const done = await until(async () => {
    const { run: r } = await (await get(`/v1/runs/${run.id}`)).json();
    return r.status === 'completed' ? r : null;
  });
  assert.equal(done.messages.length, 1);
  assert.equal(done.messages[0].text, '(mock) you said: hello core');
  assert.equal(done.messages[0].final, true);
  assert.equal(done.kind, 'chat');
  assert.ok(done.sessionId);

  const { runs } = await (await get('/v1/runs?limit=5')).json();
  assert.ok(runs.some((r) => r.id === run.id));
  const { sessions } = await (await get('/v1/sessions')).json();
  assert.ok(sessions.some((s) => s.name === 'main'));
});

test('an empty message is a 400, an unknown run a 404, a wrong method a 405', async () => {
  assert.equal((await post('/v1/runs', { text: '   ' })).status, 400);
  assert.equal((await get('/v1/runs/run_0000000000000000')).status, 404);
  assert.equal((await fetch(`${base}/v1/runs`, { method: 'DELETE', headers: AUTH })).status, 405);
  assert.equal((await get('/v1/nothing')).status, 404);
});

test('GET /v1/events streams the run as it happens, and replays from an id', async () => {
  const stream = await get('/v1/events');
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const { run } = await (await post('/v1/runs', { text: 'stream me' })).json();
  const seen = await readEvents(stream, (e) => e.type === 'run.completed' && e.runId === run.id);
  const types = seen.filter((e) => e.runId === run.id).map((e) => e.type);
  assert.ok(types.indexOf('run.started') < types.indexOf('agent.message'));
  assert.ok(types.indexOf('agent.message') < types.indexOf('run.completed'));
  const msg = seen.find((e) => e.type === 'agent.message' && e.runId === run.id);
  assert.equal(msg.message.text, '(mock) you said: stream me');
  assert.equal(typeof msg.id, 'number');

  // Resume: everything after the first event of this run is replayed.
  const first = seen.find((e) => e.runId === run.id);
  const replay = await fetch(`${base}/v1/events`, { headers: { ...AUTH, 'last-event-id': String(first.id) } });
  const replayed = await readEvents(replay, (e) => e.type === 'run.completed' && e.runId === run.id);
  assert.ok(!replayed.some((e) => e.id === first.id), 'the event already seen is not repeated');
});

test('cancelling a run ends it', async () => {
  const { run } = await (await post('/v1/runs', { text: 'slow one' })).json();
  const res = await post(`/v1/runs/${run.id}/cancel`, {});
  assert.equal(res.status, 200);
  const { run: after } = await res.json();
  assert.ok(['cancelled', 'completed'].includes(after.status));
});

test('POST /v1/observations accepts well-formed observations and drops the rest', async () => {
  const res = await post('/v1/observations', {
    observations: [
      { timestamp: Date.now(), source: 'os', type: 'app.active', payload: { app: 'Code' } },
      { timestamp: 'bad', source: 'os', type: 'app.active' },
    ],
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: 1 });
  assert.equal(core.observations.recent().length, 1);
});

test('runs left open when Core restarts are marked interrupted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-core-restart-'));
  const file = path.join(dir, 'core.db');
  let store = openCoreStore(file);
  store.insertRun({ id: 'run_0123456789abcdef', kind: 'chat', status: 'running', startedAt: Date.now() });
  store.close();
  store = openCoreStore(file);
  const c = createCore({ store, runtime: createMockRuntime(), log: () => {}, reprobeMs: 0 });
  await c.start();
  assert.equal(store.getRun('run_0123456789abcdef').status, 'interrupted');
  await c.stop();
  store.close();
});

test('an unavailable runtime is reported with its hint and does not block Core', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-core-unavail-'));
  const store = openCoreStore(path.join(dir, 'core.db'));
  const c = createCore({ store, runtime: createMockRuntime({ unavailable: true }), log: () => {}, reprobeMs: 0 });
  await c.start();
  await until(() => c.runtimeStatus().state === 'unavailable');
  assert.equal(c.runtimeStatus().hint, 'set unavailable: false');
  await assert.rejects(() => c.runs.start({ text: 'hi' }), /not available/);
  await c.stop();
  store.close();
});
