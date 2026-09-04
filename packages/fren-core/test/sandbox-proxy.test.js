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

// ---- the egress lane (forward proxy + per-session allowlist) ----------------

const net = require('node:net');

/** Speak CONNECT to the proxy as a session would; resolves {sock, status}. */
function connectThrough(proxyPort, user, pass, target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      const cred = Buffer.from(`${user}:${pass}`).toString('base64');
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${cred}\r\n\r\n`);
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) { sock.removeListener('data', onData); resolve({ sock, status: buf.split('\r\n')[0] }); }
    };
    sock.on('data', onData);
    sock.on('error', reject);
    sock.on('close', () => resolve({ sock: null, status: (buf.split('\r\n')[0] || 'CLOSED') }));
  });
}

/** One HTTP GET over an already-open tunnel socket; resolves the body. */
function getOverTunnel(sock, host) {
  return new Promise((resolve) => {
    sock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    let buf = '';
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('close', () => resolve(buf));
  });
}

async function egressFixture() {
  const target = http.createServer((_req, res) => { res.writeHead(200); res.end('HELLO-FROM-TARGET'); });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const proxy = createSandboxProxy({ upstream: chooseUpstream({}), token: 'host-secret', log: () => {} });
  const addr = await proxy.listen(0);
  return { target, targetPort: target.address().port, proxy, proxyPort: addr.port };
}

test('the egress lane tunnels a session to an allowed host and blocks the rest', async () => {
  const { target, targetPort, proxy, proxyPort } = await egressFixture();
  const sid = 'sess-abc';
  const pass = proxy.sessionToken(sid);

  // Allowed: 127.0.0.1 is on the list -> 200 Established, real bytes flow.
  proxy.setSessionAllow(sid, { mode: 'list', hosts: ['127.0.0.1'] });
  const ok = await connectThrough(proxyPort, `s.${sid}`, pass, `127.0.0.1:${targetPort}`);
  assert.match(ok.status, /200/, 'an allowed host is tunnelled');
  assert.match(await getOverTunnel(ok.sock, `127.0.0.1:${targetPort}`), /HELLO-FROM-TARGET/);
  ok.sock?.destroy();

  // Same host, policy now allows only elsewhere -> refused.
  proxy.setSessionAllow(sid, { mode: 'list', hosts: ['example.com'] });
  const no = await connectThrough(proxyPort, `s.${sid}`, pass, `127.0.0.1:${targetPort}`);
  assert.match(no.status, /403/, 'a host off the list is refused');
  no.sock?.destroy();

  await proxy.close();
  target.close();
});

test('the egress lane denies by default, allows open, and honors subdomains', async () => {
  const { target, targetPort, proxy, proxyPort } = await egressFixture();
  const sid = 'sess-def';
  const pass = proxy.sessionToken(sid);

  // No policy registered -> deny (fail closed).
  const unset = await connectThrough(proxyPort, `s.${sid}`, pass, `127.0.0.1:${targetPort}`);
  assert.match(unset.status, /403/, 'a session with no policy reaches nothing');
  unset.sock?.destroy();

  // off -> deny even with a list present is n/a; open -> anywhere.
  proxy.setSessionAllow(sid, { mode: 'off', hosts: [] });
  const offRes = await connectThrough(proxyPort, `s.${sid}`, pass, `127.0.0.1:${targetPort}`);
  assert.match(offRes.status, /403/); offRes.sock?.destroy();
  proxy.setSessionAllow(sid, { mode: 'open', hosts: [] });
  const openRes = await connectThrough(proxyPort, `s.${sid}`, pass, `127.0.0.1:${targetPort}`);
  assert.match(openRes.status, /200/, 'open forwards anywhere'); openRes.sock?.destroy();

  // An empty list collapses to off, not open.
  proxy.setSessionAllow(sid, { mode: 'list', hosts: [] });
  assert.equal(proxy.sessionAllowFor(sid).mode, 'off');
  await proxy.close();
  target.close();
});

test('an egress credential is per-session, unforgeable, and required', async () => {
  const { target, targetPort, proxy, proxyPort } = await egressFixture();
  const a = 'sess-A';
  const b = 'sess-B';
  proxy.setSessionAllow(a, { mode: 'open', hosts: [] });
  proxy.setSessionAllow(b, { mode: 'open', hosts: [] });

  // No credential at all.
  const r1 = await connectThrough(proxyPort, 'x', 'y', `127.0.0.1:${targetPort}`); assert.match(r1.status, /407/); r1.sock?.destroy();
  // A's token presented as A works; presented as B (user mismatch) does not.
  const r2 = await connectThrough(proxyPort, `s.${a}`, proxy.sessionToken(a), `127.0.0.1:${targetPort}`); assert.match(r2.status, /200/); r2.sock?.destroy();
  const r3 = await connectThrough(proxyPort, `s.${b}`, proxy.sessionToken(a), `127.0.0.1:${targetPort}`); assert.match(r3.status, /407/, 'A\'s token cannot speak for B'); r3.sock?.destroy();
  // A guessed token is rejected.
  const r4 = await connectThrough(proxyPort, `s.${a}`, 'deadbeef'.repeat(4), `127.0.0.1:${targetPort}`); assert.match(r4.status, /407/); r4.sock?.destroy();

  await proxy.close();
  target.close();
});

test('the model lane is unchanged by the egress lane', async () => {
  const { sessionProxyToken, hostUnderDomain, normalizeHost } = require('../sandbox-proxy');
  // pure helpers
  assert.equal(hostUnderDomain('api.github.com', 'github.com'), true);
  assert.equal(hostUnderDomain('notgithub.com', 'github.com'), false);
  assert.equal(hostUnderDomain('github.com', 'github.com'), true);
  assert.equal(normalizeHost('API.Example.COM.'), 'api.example.com');
  // the token derivation is stable and session-specific
  assert.equal(sessionProxyToken('k', 's1'), sessionProxyToken('k', 's1'));
  assert.notEqual(sessionProxyToken('k', 's1'), sessionProxyToken('k', 's2'));
  assert.notEqual(sessionProxyToken('k1', 's1'), sessionProxyToken('k2', 's1'));

  const proxy = createSandboxProxy({ upstream: chooseUpstream({}), token: 't', log: () => {} });
  const addr = await proxy.listen(0);
  // /anthropic still authenticates on the base token and 404s a stray path.
  assert.equal((await fetch(`http://127.0.0.1:${addr.port}/anthropic/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{}' })).status, 503);
  assert.equal((await fetch(`http://127.0.0.1:${addr.port}/elsewhere`, { headers: { authorization: 'Bearer t' } })).status, 404);
  await proxy.close();
});

test('the install-wide default applies to any authenticated session without its own policy', async () => {
  const { target, targetPort, proxy, proxyPort } = await egressFixture();
  const sid = 'sess-default';
  const pass = proxy.sessionToken(sid);
  // No per-session policy and no default -> deny.
  const a = await connectThrough(proxyPort, `s.${sid}`, pass, `127.0.0.1:${targetPort}`);
  assert.match(a.status, /403/); a.sock?.destroy();
  // A default list that includes the host -> allowed, even with no session entry.
  proxy.setDefaultAllow({ mode: 'list', hosts: ['127.0.0.1'] });
  const b = await connectThrough(proxyPort, `s.${sid}`, pass, `127.0.0.1:${targetPort}`);
  assert.match(b.status, /200/); b.sock?.destroy();
  // A per-session policy overrides the default (here, tighter).
  proxy.setSessionAllow(sid, { mode: 'off', hosts: [] });
  const c = await connectThrough(proxyPort, `s.${sid}`, pass, `127.0.0.1:${targetPort}`);
  assert.match(c.status, /403/); c.sock?.destroy();
  await proxy.close();
  target.close();
});
