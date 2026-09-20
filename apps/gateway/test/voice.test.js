'use strict';
/**
 * Conversation mode's ticket: the gateway mints a signed URL for one session
 * with fren's voice agent, so the key never leaves the gateway and the desktop
 * only ever holds a URL good for one conversation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createElevenLabsProvider } = require('../providers/elevenlabs');

function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

const fakeFetch = (status, body) => async (url, init) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  init,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test('mints a signed url with the key in the header and the agent in the query', () =>
  withEnv({ ELEVENLABS_API_KEY: 'k-test' }, async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return fakeFetch(200, { signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?token=abc' })(url, init); };
    const voice = createElevenLabsProvider();
    const url = await voice.signedUrl({ agentId: 'agent_123', fetchImpl });
    assert.equal(url, 'wss://api.elevenlabs.io/v1/convai/conversation?token=abc');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/convai\/conversation\/get-signed-url\?agent_id=agent_123$/);
    assert.equal(calls[0].init.headers['xi-api-key'], 'k-test');
  }));

test('a refusal from ElevenLabs is an error, not a url', () =>
  withEnv({ ELEVENLABS_API_KEY: 'k-test' }, async () => {
    const voice = createElevenLabsProvider();
    await assert.rejects(
      voice.signedUrl({ agentId: 'agent_123', fetchImpl: fakeFetch(401, { detail: 'nope' }) }),
      /elevenlabs 401/
    );
  }));

test('an answer without a signed url is an error too', () =>
  withEnv({ ELEVENLABS_API_KEY: 'k-test' }, async () => {
    const voice = createElevenLabsProvider();
    await assert.rejects(
      voice.signedUrl({ agentId: 'agent_123', fetchImpl: fakeFetch(200, {}) }),
      /no signed url/
    );
  }));

test('no agent id, no request', () =>
  withEnv({ ELEVENLABS_API_KEY: 'k-test' }, async () => {
    const voice = createElevenLabsProvider();
    let called = false;
    await assert.rejects(voice.signedUrl({ agentId: '', fetchImpl: async () => { called = true; } }), /no agent id/);
    assert.equal(called, false);
  }));

// --- the route: GET /v1/voice/session ---------------------------------------
const { createServer } = require('../server');
const { createMockProvider } = require('../providers/mock');
const { config } = require('../../../packages/shared');

async function serve(voice) {
  const server = createServer(createMockProvider(), voice);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = { authorization: `Bearer ${config.GATEWAY_TOKEN}` }) => fetch(`${base}${p}`, { headers });
  const close = () => new Promise((r) => server.close(r));
  return { get, close };
}

test('the route needs the bearer token', async () => {
  const { get, close } = await serve({ signedUrl: async () => 'wss://x' });
  try {
    const res = await get('/v1/voice/session', {});
    assert.equal(res.status, 401);
  } finally { await close(); }
});

test('no voice provider: a 503 that says so', async () => {
  const { get, close } = await serve(null);
  try {
    const res = await get('/v1/voice/session');
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /no voice provider/);
  } finally { await close(); }
});

test('no agent id: a 503 that says where to get one', () =>
  withEnv({ ELEVENLABS_AGENT_ID: '' }, async () => {
    delete process.env.ELEVENLABS_AGENT_ID;
    const { get, close } = await serve({ signedUrl: async () => 'wss://x' });
    try {
      const res = await get('/v1/voice/session');
      assert.equal(res.status, 503);
      assert.match((await res.json()).error, /ELEVENLABS_AGENT_ID is not set/);
    } finally { await close(); }
  }));

test('with the key and the agent, a signed url for one session', () =>
  withEnv({ ELEVENLABS_AGENT_ID: 'agent_123' }, async () => {
    const asked = [];
    const { get, close } = await serve({ signedUrl: async ({ agentId }) => { asked.push(agentId); return 'wss://api.elevenlabs.io/v1/convai/conversation?token=t'; } });
    try {
      const res = await get('/v1/voice/session');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?token=t' });
      assert.deepEqual(asked, ['agent_123']);
    } finally { await close(); }
  }));

test('a failed mint is a 502, in words', () =>
  withEnv({ ELEVENLABS_AGENT_ID: 'agent_123' }, async () => {
    const { get, close } = await serve({ signedUrl: async () => { throw new Error('elevenlabs 401: nope'); } });
    try {
      const res = await get('/v1/voice/session');
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /elevenlabs 401/);
    } finally { await close(); }
  }));

test('/health says whether a conversation could open — the provider AND the agent — and never the id', () =>
  withEnv({ ELEVENLABS_AGENT_ID: 'agent_123' }, async () => {
    const health = async (voice) => {
      const { get, close } = await serve(voice);
      try { return await (await get('/health')).json(); } finally { await close(); }
    };
    const both = await health({ signedUrl: async () => 'wss://x' });
    assert.equal(both.voiceAgent, true);
    assert.ok(!JSON.stringify(both).includes('agent_123'));
    assert.equal((await health(null)).voiceAgent, false, 'no voice provider');
    assert.equal((await health({ speak: async () => ({}) })).voiceAgent, false, 'a voice that cannot mint a session');
    delete process.env.ELEVENLABS_AGENT_ID;
    assert.equal((await health({ signedUrl: async () => 'wss://x' })).voiceAgent, false, 'no agent id');
  }));
