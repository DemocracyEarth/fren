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
  const core = createCore({ store, runtime, complete: opts.complete || null, log: () => {}, reprobeMs: 0, ...opts.core });
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

test('a schedule the runtime gives up on goes off with the reason; Resume is the only way back', async () => {
  let clock = new Date(2026, 8, 2, 8, 0).getTime();
  const { core, runtime, store } = setup({ runtime: { now: () => clock, pauseAfterFailures: 2 } });
  await core.start();
  await core.startRuntime();
  const seen = [];
  core.events.subscribe((e) => seen.push(e));
  const a = await core.automations.create({ ...HN, body: { kind: 'agent', instruction: '[fail] check the news' } });
  clock = new Date(2026, 8, 2, 9, 0).getTime();
  assert.equal(runtime.tick(clock).length, 1);
  await until(() => store.listAutomationRuns(a.id).some((r) => r.status === 'failed'));
  assert.equal(store.getAutomation(a.id).enabled, true, 'one failure is a failed run, not a verdict');
  clock = new Date(2026, 8, 3, 9, 0).getTime();
  assert.equal(runtime.tick(clock).length, 1);
  const paused = await until(() => seen.find((e) => e.type === 'automation.paused' && e.automationId === a.id));
  assert.equal(paused.name, 'morning AI news');
  assert.equal(paused.detail, 'it failed 2 times in a row');
  const off = core.automations.get(a.id);
  assert.equal(off.enabled, false);
  assert.equal(off.pausedByRuntime, 'it failed 2 times in a row');
  assert.equal(off.nextRunAt, null);
  assert.equal(store.listAutomationRuns(a.id).filter((r) => r.status === 'failed').length, 2);
  assert.equal(runtime.tick(new Date(2026, 8, 4, 9, 0).getTime()).length, 0, 'nothing fires while it is off');
  const back = await core.automations.update(a.id, { enabled: true });
  assert.equal(back.enabled, true);
  assert.equal(back.pausedByRuntime, null);
  assert.ok(back.nextRunAt);
  const s = (await runtime.listSchedules())[0];
  assert.equal(s.enabled, true);
  assert.equal(s.pausedByRuntime, undefined);
  await core.stop();
});

test('a pause that happened while Core was away is found at reconcile, not undone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-atm-away-'));
  const store = openCoreStore(path.join(dir, 'core.db'));
  const runtime = createMockRuntime({ replyDelayMs: 2 });
  const first = createCore({ store, runtime, log: () => {}, reprobeMs: 0 });
  await first.start();
  await first.startRuntime();
  const a = await first.automations.create(HN);
  await first.stop();
  runtime.giveUp(store.getAutomation(a.id).runtimeRef.id, 'it failed 8 times in a row');
  const second = createCore({ store, runtime, log: () => {}, reprobeMs: 0 });
  await second.start();
  await second.startRuntime();
  await until(() => !store.getAutomation(a.id).enabled);
  const off = second.automations.get(a.id);
  assert.equal(off.pausedByRuntime, 'it failed 8 times in a row');
  assert.equal(off.runtimeState, 'scheduled');
  assert.equal((await runtime.listSchedules())[0].enabled, false, 'reconcile did not resume it');
  await second.stop();
});

test('a scheduled run is given the runtime\'s patience, not a chat turn\'s', async () => {
  const { core, runtime } = setup({ runtime: { replyDelayMs: 120 }, core: { runTimeoutMs: 30, scheduleTimeoutMs: 5000 } });
  await core.start();
  await core.startRuntime();
  const seen = [];
  core.events.subscribe((e) => seen.push(e));
  const a = await core.automations.create(HN);
  const { run } = await core.automations.runNow(a.id);
  const done = await until(() => seen.find((e) => /^automation\.run\.(completed|failed)$/.test(e.type) && e.runId === run.id));
  assert.equal(done.type, 'automation.run.completed', 'a chat turn would have been given up on after 30 ms');
  assert.equal(done.delivered, true);
  await core.stop();
});

test('a one-off automation runs at its moment, once, and is then done', async () => {
  let clock = new Date(2026, 8, 3, 10, 0).getTime();
  const { core, runtime } = setup({ runtime: { now: () => clock }, core: { now: () => clock } });
  await core.start();
  await core.startRuntime();
  const seen = [];
  core.events.subscribe((e) => seen.push(e));
  const at = new Date(2026, 8, 4, 15, 0).getTime();
  const a = await core.automations.create({ name: 'call Ana', trigger: { type: 'at', at }, body: { kind: 'agent', instruction: 'Remind the owner to call Ana.' }, permissions: [] });
  assert.equal(a.describe, 'tomorrow at 15:00');
  assert.equal(a.nextRunAt, at);
  assert.equal(a.runtimeState, 'scheduled');
  clock = at;
  assert.equal(runtime.tick(clock).length, 1);
  await until(() => seen.find((e) => e.type === 'automation.run.completed' && e.automationId === a.id));
  const done = core.automations.get(a.id);
  assert.equal(done.enabled, false, 'a moment comes once');
  assert.equal(done.nextRunAt, null);
  assert.ok(seen.some((e) => e.type === 'automation.updated' && e.automationId === a.id && e.done === true));
  assert.equal(runtime.tick(clock + 86400000).length, 0);
  await assert.rejects(
    () => core.automations.create({ name: 'gone', trigger: { type: 'at', at: clock - 3600000 }, body: { kind: 'agent', instruction: 'x' }, permissions: [] }),
    /already passed/,
  );
  await core.stop();
});

test('a "whenever" automation runs when the desktop notices the app, once per sighting', async () => {
  let clock = new Date(2026, 8, 3, 10, 0).getTime();
  const { core, store } = setup({ runtime: { now: () => clock }, core: { now: () => clock } });
  await core.start();
  await core.startRuntime();
  const seen = [];
  core.events.subscribe((e) => seen.push(e));
  const a = await core.automations.create({ name: 'figma tokens', trigger: { type: 'event', filter: { app: 'Figma' } }, body: { kind: 'agent', instruction: 'Remind the owner to check the design tokens.' }, permissions: [] });
  assert.equal(a.describe, 'whenever you open Figma');
  assert.equal(a.runtimeState, 'local');
  assert.ok(core.observations.publish({ timestamp: clock, source: 'os', type: 'active-window', payload: { app: 'Figma', title: 'tokens.fig' } }));
  const done = await until(() => seen.find((e) => e.type === 'automation.run.completed' && e.automationId === a.id));
  assert.equal(done.delivered, true);
  assert.equal(store.listAutomationRuns(a.id)[0].trigger, 'event');
  core.observations.publish({ timestamp: clock + 1000, source: 'os', type: 'active-window', payload: { app: 'Figma', title: 'other.fig' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(store.listAutomationRuns(a.id).length, 1, 'a window that stays in front is one sighting');
  clock += 31 * 60 * 1000;
  core.observations.publish({ timestamp: clock, source: 'os', type: 'active-window', payload: { app: 'Figma', title: 'later.fig' } });
  await until(() => store.listAutomationRuns(a.id).length === 2);
  core.observations.publish({ timestamp: clock, source: 'os', type: 'active-window', payload: { app: 'Code', title: 'x' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(store.listAutomationRuns(a.id).length, 2, 'another app is not a sighting');
  const site = await core.automations.create({ name: 'pull requests', trigger: { type: 'event', filter: { site: 'https://www.github.com/x' } }, body: { kind: 'agent', instruction: 'List my open pull requests.' }, permissions: [] });
  assert.equal(site.describe, 'whenever you are on github.com');
  await assert.rejects(() => core.automations.create({ name: 'nothing', trigger: { type: 'event', filter: {} }, body: { kind: 'agent', instruction: 'x' }, permissions: [] }), /needs an app or a site/);
  await core.stop();
});

test('intent: a moment and a "whenever" come back with a ready trigger and a description', async () => {
  const now = new Date(2026, 8, 3, 10, 0).getTime();
  const { core } = setup({ core: { now: () => now } });
  await core.start();
  const once = await core.automations.intent('tomorrow at 3 remind me to call Ana');
  assert.equal(once.isAutomation, true);
  assert.deepEqual(once.trigger, { type: 'at', at: new Date(2026, 8, 4, 15, 0).getTime() });
  assert.equal(once.describe, 'tomorrow at 15:00');
  const when = await core.automations.intent('whenever I open Figma, remind me to check the tokens');
  assert.deepEqual(when.trigger, { type: 'event', filter: { app: 'Figma' } });
  assert.equal(when.describe, 'whenever you open Figma');
  const repeat = await core.automations.intent('every morning at 9 check the news');
  assert.deepEqual(repeat.trigger, { type: 'schedule', cron: '0 9 * * *' });
  await core.stop();
});

test('an automation carries a normalized egress allowlist that round-trips and reaches the runtime handoff', async () => {
  const { core, store } = setup();
  await core.start();
  await core.startRuntime();
  const a = await core.automations.create({
    ...HN,
    network: { domains: ['https://www.News.ycombinator.com/news', 'api.github.com', 'api.github.com', ''] },
  });
  // normalized, de-duped, scheme/www/path stripped
  assert.deepEqual(a.network.domains, ['news.ycombinator.com', 'api.github.com']);
  // persisted and read back
  assert.deepEqual(store.getAutomation(a.id).network.domains, ['news.ycombinator.com', 'api.github.com']);
  // no allowlist -> null (the environment keeps its current reach)
  const b = await core.automations.create({ ...HN, name: 'no list', network: { domains: [] } });
  assert.equal(b.network, null);
  const c = await core.automations.create({ ...HN, name: 'unset' });
  assert.equal(c.network, null);
  // an update can add and later clear the allowlist
  const upd = await core.automations.update(b.id, { network: { domains: ['example.com'] } });
  assert.deepEqual(upd.network.domains, ['example.com']);
  const cleared = await core.automations.update(b.id, { network: { domains: [] } });
  assert.equal(cleared.network, null);
});

test('the egress ask: noise and no-audience are refused silently, a present person is asked, and the answer is recorded', async () => {
  const grants = [];
  const defaults = [];
  const egress = {
    setDefault: (p) => defaults.push(p),
    grantSessionHost: (sid, host) => grants.push({ sid, host }),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-egress-'));
  const store = openCoreStore(path.join(dir, 'core.db'));
  const core = createCore({ store, runtime: createMockRuntime({ replyDelayMs: 2 }), log: () => {}, reprobeMs: 0, egress });
  await core.start();

  // Noise is refused without a card.
  assert.equal(await core.askEgress('s1', 'api.anthropic.com'), false);
  // With nobody present (no running chat run), a real host is still refused.
  assert.equal(await core.askEgress('s1', 'example.com'), false);

  // A person is present: a running chat run. Now the same host raises a card.
  store.insertRun({ id: 'run_live', sessionId: 's1', kind: 'chat', status: 'running' });
  let asked = null;
  const unsub = core.events.subscribe((e) => { if (e.type === 'permission.requested') asked = e.request; });
  const pending = core.askEgress('s1', 'example.com');
  await until(() => asked);
  assert.match(asked.question, /reach example\.com/);
  assert.deepEqual(asked.options, ['once', 'always', 'deny']);
  // Answer "once": granted for the session, not persisted to the default.
  await core.permissions.decide(asked.id, { decision: 'approve', remember: 'once' });
  assert.equal(await pending, true);
  assert.deepEqual(grants, [{ sid: 's1', host: 'example.com' }]);

  // Asked once per session: a second ask for the same host is refused without a card.
  asked = null;
  assert.equal(await core.askEgress('s1', 'example.com'), false);
  assert.equal(asked, null);

  // "always" persists to the trusted set and re-pushes the default.
  asked = null;
  const pending2 = core.askEgress('s1', 'weather.example.org');
  await until(() => asked);
  await core.permissions.decide(asked.id, { decision: 'approve', remember: 'always' });
  assert.equal(await pending2, true);
  assert.equal(JSON.parse(store.getSetting('egress.trusted')).includes('weather.example.org'), true);
  assert.ok(defaults.some((p) => p && p.hosts && p.hosts.includes('weather.example.org')), 'the trusted host reaches the default');

  unsub();
  await core.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a denied egress ask does not grant', async () => {
  const grants = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-egress-'));
  const store = openCoreStore(path.join(dir, 'core.db'));
  const core = createCore({ store, runtime: createMockRuntime({ replyDelayMs: 2 }), log: () => {}, reprobeMs: 0, egress: { grantSessionHost: (sid, host) => grants.push({ sid, host }) } });
  await core.start();
  store.insertRun({ id: 'run_live', sessionId: 's9', kind: 'chat', status: 'running' });
  let asked = null;
  const unsub = core.events.subscribe((e) => { if (e.type === 'permission.requested') asked = e.request; });
  const pending = core.askEgress('s9', 'tracker.example.com');
  await until(() => asked);
  await core.permissions.decide(asked.id, { decision: 'deny' });
  assert.equal(await pending, false);
  assert.deepEqual(grants, []);
  unsub();
  await core.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
