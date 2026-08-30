'use strict';
/**
 * The loopback transport, exercised over real HTTP on an ephemeral port.
 *
 * What is being protected: localhost is not authentication. A web page, a
 * curl, or a process that never went through the consent dialog must get
 * nothing — and a paired extension must keep working across a restart.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createBrowserTransport } = require('../main/browser-transport.js');

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop';

function makeTransport({ approve = async () => true, pairs = [] } = {}) {
  const messages = [];
  let saved = pairs;
  const t = createBrowserTransport({
    port: 0,
    onMessage: (m) => messages.push(m),
    getPolicy: () => ({ enabled: true, readPage: true, readSelection: true, exclusions: ['chase.com'] }),
    approve,
    loadPairs: () => saved,
    savePairs: (p) => { saved = p; },
  });
  return { t, messages, savedPairs: () => saved };
}

async function req(port, path, { method = 'GET', origin, token, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('nothing works without pairing', async () => {
  const { t } = makeTransport();
  await t.start();
  try {
    assert.equal((await req(t.port(), '/config')).status, 401);
    assert.equal((await req(t.port(), '/events', { method: 'POST', body: { type: 'page' } })).status, 401);
    assert.equal((await req(t.port(), '/heartbeat', { method: 'POST' })).status, 401);
  } finally { await t.stop(); }
});

test('only an extension origin may even ask to pair', async () => {
  const { t } = makeTransport();
  await t.start();
  try {
    const web = await req(t.port(), '/pair', { method: 'POST', origin: 'https://evil.example', body: {} });
    assert.equal(web.status, 403, 'a web page cannot pair');
    const bare = await req(t.port(), '/pair', { method: 'POST', body: {} });
    assert.equal(bare.status, 403, 'no origin, no pairing (curl)');
  } finally { await t.stop(); }
});

test('the full life: pair, config, events, heartbeat', async () => {
  const { t, messages } = makeTransport();
  await t.start();
  try {
    const paired = await req(t.port(), '/pair',
      { method: 'POST', origin: EXT_ORIGIN, body: { browser: 'chrome', name: 'fren test' } });
    assert.equal(paired.status, 200);
    const token = paired.body.token;
    assert.match(token, /^[0-9a-f]{64}$/, 'a real 256-bit token');

    const cfg = await req(t.port(), '/config', { origin: EXT_ORIGIN, token });
    assert.equal(cfg.status, 200);
    assert.deepEqual(cfg.body.exclusions, ['chase.com'], 'the policy travels');

    const ev = await req(t.port(), '/events',
      { method: 'POST', origin: EXT_ORIGIN, token, body: { events: [{ type: 'page', url: 'https://a.com' }] } });
    assert.equal(ev.status, 200);
    assert.equal(messages[0].type, 'page');

    const hb = await req(t.port(), '/heartbeat', { method: 'POST', origin: EXT_ORIGIN, token });
    assert.equal(hb.status, 200);
    assert.equal(hb.body.enabled, true, 'policy rides the heartbeat');
    assert.equal(messages[messages.length - 1].type, 'heartbeat');
  } finally { await t.stop(); }
});

test('the token is bound to the origin that earned it', async () => {
  const { t } = makeTransport();
  await t.start();
  try {
    const { body } = await req(t.port(), '/pair', { method: 'POST', origin: EXT_ORIGIN, body: {} });
    const stolen = await req(t.port(), '/config',
      { origin: 'chrome-extension://othergreedyext', token: body.token });
    assert.equal(stolen.status, 401, 'right token, wrong origin: nothing');
  } finally { await t.stop(); }
});

test('a denial sticks for the session', async () => {
  let asks = 0;
  const { t } = makeTransport({ approve: async () => { asks += 1; return false; } });
  await t.start();
  try {
    assert.equal((await req(t.port(), '/pair', { method: 'POST', origin: EXT_ORIGIN, body: {} })).status, 403);
    assert.equal((await req(t.port(), '/pair', { method: 'POST', origin: EXT_ORIGIN, body: {} })).status, 403);
    assert.equal(asks, 1, 'the human is asked once, not besieged');
  } finally { await t.stop(); }
});

test('pairs persist: a saved token works after a restart', async () => {
  const first = makeTransport();
  await first.t.start();
  const { body } = await req(first.t.port(), '/pair', { method: 'POST', origin: EXT_ORIGIN, body: {} });
  await first.t.stop();

  // A new transport, loaded from what the first one saved — a relaunch.
  const second = makeTransport({ pairs: first.savedPairs() });
  await second.t.start();
  try {
    const cfg = await req(second.t.port(), '/config', { origin: EXT_ORIGIN, token: body.token });
    assert.equal(cfg.status, 200, 'the pairing survived the restart');
    assert.ok(second.t.hasPairs());
  } finally { await second.t.stop(); }
});

test('re-pairing replaces the old token instead of collecting spares', async () => {
  const { t, savedPairs } = makeTransport();
  await t.start();
  try {
    const a = await req(t.port(), '/pair', { method: 'POST', origin: EXT_ORIGIN, body: {} });
    // The extension was reinstalled and lost its token; it pairs again.
    const b = await req(t.port(), '/pair', { method: 'POST', origin: EXT_ORIGIN, body: {} });
    assert.equal(savedPairs().length, 1, 'one origin, one credential');
    const old = await req(t.port(), '/config', { origin: EXT_ORIGIN, token: a.body.token });
    assert.equal(old.status, 401, 'the replaced token is dead');
    const fresh = await req(t.port(), '/config', { origin: EXT_ORIGIN, token: b.body.token });
    assert.equal(fresh.status, 200);
  } finally { await t.stop(); }
});

test('stored pairs hold only hashes, never the token itself', async () => {
  const { t, savedPairs } = makeTransport();
  await t.start();
  try {
    const { body } = await req(t.port(), '/pair', { method: 'POST', origin: EXT_ORIGIN, body: {} });
    const stored = JSON.stringify(savedPairs());
    assert.ok(!stored.includes(body.token), 'the credential is not on disk');
    assert.match(savedPairs()[0].tokenHash, /^[0-9a-f]{64}$/);
  } finally { await t.stop(); }
});
