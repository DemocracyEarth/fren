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

// --- curiosity ---------------------------------------------------------------
// Both of these routes must fail toward doing nothing. Silence and forgetting
// are recoverable; a dull interruption and a wrong "fact" in a file the user
// reads are not.

test('POST /v1/curious requires the token', async () => {
  const res = await fetch(`${base}/v1/curious`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memories: [] }),
  });
  assert.equal(res.status, 401);
});

test('POST /v1/curious answers "no" when the model says nothing usable', async () => {
  // The mock returns a summary shape, which is not a curiosity answer. An
  // unreadable answer must mean silence, never a half-parsed question.
  const res = await fetch(`${base}/v1/curious`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ memories: [{ activity: 'in Figma', apps: ['Figma'] }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ask, false);
  assert.equal(body.question, '');
});

test('POST /v1/curious will not report ask:true with no question to ask', async () => {
  const server2 = createServer({
    name: 'stub',
    model: 'stub',
    async complete() { return JSON.stringify({ ask: true, question: '   ', about: 'x', why: 'y' }); },
  });
  server2.listen(0, '127.0.0.1');
  await once(server2, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server2.address().port}/v1/curious`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ memories: [] }),
    });
    const body = await res.json();
    assert.equal(body.ask, false, 'an empty question is not a question');
  } finally {
    await new Promise((r) => server2.close(r));
  }
});

test('POST /v1/learn keeps nothing it cannot read', async () => {
  const res = await fetch(`${base}/v1/learn`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ question: 'What is that?', answer: 'A landing page for fren.' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.worthKeeping, false, 'an unparseable verdict means remember nothing');
});

test('POST /v1/learn refuses an empty answer rather than inventing a fact', async () => {
  const res = await fetch(`${base}/v1/learn`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ question: 'q', answer: '  ' }),
  });
  assert.equal(res.status, 400);
});

test('POST /v1/learn passes a real verdict through', async () => {
  const server2 = createServer({
    name: 'stub',
    model: 'stub',
    async complete() {
      return '```json\n{"worthKeeping":true,"fact":"Ships the billing rewrite with Ana."}\n```';
    },
  });
  server2.listen(0, '127.0.0.1');
  await once(server2, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server2.address().port}/v1/learn`, {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ question: 'Who is on billing with you?', answer: 'Ana, mostly.' }),
    });
    const body = await res.json();
    assert.equal(body.worthKeeping, true);
    assert.match(body.fact, /Ana/);
  } finally {
    await new Promise((r) => server2.close(r));
  }
});

// --- choosing a model ---------------------------------------------------------
// The point of the settings pane is that a choice actually reaches the provider
// call. These assert that end, and that a bad choice cannot.

test('a chosen model reaches the provider for that request only', async () => {
  const seen = [];
  const server2 = createServer({
    name: 'stub',
    model: 'default-model',
    async complete(req) { seen.push(req.model); return 'ok'; },
  });
  server2.listen(0, '127.0.0.1');
  await once(server2, 'listening');
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  try {
    await fetch(`${base2}/v1/chat`, {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ question: 'hi', model: 'deepseek-reasoner' }),
    });
    assert.equal(seen[0], 'deepseek-reasoner');

    // The next request without one falls straight back to the default: the
    // override is per-call, so nothing is left stuck for the next caller.
    await fetch(`${base2}/v1/chat`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ question: 'hi' }),
    });
    assert.equal(seen[1], undefined, 'no override means the provider uses its own default');
  } finally {
    await new Promise((r) => server2.close(r));
  }
});

test('a model id that is not an id is ignored, not passed on', async () => {
  const seen = [];
  const server2 = createServer({
    name: 'stub', model: 'default-model',
    async complete(req) { seen.push(req.model); return 'ok'; },
  });
  server2.listen(0, '127.0.0.1');
  await once(server2, 'listening');
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  try {
    for (const bad of ['../../etc/passwd', 'https://evil.example.com', 'a b c', 'x'.repeat(100)]) {
      await fetch(`${base2}/v1/chat`, {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ question: 'hi', model: bad }),
      });
    }
    assert.deepEqual(seen, [undefined, undefined, undefined, undefined],
      'every malformed id falls through to the configured default');
  } finally {
    await new Promise((r) => server2.close(r));
  }
});

test('a chosen voice reaches the speech call', async () => {
  const calls = [];
  const server2 = createServer(createMockProvider(), {
    name: 'stub-voice', voice: 'default-voice', model: 'default-voice-model',
    async speak(text, opts) {
      calls.push(opts);
      return { audio: Buffer.from('x'), contentType: 'audio/mpeg' };
    },
  });
  server2.listen(0, '127.0.0.1');
  await once(server2, 'listening');
  try {
    await fetch(`http://127.0.0.1:${server2.address().port}/v1/speak`, {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ text: 'hello', voice: 'abc123', voiceModel: 'eleven_turbo_v2_5' }),
    });
    assert.equal(calls[0].voice, 'abc123');
    assert.equal(calls[0].model, 'eleven_turbo_v2_5');
  } finally {
    await new Promise((r) => server2.close(r));
  }
});

test('/health reports the voice defaults so the settings pane can show them', async () => {
  const server2 = createServer(createMockProvider(), {
    name: 'stub-voice', voice: 'the-default-voice', model: 'the-default-voice-model',
    async speak() { return { audio: Buffer.alloc(0), contentType: 'audio/mpeg' }; },
  });
  server2.listen(0, '127.0.0.1');
  await once(server2, 'listening');
  try {
    const body = await (await fetch(`http://127.0.0.1:${server2.address().port}/health`)).json();
    assert.equal(body.voiceId, 'the-default-voice');
    assert.equal(body.voiceModel, 'the-default-voice-model');
    // Whatever else /health grows, it must never grow a credential.
    const flat = JSON.stringify(body);
    assert.ok(!/key|token|secret|authorization/i.test(flat), `/health leaked something: ${flat}`);
  } finally {
    await new Promise((r) => server2.close(r));
  }
});
