'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { config } = require('../../../packages/shared');
const { createDeepSeekProvider, DEFAULT_MODEL } = require('../providers/deepseek');

/** A stand-in DeepSeek endpoint that records what it was sent. */
function fakeDeepSeek(reply) {
  const seen = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.path = req.url;
      seen.auth = req.headers.authorization;
      seen.body = JSON.parse(body);
      res.writeHead(reply.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.address().port}`;
      resolve({ seen, close: () => server.close() });
    });
  });
}

const SCHEMA = { type: 'object', required: ['activity'], properties: { activity: { type: 'string' } } };
const OK = { body: { choices: [{ message: { content: '{"activity":"editing observer.js"}' } }] } };

test('sends an OpenAI-shaped request with bearer auth and the configured model', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const fake = await fakeDeepSeek(OK);
  try {
    const provider = createDeepSeekProvider();
    const out = await provider.complete({
      system: 'You summarize.',
      messages: [{ role: 'user', content: 'Timeline: VS Code' }],
      schema: SCHEMA,
      maxTokens: 256,
    });

    assert.equal(provider.name, 'deepseek');
    assert.equal(provider.model, config.MODEL || DEFAULT_MODEL);
    assert.equal(fake.seen.path, '/chat/completions');
    assert.equal(fake.seen.auth, 'Bearer test-key');
    assert.equal(fake.seen.body.model, config.MODEL || DEFAULT_MODEL);
    assert.equal(fake.seen.body.max_tokens, 256);
    // System prompt first, then the caller's messages.
    assert.equal(fake.seen.body.messages[0].role, 'system');
    assert.equal(fake.seen.body.messages[1].content, 'Timeline: VS Code');
    assert.equal(out, '{"activity":"editing observer.js"}');
  } finally {
    fake.close();
  }
});

test('schema requests use JSON mode and carry the schema in the prompt', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const fake = await fakeDeepSeek(OK);
  try {
    await createDeepSeekProvider().complete({
      system: 'You summarize.',
      messages: [{ role: 'user', content: 'x' }],
      schema: SCHEMA,
    });
    assert.deepStrictEqual(fake.seen.body.response_format, { type: 'json_object' });
    const sys = fake.seen.body.messages[0].content;
    // DeepSeek rejects json_object unless "json" appears in the prompt.
    assert.match(sys, /json/i);
    assert.match(sys, /"activity"/);
  } finally {
    fake.close();
  }
});

test('plain chat requests omit response_format', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const fake = await fakeDeepSeek({ body: { choices: [{ message: { content: 'hello' } }] } });
  try {
    const out = await createDeepSeekProvider().complete({
      system: 'You are fren.',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(fake.seen.body.response_format, undefined);
    assert.equal(out, 'hello');
  } finally {
    fake.close();
  }
});

test('an API error surfaces status without leaking the request', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const fake = await fakeDeepSeek({ status: 401, body: { error: { message: 'bad key' } } });
  try {
    await assert.rejects(
      () => createDeepSeekProvider().complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }),
      /deepseek 401/
    );
  } finally {
    fake.close();
  }
});

test('an empty completion is an error, not an empty summary', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const fake = await fakeDeepSeek({ body: { choices: [] } });
  try {
    await assert.rejects(
      () => createDeepSeekProvider().complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }),
      /no message content/
    );
  } finally {
    fake.close();
  }
});

test('constructing without a key fails loudly so the picker can fall back', () => {
  delete process.env.DEEPSEEK_API_KEY;
  assert.throws(() => createDeepSeekProvider(), /DEEPSEEK_API_KEY/);
});
