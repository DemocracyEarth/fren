'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createSandboxProxy, chooseUpstream } = require('../sandbox-proxy');

test('the upstream follows the keys, and can be forced', () => {
  assert.equal(chooseUpstream({}).kind, 'none');
  const a = chooseUpstream({ ANTHROPIC_API_KEY: 'sk-ant-x' });
  assert.equal(a.kind, 'anthropic');
  assert.deepEqual(a.headers, { 'x-api-key': 'sk-ant-x' });
  const d = chooseUpstream({ DEEPSEEK_API_KEY: 'sk-d' });
  assert.equal(d.kind, 'deepseek');
  assert.equal(d.model, 'deepseek-chat');
  assert.match(d.baseUrl, /deepseek\.com\/anthropic/);
  const forced = chooseUpstream({ ANTHROPIC_API_KEY: 'sk-ant-x', DEEPSEEK_API_KEY: 'sk-d', FREN_SANDBOX_UPSTREAM: 'deepseek' });
  assert.equal(forced.kind, 'deepseek');
  assert.equal(chooseUpstream({ ANTHROPIC_AUTH_TOKEN: 'oauth' }).headers.authorization, 'Bearer oauth');
});

test('the proxy swaps the sandbox token for the real key and streams the answer', async () => {
  const seen = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, key: req.headers['x-api-key'], host: req.headers.host, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {}\n\n');
      setTimeout(() => res.end('event: message_stop\ndata: {}\n\n'), 10);
    });
  });
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  const upstream = { kind: 'anthropic', baseUrl: `http://127.0.0.1:${fake.address().port}`, headers: { 'x-api-key': 'sk-ant-real' }, model: null };
  const proxy = createSandboxProxy({ upstream, token: 'fren-sandbox-token', log: () => {} });
  const addr = await proxy.listen(0);
  const base = `http://127.0.0.1:${addr.port}`;

  const nope = await fetch(`${base}/anthropic/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' });
  assert.equal(nope.status, 401);
  assert.equal((await fetch(`${base}/elsewhere`, { headers: { authorization: 'Bearer fren-sandbox-token' } })).status, 404);

  const res = await fetch(`${base}/anthropic/v1/messages?beta=true`, {
    method: 'POST', headers: { authorization: 'Bearer fren-sandbox-token', 'content-type': 'application/json' }, body: '{"model":"x"}',
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /message_start/);
  assert.match(text, /message_stop/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/v1/messages?beta=true');
  assert.equal(seen[0].key, 'sk-ant-real', 'the real key rides upstream');
  assert.equal(seen[0].auth, undefined, 'the sandbox token does not');
  assert.equal(seen[0].body, '{"model":"x"}');

  await proxy.close();
  fake.close();
});

test('an upstream with one model gets that model whatever the agent asked for', async () => {
  const seen = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { seen.push({ body: JSON.parse(body), length: req.headers['content-length'] }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  });
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  const upstream = { kind: 'deepseek', baseUrl: `http://127.0.0.1:${fake.address().port}`, headers: { 'x-api-key': 'sk-d' }, model: 'deepseek-chat' };
  const proxy = createSandboxProxy({ upstream, token: 't', log: () => {} });
  const addr = await proxy.listen(0);
  const res = await fetch(`http://127.0.0.1:${addr.port}/anthropic/v1/messages`, {
    method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 10, messages: [] }),
  });
  assert.equal(res.status, 200);
  assert.equal(seen[0].body.model, 'deepseek-chat');
  assert.equal(seen[0].body.max_tokens, 10);
  assert.equal(Number(seen[0].length), Buffer.byteLength(JSON.stringify(seen[0].body)));
  await proxy.close();
  fake.close();
});

test('without a credential the proxy says so instead of forwarding', async () => {
  const proxy = createSandboxProxy({ upstream: chooseUpstream({}), token: 't', log: () => {} });
  const addr = await proxy.listen(0);
  const res = await fetch(`http://127.0.0.1:${addr.port}/anthropic/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{}' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /no model credential/);
  await proxy.close();
});
