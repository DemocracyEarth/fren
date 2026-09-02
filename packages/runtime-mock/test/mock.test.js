'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runContractTests, recorder } = require('../../runtime/contract');
const { RuntimeUnavailable, newId } = require('../../runtime');
const { createMockRuntime } = require('..');

runContractTests({
  name: 'mock',
  createRuntime: () => createMockRuntime({ replyDelayMs: 2 }),
  features: { ask: { trigger: '[ask] send the email' } },
  timeoutMs: 2_000,
});

test('the mock answers deterministically', async () => {
  const rt = createMockRuntime({ replyDelayMs: 1 });
  await rt.start();
  const rec = recorder(rt);
  const session = await rt.createSession({ name: 'x' });
  const runId = newId('run');
  await rt.sendMessage({ sessionId: session.id, runId, text: 'hello there' });
  const msg = await rec.waitFor((e) => e.type === 'agent.message' && e.runId === runId, 1000);
  assert.equal(msg.message.text, '(mock) you said: hello there');
  await rt.stop();
});

test('schedules fire on the fake clock and advance', async () => {
  let clock = new Date(2026, 8, 2, 8, 0).getTime(); // Wed 2026-09-02 08:00 local
  const rt = createMockRuntime({ replyDelayMs: 1, now: () => clock });
  await rt.start();
  const rec = recorder(rt);
  const s = await rt.createSchedule({
    automationId: 'atm_1', name: 'morning', cron: '0 9 * * *', timezone: 'UTC',
    instruction: 'check hn', deliveryName: 'fren',
  });
  assert.equal(new Date(s.nextRunAt).getHours(), 9);
  assert.equal(rt.tick(clock).length, 0, 'not due yet');
  clock = new Date(2026, 8, 2, 9, 0).getTime();
  const started = rt.tick(clock);
  assert.equal(started.length, 1);
  await rec.waitFor((e) => e.type === 'schedule.completed' && e.scheduleId === s.id, 1000);
  const after = (await rt.listSchedules())[0];
  assert.equal(after.runs, 1);
  assert.equal(new Date(after.nextRunAt).getDate(), 3, 'tomorrow');
  assert.equal(rt.tick(clock).length, 0, 'already fired for today');
  const paused = await rt.updateSchedule(s.id, { enabled: false });
  clock = paused.nextRunAt;
  assert.equal(rt.tick(clock).length, 0, 'disabled schedules do not fire');
  await rt.stop();
});

test('stopping interrupts in-flight runs', async () => {
  const rt = createMockRuntime({ replyDelayMs: 10_000 });
  await rt.start();
  const rec = recorder(rt);
  const session = await rt.createSession({ name: 'x' });
  const runId = newId('run');
  await rt.sendMessage({ sessionId: session.id, runId, text: 'slow' });
  await rec.waitFor((e) => e.type === 'run.started' && e.runId === runId, 1000);
  await rt.stop();
  const run = await rt.getRun(runId);
  assert.equal(run.status, 'interrupted');
  assert.ok(rec.events.some((e) => e.type === 'run.interrupted' || e.type === 'runtime.status'));
});

test('an unavailable runtime says so, with a hint', async () => {
  const rt = createMockRuntime({ unavailable: true });
  await assert.rejects(() => rt.start(), (err) => err instanceof RuntimeUnavailable && err.hint.length > 0);
  assert.equal((await rt.getStatus()).state, 'unavailable');
});
