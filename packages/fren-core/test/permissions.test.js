'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCore } = require('..');
const { openCoreStore } = require('../store');
const { createMockRuntime } = require('../../runtime-mock');
const { createPermissionBroker } = require('../permission-broker');
const { createEventLog } = require('../events');

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-perm-'));
  const store = openCoreStore(path.join(dir, 'core.db'));
  const runtime = createMockRuntime({ replyDelayMs: 2, ...opts.runtime });
  const core = createCore({ store, runtime, log: () => {}, reprobeMs: 0, ...opts.core });
  return { store, runtime, core };
}

async function until(fn, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('an agent that asks pauses the run until the person answers; approve lets it finish', async () => {
  const { core } = setup();
  await core.start();
  await core.startRuntime();
  const seen = [];
  core.events.subscribe((e) => seen.push(e));
  const run = await core.runs.start({ text: '[ask] send the email' });
  const asked = await until(() => seen.find((e) => e.type === 'permission.requested'));
  assert.equal(asked.request.status, 'open');
  assert.equal(asked.request.action, 'mock.ask');
  assert.equal(asked.request.scope, 'unknown', 'the mock action has no scope, so it asks');
  assert.match(asked.request.question, /send the email/);
  assert.equal(core.permissions.list({ status: 'open' }).length, 1);
  assert.ok(!seen.some((e) => e.type === 'run.completed'), 'the run waits');

  const answered = await core.permissions.decide(asked.request.id, { decision: 'approve' });
  assert.equal(answered.status, 'approved');
  await until(() => seen.find((e) => e.type === 'run.completed' && e.runId === run.id));
  const done = core.runs.get(run.id);
  assert.match(done.messages[0].text, /^approved:/);
  assert.ok(seen.some((e) => e.type === 'permission.approved' && e.auto === false));
  await assert.rejects(() => core.permissions.decide(asked.request.id, { decision: 'deny' }), /already approved/);
  await core.stop();
});

test('deny ends the run with a refusal', async () => {
  const { core } = setup();
  await core.start();
  await core.startRuntime();
  const seen = [];
  core.events.subscribe((e) => seen.push(e));
  const run = await core.runs.start({ text: '[ask] wipe the disk' });
  const asked = await until(() => seen.find((e) => e.type === 'permission.requested'));
  await core.permissions.decide(asked.request.id, { decision: 'deny', reason: 'no' });
  await until(() => seen.find((e) => e.type === 'run.completed' && e.runId === run.id));
  assert.match(core.runs.get(run.id).messages[0].text, /you declined/);
  await core.stop();
});

test('an unanswered request expires to a deny', async () => {
  let clock = 1_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-perm-exp-'));
  const store = openCoreStore(path.join(dir, 'core.db'));
  const events = createEventLog({ store, now: () => clock });
  const answers = [];
  const runtime = { resolvePermission: async (id, d, r) => answers.push([id, d, r]) };
  const broker = createPermissionBroker({ store, events, getRuntime: () => runtime, now: () => clock, expiryMs: 1000 });
  broker.onRuntimeEvent({ type: 'permission.request', request: { id: 'rq1', action: 'shell.exec', title: 't', question: 'q', options: ['approve', 'deny'] } });
  assert.equal(broker.list({ status: 'open' }).length, 1);
  assert.equal(broker.expireStale(), 0);
  clock += 1001;
  assert.equal(broker.expireStale(), 1);
  assert.equal(broker.list({ status: 'expired' }).length, 1);
  assert.deepEqual(answers[0], ['rq1', 'deny', 'nobody answered in time']);
  await assert.rejects(() => broker.decide(broker.list()[0].id, { decision: 'approve' }), /already expired/);
  store.close();
});

test('a grant on the automation allows without asking; a session grant is remembered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-perm-grant-'));
  const store = openCoreStore(path.join(dir, 'core.db'));
  const seen = [];
  const events = createEventLog({ store });
  events.subscribe((e) => seen.push(e));
  const answers = [];
  const runtime = { resolvePermission: async (id, d) => answers.push([id, d]) };
  const broker = createPermissionBroker({ store, events, getRuntime: () => runtime });
  store.insertAutomation({
    id: 'atm_1', name: 'x', trigger: { type: 'manual' }, body: { kind: 'agent', instruction: 'y' },
    permissions: ['runtime.self_modify'], createdAt: 1,
  });
  broker.onRuntimeEvent({ type: 'permission.request', request: { id: 'rq1', action: 'self_mod.install_packages', title: 't', question: 'q', options: [], automationId: 'atm_1' } });
  assert.deepEqual(answers, [['rq1', 'approve']]);
  assert.equal(seen[seen.length - 1].type, 'permission.approved');
  assert.equal(seen[seen.length - 1].rule, 'automation-grant');

  // The same action from a conversation asks, and "remember for this conversation" sticks.
  broker.onRuntimeEvent({ type: 'permission.request', request: { id: 'rq2', action: 'self_mod.install_packages', title: 't', question: 'q', options: [], sessionId: 'ses_1' } });
  const open = broker.list({ status: 'open' });
  assert.equal(open.length, 1);
  assert.equal(open[0].scope, 'runtime.self_modify');
  assert.equal(open[0].description, 'install tools into its own workspace');
  await broker.decide(open[0].id, { decision: 'approve', remember: 'session' });
  broker.onRuntimeEvent({ type: 'permission.request', request: { id: 'rq3', action: 'self_mod.install_packages', title: 't', question: 'q', options: [], sessionId: 'ses_1' } });
  assert.deepEqual(answers[answers.length - 1], ['rq3', 'approve']);
  assert.equal(broker.list({ status: 'open' }).length, 0);
  store.close();
});

test('the routes: list open requests, decide, and errors', async () => {
  const { core } = setup();
  await core.start();
  await core.startRuntime();
  const seen = [];
  core.events.subscribe((e) => seen.push(e));
  await core.runs.start({ text: '[ask] do a thing' });
  const asked = await until(() => seen.find((e) => e.type === 'permission.requested'));
  const res = { writeHead(s) { this.status = s; }, end(b) { this.body = JSON.parse(b); } };
  await core.handle({ method: 'GET', headers: {} }, res, '/v1/permissions/requests', null, { status: 'open' });
  assert.equal(res.status, 200);
  assert.equal(res.body.requests.length, 1);
  await core.handle({ method: 'POST', headers: {} }, res, `/v1/permissions/requests/${asked.request.id}/decision`, { decision: 'maybe' }, {});
  assert.equal(res.status, 400);
  await core.handle({ method: 'POST', headers: {} }, res, `/v1/permissions/requests/${asked.request.id}/decision`, { decision: 'approve' }, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.request.status, 'approved');
  await core.handle({ method: 'POST', headers: {} }, res, '/v1/permissions/requests/perm_nope/decision', { decision: 'approve' }, {});
  assert.equal(res.status, 404);
  await core.stop();
});
