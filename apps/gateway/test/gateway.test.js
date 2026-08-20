const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('../server');
const { createMockProvider } = require('../providers/mock');
const { config } = require('../../../packages/shared');

const AUTH = { authorization: `Bearer ${config.GATEWAY_TOKEN}` };
const JSON_HEADERS = { 'content-type': 'application/json', ...AUTH };

let server;
let base;

test.before(async () => {
  server = createServer(createMockProvider());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('GET /health is unauthenticated and reports provider + model', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'mock');
  assert.equal(body.model, config.MODEL || 'mock');
});

test('POST /v1/summarize returns a parsed summary', async () => {
  const observations = [
    { ts: 1000, activeApp: 'Code', windowTitle: 'server.js — fren' },
    { ts: 2000, activeApp: 'Chrome', windowTitle: 'node http docs' },
    { ts: 3000, activeApp: 'Code', windowTitle: 'server.js — fren' },
    { ts: 4000, activeApp: 'Terminal', windowTitle: 'node --test' },
  ];
  const res = await fetch(`${base}/v1/summarize`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ observations }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.activity, 'string');
  assert.ok(body.activity.length > 0);
  assert.ok(Array.isArray(body.applications));
  assert.equal(typeof body.confidence, 'number');
});

test('POST /v1/chat returns { reply: string }', async () => {
  const res = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ question: 'What was I doing today?', memories: [], observations: [] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.reply, 'string');
  assert.ok(body.reply.length > 0);
});

test('missing bearer token -> 401', async () => {
  const res = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'hello' }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
});

test('bad JSON -> 400', async () => {
  const res = await fetch(`${base}/v1/summarize`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
});

test('missing fields -> 400', async () => {
  const res = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('unknown route -> 404', async () => {
  const res = await fetch(`${base}/v1/nope`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
});
