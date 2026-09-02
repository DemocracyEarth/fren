'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCore } = require('..');
const { openCoreStore } = require('../store');
const { createMockRuntime } = require('../../runtime-mock');

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-atm-'));
  const store = openCoreStore(path.join(dir, 'core.db'));
  const runtime = createMockRuntime({ replyDelayMs: 2, ...opts.runtime });
  const core = createCore({ store, runtime, complete: opts.complete || null, log: () => {}, reprobeMs: 0 });
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

const HN = {
  name: 'morning AI news',
  trigger: { type: 'schedule', cron: '0 9 * * *' },
  body: { kind: 'agent', instruction: 'Check Hacker News and report the five most interesting AI stories.' },
  permissions: ['network.request'],
};

test('an automation is created, scheduled in the runtime, listed with a description', async () => {
  const { core, runtime, store } = setup();
  await core.start();
  await core.startRuntime();
  const a = await core.automations.create(HN);
  assert.match(a.id, /^atm_/);
  assert.equal(a.enabled, true);
  assert.equal(a.describe, 'every day at 09:00');
  assert.equal(a.runtimeState, 'scheduled');
  assert.ok(a.nextRunAt > Date.now());
  const schedules = await runtime.listSchedules();
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].automationId, a.id);
  assert.match(schedules[0].instruction, /automation "morning AI news"/);
  assert.match(schedules[0].instruction, /send_message to the destination named "automation-atm_/);
  assert.deepEqual(store.getAutomation(a.id).runtimeRef, { kind: 'mock', id: schedules[0].id });
  assert.equal(core.automations.list().length, 1);
  await core.stop();
});

test('validation: name, cron, fire limit, body kind, permissions', async () => {
  const { core } = setup();
  await core.start();
  await core.startRuntime();
  await assert.rejects(() => core.automations.create({ ...HN, name: '' }), /needs a name/);
  await assert.rejects(() => core.automations.create({ ...HN, trigger: { type: 'schedule', cron: 'nope' } }), /invalid cron/);
  await assert.rejects(() => core.automations.create({ ...HN, trigger: { type: 'schedule', cron: '* * * * *' } }), /times a day/);
  await assert.rejects(() => core.automations.create({ ...HN, body: { kind: 'script', script: 'ls' } }), /managed elsewhere/);
  await assert.rejects(() => core.automations.create({ ...HN, permissions: ['root.everything'] }), /unknown permission/);
  await assert.rejects(() => core.automations.create({ ...HN, trigger: { type: 'nope' } }), /trigger must be/);
  await core.stop();
});

test('enable, disable, edit and delete are mirrored in the runtime', async () => {
  const { core, runtime } = setup();
  await core.start();
  await core.startRuntime();
  const a = await core.automations.create(HN);
  const off = await core.automations.update(a.id, { enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.nextRunAt, null);
  assert.equal((await runtime.listSchedules())[0].enabled, false);
  assert.equal(off.revision, 2);
  await assert.rejects(() => core.automations.update(a.id, { enabled: true, expectedRevision: 1 }), /changed since/);
  const on = await core.automations.update(a.id, { enabled: true, expectedRevision: 2, trigger: { type: 'schedule', cron: '30 8 * * 1-5' } });
  assert.equal(on.describe, 'weekdays at 08:30');
  assert.equal((await runtime.listSchedules())[0].cron, '30 8 * * 1-5');
  await core.automations.remove(a.id);
  assert.equal(core.automations.list().length, 0);
  assert.equal((await runtime.listSchedules()).length, 0);
  assert.deepEqual(await core.automations.remove(a.id), { deleted: false });
  await core.stop();
});

test('run now: a run is adopted, its message carries the name, the record closes with output', async () => {
  const { core, store } = setup();
  await core.start();
  await core.startRuntime();
  const seen = [];
  core.events.subscribe((e) => seen.push(e));
  const a = await core.automations.create(HN);
  const { run, automationRun } = await core.automations.runNow(a.id);
  assert.equal(run.kind, 'schedule');
  assert.equal(run.automationId, a.id);
  assert.equal(automationRun.trigger, 'manual');
  const done = await until(() => seen.find((e) => e.type === 'automation.run.completed' && e.automationId === a.id));
  assert.equal(done.name, 'morning AI news');
  assert.match(done.output, /\(mock\) morning AI news ran/);
  assert.equal(done.delivered, true);
  const msg = seen.find((e) => e.type === 'agent.message' && e.automationId === a.id);
  assert.equal(msg.automationName, 'morning AI news');
  const rec = store.listAutomationRuns(a.id)[0];
  assert.equal(rec.status, 'ok');
  assert.equal(rec.delivered, true);
  assert.equal(store.listAutomationRuns(a.id).length, 1, 'schedule.fired did not add a second record');
  assert.ok(store.getAutomation(a.id).lastRunAt);
  await core.stop();
});

test('a scheduled fire from the runtime is recorded without anyone asking', async () => {
  let clock = new Date(2026, 8, 2, 8, 0).getTime();
  const { core, runtime, store } = setup({ runtime: { now: () => clock } });
  await core.start();
  await core.startRuntime();
  const seen = [];
  core.events.subscribe((e) => seen.push(e));
  const a = await core.automations.create(HN);
  clock = new Date(2026, 8, 2, 9, 0).getTime();
  assert.equal(runtime.tick(clock).length, 1);
  await until(() => seen.find((e) => e.type === 'automation.run.completed' && e.automationId === a.id));
  const rec = store.listAutomationRuns(a.id)[0];
  assert.equal(rec.trigger, 'schedule');
  assert.equal(rec.status, 'ok');
  assert.ok(seen.some((e) => e.type === 'automation.triggered' && e.trigger === 'schedule'));
  await core.stop();
});

test('automations survive a runtime restart: they are re-scheduled on reconcile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-atm-restart-'));
  const store = openCoreStore(path.join(dir, 'core.db'));
  const first = createCore({ store, runtime: createMockRuntime({ replyDelayMs: 2 }), log: () => {}, reprobeMs: 0 });
  await first.start();
  await first.startRuntime();
  const a = await first.automations.create(HN);
  await first.stop();
  // A fresh runtime knows nothing; Core puts the schedule back.
  const runtime = createMockRuntime({ replyDelayMs: 2 });
  const second = createCore({ store, runtime, log: () => {}, reprobeMs: 0 });
  await second.start();
  await second.startRuntime();
  const schedules = await runtime.listSchedules();
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].automationId, a.id);
  assert.equal(second.automations.get(a.id).runtimeState, 'scheduled');
  await second.stop();
});

test('running when the runtime is unavailable is refused, listing still works', async () => {
  const { core } = setup({ runtime: { unavailable: true } });
  await core.start();
  await until(() => core.runtimeStatus().state === 'unavailable');
  const a = await core.automations.create(HN); // kept locally, waiting
  assert.equal(a.runtimeState, 'waiting');
  await assert.rejects(() => core.automations.runNow(a.id), /not available/);
  await core.stop();
});

test('intent: the heuristic reads the milestone sentence when no model can', async () => {
  const { core } = setup();
  await core.start();
  const r = await core.automations.intent('Every morning at 9, check Hacker News and give me the five most interesting AI stories.');
  assert.equal(r.isAutomation, true);
  assert.equal(r.cron, '0 9 * * *');
  assert.equal(r.describe, 'every day at 09:00');
  assert.equal(r.source, 'heuristic');
  assert.equal((await core.automations.intent('what did I do yesterday?')).isAutomation, false);
  await core.stop();
});

test('intent: the model is preferred when it answers, and checked', async () => {
  const answers = [];
  const complete = async () => answers.shift();
  const { core } = setup({ complete });
  await core.start();
  answers.push(JSON.stringify({ isAutomation: true, name: 'friday wrap', cron: '0 18 * * fri', instruction: 'Summarise the week.', reason: '' }));
  let r = await core.automations.intent('each friday at 6pm summarise the week');
  assert.equal(r.source, 'model');
  assert.equal(r.cron, '0 18 * * fri');
  assert.equal(r.instruction, 'Summarise the week.');
  answers.push(JSON.stringify({ isAutomation: true, name: 'x', cron: 'tomorrow', instruction: 'Do it.', reason: '' }));
  r = await core.automations.intent('every day at 7 do it');
  assert.equal(r.cron, '0 7 * * *', 'a bad cron from the model falls back to the heuristic reading');
  answers.push(JSON.stringify({ isAutomation: false, name: '', cron: '', instruction: '', reason: 'that is a question' }));
  r = await core.automations.intent('every day, what did I do?');
  assert.equal(r.isAutomation, false);
  assert.equal(r.reason, 'that is a question');
  answers.push('{"activity":"x"}'); // the mock provider's shape: unreadable as intent
  r = await core.automations.intent('every morning at 9 check hn');
  assert.equal(r.source, 'heuristic');
  await core.stop();
});
