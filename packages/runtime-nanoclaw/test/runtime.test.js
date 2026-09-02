'use strict';
// The adapter against a fake host: the contract, plus what the fake lets us pin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runContractTests, recorder } = require('../../runtime/contract');
const { newId } = require('../../runtime');
const { createNanoclawRuntime } = require('..');
const { createNclClient } = require('../ncl-client');
const { check } = require('../../../scripts/nanoclaw-overlay-check');

const FAKE_HOST = path.join(__dirname, 'fake-host.js');

function makeRuntime({ base = fs.mkdtempSync(path.join('/tmp', 'frn-')), ...extra } = {}) {
  // A short socket path: Unix sockets are limited to ~100 bytes.
  const runtimeDir = path.join(base, 'rt');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const rt = createNanoclawRuntime({
    dataDir: path.join(base, 'd'), runtimeDir, sandboxUrl: 'http://host.docker.internal:4527/anthropic', sandboxToken: 'fren-test-token',
    timezone: 'UTC', log: () => {}, skipContainerProbe: true, hostCommand: [process.execPath, [FAKE_HOST]], connectTimeoutMs: 10_000,
    ...extra,
  });
  rt.testDirs = { base, runtimeDir };
  return rt;
}

async function eventually(fn, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The fake host's control socket, for what only a test may ask of it. */
const hostControl = (rt) => createNclClient({ socketPath: path.join(rt.testDirs.runtimeDir, 'data', 'ncl.sock') });

const compiled = (automationId, name, body) => `You are running FREN's automation "${name}" on behalf of its owner.\n\nInstruction:\n${body}\n\nDelivery contract: send_message to the destination named "automation-${automationId}".`;

runContractTests({
  name: 'nanoclaw(fake host)',
  createRuntime: () => makeRuntime(),
  features: { ask: { trigger: '[ask] change my config' } },
  timeoutMs: 8_000,
});

test('the overlay on the vendored host is complete', () => {
  assert.deepEqual(check(), []);
});

test('the host is spawned with a named environment and no provider key', async () => {
  const rt = makeRuntime();
  await rt.start();
  try {
    const rec = recorder(rt);
    const session = await rt.createSession({ name: 'main' });
    assert.equal(session.id, 'main', 'a well-formed name is the thread id, so a session survives a restart');
    const runId = newId('run');
    await rt.sendMessage({ sessionId: session.id, runId, text: 'hello' });
    const msg = await rec.waitFor((e) => e.type === 'agent.message' && e.runId === runId, 5000);
    assert.equal(msg.message.text, '(fake) you said: hello');
    await rec.waitFor((e) => e.type === 'run.completed' && e.runId === runId, 5000);
    const working = rec.events.filter((e) => e.type === 'agent.working' && e.runId === runId).map((e) => e.on);
    assert.deepEqual(working, [true, false], 'typing on from the host, off at the turn');
  } finally {
    await rt.stop();
  }
  assert.equal((await rt.getStatus()).state, 'stopped');
});

test('an approval card from the host becomes a permission request, answered as the owner', async () => {
  const rt = makeRuntime();
  await rt.start();
  try {
    const rec = recorder(rt);
    const session = await rt.createSession({ name: 'main' });
    const runId = newId('run');
    await rt.sendMessage({ sessionId: session.id, runId, text: '[ask] install a package' });
    const req = await rec.waitFor((e) => e.type === 'permission.request', 5000);
    assert.equal(req.request.action, 'CLI: groups-config-update');
    assert.deepEqual(req.request.options, ['approve', 'reject', 'reject_with_reason']);
    assert.equal(req.request.sessionId, 'main');
    await rt.resolvePermission(req.request.id, 'deny');
    const msg = await rec.waitFor((e) => e.type === 'agent.message' && e.runId === runId, 5000);
    assert.match(msg.message.text, /declined/);
  } finally {
    await rt.stop();
  }
});

test('a schedule is a task plus a delivery surface; run-now reports back with the automation id', async () => {
  const rt = makeRuntime();
  await rt.start();
  try {
    const rec = recorder(rt);
    const automationId = newId('atm');
    const s = await rt.createSchedule({ automationId, name: 'morning news', cron: '0 9 * * *', timezone: 'UTC', instruction: 'You are running FREN\'s automation "morning news".\n\nInstruction:\nCheck the news.\n\nDelivery contract: send_message to the destination named "automation-' + automationId + '".', deliveryName: `automation-${automationId}` });
    assert.equal(s.enabled, true);
    assert.equal(s.cron, '0 9 * * *');
    assert.ok(s.nextRunAt > Date.now());
    const run = await rt.triggerSchedule(s.id);
    assert.equal(run.kind, 'schedule');
    const msg = await rec.waitFor((e) => e.type === 'agent.message' && e.automationId === automationId, 5000);
    assert.equal(msg.runId, run.id, 'the message is tied to the run that was triggered');
    assert.match(msg.message.text, /morning news ran/);
    await rec.waitFor((e) => e.type === 'schedule.completed' && e.runId === run.id, 5000);
    const listed = (await rt.listSchedules()).find((x) => x.id === s.id);
    assert.equal(listed.runs, 1);
    const paused = await rt.updateSchedule(s.id, { enabled: false });
    assert.equal(paused.enabled, false);
    await rt.deleteSchedule(s.id);
    assert.equal((await rt.listSchedules()).length, 0);
  } finally {
    await rt.stop();
  }
});

test('without a container runtime, start explains what to install', async () => {
  const rt = makeRuntime({
    skipContainerProbe: false,
    probe: { detect: async () => ({ kind: 'docker', installed: false, running: false, reason: 'no container runtime is installed', hint: 'Install Docker Desktop' }), imagePresent: async () => false, stopLabeled: async () => 0 },
  });
  await assert.rejects(() => rt.start(), (err) => err.name === 'RuntimeUnavailable' && /Docker Desktop/.test(err.hint));
  assert.equal((await rt.getStatus()).state, 'unavailable');
  assert.equal((await rt.getStatus()).hint, 'Install Docker Desktop');
});

test('a fire on the host\'s own clock becomes a run FREN watches to its end; misses and pauses are read off the counters', async () => {
  const rt = makeRuntime({ scheduleWatchMs: 100 });
  await rt.start();
  try {
    const rec = recorder(rt);
    const automationId = newId('atm');
    const s = await rt.createSchedule({ automationId, name: 'morning news', cron: '0 9 * * *', timezone: 'UTC', instruction: compiled(automationId, 'morning news', 'Check the news.'), deliveryName: `automation-${automationId}` });
    const host = hostControl(rt);

    // Caught due: the row id is the run id, the delivery lands on it, the acknowledgement ends it.
    await host.call('fake-fire', { id: s.id, outcome: 'ok' });
    const fired = await rec.waitFor((e) => e.type === 'schedule.fired' && e.scheduleId === s.id, 5000, 'fired');
    const msg = await rec.waitFor((e) => e.type === 'agent.message' && e.automationId === automationId, 5000, 'message');
    assert.equal(msg.runId, fired.runId, 'what the agent sent landed on the run the fire opened');
    const done = await rec.waitFor((e) => e.type === 'schedule.completed' && e.scheduleId === s.id, 5000, 'completed');
    assert.equal(done.runId, fired.runId);
    assert.equal(done.detail, undefined);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(rec.events.filter((e) => e.type === 'schedule.fired' && e.scheduleId === s.id).length, 1, 'the counters catching up is not a second fire');
    assert.equal((await rt.listSchedules()).find((x) => x.id === s.id).runs, 1);

    // Caught due and failed: the run log says why.
    await host.call('fake-fire', { id: s.id, outcome: 'fail' });
    const failed = await rec.waitFor((e) => e.type === 'schedule.failed' && e.scheduleId === s.id, 5000, 'failed');
    assert.equal(failed.detail, 'the run failed in the secure execution environment', 'the host records a failure without a reason; fren does not invent one');
    assert.match(fired.runId, /^run_/, 'fren\'s run ids are its own; the host row is watched under its id');
    assert.equal(rec.events.filter((e) => e.type === 'schedule.fired' && e.scheduleId === s.id).length, 2);
    // The host's counters catch up a sweep later; let them, as they would.
    await eventually(async () => (await rt.listSchedules()).find((x) => x.id === s.id).failedRuns === 1);
    await new Promise((r) => setTimeout(r, 250));

    // Came and went unseen: a run opened and closed from the counters alone.
    await host.call('fake-fire', { id: s.id, outcome: 'silent' });
    const missed = await rec.waitFor((e) => e.type === 'schedule.completed' && e.scheduleId === s.id && e.runId !== done.runId, 5000, 'missed');
    assert.equal(missed.detail, 'it ran, but sent nothing');
    assert.match(missed.runId, /^run_/);
    assert.ok(rec.events.some((e) => e.type === 'run.completed' && e.runId === missed.runId), 'a real run, for the record');
    await eventually(async () => (await rt.listSchedules()).find((x) => x.id === s.id).runs === 2);

    // The host gave up on it.
    await host.call('fake-fire', { id: s.id, outcome: 'pause' });
    const paused = await rec.waitFor((e) => e.type === 'schedule.paused' && e.scheduleId === s.id, 5000, 'paused');
    assert.equal(paused.automationId, automationId);
    assert.equal(paused.detail, 'it failed 8 times in a row');
    const listed = (await rt.listSchedules()).find((x) => x.id === s.id);
    assert.equal(listed.enabled, false);
    assert.equal(listed.pausedByRuntime, 'it failed 8 times in a row');
    assert.equal(listed.failedRuns, 2);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(rec.events.filter((e) => e.type === 'schedule.paused').length, 1, 'said once');

    // Resumed from FREN: the note no longer counts.
    const back = await rt.updateSchedule(s.id, { enabled: true });
    assert.equal(back.enabled, true);
    assert.equal(back.pausedByRuntime, undefined);
    rec.unsubscribe();
  } finally {
    await rt.stop();
  }
});

test('schedules outlive Core: a fresh adapter finds them on the host with their automation ids and whole instructions', async () => {
  const first = makeRuntime();
  await first.start();
  const automationId = newId('atm');
  const instruction = compiled(automationId, 'the long one', 'Look at every feed there is and think hard about which stories matter today. '.repeat(3).trim());
  assert.ok(instruction.length > 120, 'longer than the list shows');
  const s = await first.createSchedule({ automationId, name: 'the long one', cron: '0 9 * * *', timezone: 'UTC', instruction, deliveryName: `automation-${automationId}` });
  await first.stop();

  const second = makeRuntime({ base: first.testDirs.base });
  await second.start();
  try {
    const listed = await second.listSchedules();
    assert.equal(listed.length, 1, 'found, not duplicated');
    assert.equal(listed[0].id, s.id);
    assert.equal(listed[0].automationId, automationId);
    assert.equal(listed[0].name, 'the long one');
    assert.equal(listed[0].instruction, instruction, 'the whole instruction, not the list\'s shortened one');
    await second.deleteSchedule(s.id);
    assert.equal((await second.listSchedules()).length, 0);
  } finally {
    await second.stop();
  }
});

test('a fire whose acknowledgement never comes ends on the counters, once; a row the host retries is one attempt per time', async () => {
  const rt = makeRuntime({ scheduleWatchMs: 100 });
  await rt.start();
  try {
    const rec = recorder(rt);
    const automationId = newId('atm');
    const s = await rt.createSchedule({ automationId, name: 'quiet one', cron: '0 9 * * *', timezone: 'UTC', instruction: compiled(automationId, 'quiet one', 'Check the news.'), deliveryName: `automation-${automationId}` });
    const host = hostControl(rt);
    const firedFor = (n) => rec.events.filter((e) => e.type === 'schedule.fired' && e.scheduleId === s.id).length === n;

    // No acknowledgement, only the message and the counters: the run the fire opened ends on them.
    await host.call('fake-fire', { id: s.id, outcome: 'quiet' });
    const fired = await rec.waitFor((e) => e.type === 'schedule.fired' && e.scheduleId === s.id, 5000, 'fired');
    const msg = await rec.waitFor((e) => e.type === 'agent.message' && e.automationId === automationId, 5000, 'message');
    assert.equal(msg.runId, fired.runId);
    const done = await rec.waitFor((e) => e.type === 'schedule.completed' && e.scheduleId === s.id, 5000, 'completed on the counters');
    assert.equal(done.runId, fired.runId);
    // The next fire nobody saw is still reported: the counter-explained end left nothing behind to absorb it.
    await host.call('fake-fire', { id: s.id, outcome: 'silent' });
    const missed = await rec.waitFor((e) => e.type === 'schedule.completed' && e.scheduleId === s.id && e.runId !== done.runId, 5000, 'missed');
    assert.equal(missed.detail, 'it ran, but sent nothing');
    assert.ok(firedFor(2));

    // The host gives the fired row a later time, then runs it: one run, kept open across the wait.
    await host.call('fake-fire', { id: s.id, outcome: 'retry' });
    const again = await rec.waitFor((e) => e.type === 'schedule.fired' && e.scheduleId === s.id && e.runId !== fired.runId && e.runId !== missed.runId, 5000, 'fired again');
    const late = await rec.waitFor((e) => e.type === 'agent.message' && e.automationId === automationId && e.runId !== msg.runId, 5000, 'late message');
    assert.equal(late.runId, again.runId, 'the message after the retry lands on the run that waited');
    await rec.waitFor((e) => e.type === 'schedule.completed' && e.runId === again.runId, 5000, 'completed after the retry');
    assert.ok(firedFor(3), 'a rescheduled row is not a second fire while its run is open');
    await eventually(async () => (await rt.listSchedules()).find((x) => x.id === s.id).runs === 3);
    await new Promise((r) => setTimeout(r, 250));

    // FREN gives up on a fired run (a cancel); the host retries the row: a new attempt, a new run.
    await host.call('fake-fire', { id: s.id, outcome: 'retry' });
    const fourth = await rec.waitFor((e) => e.type === 'schedule.fired' && e.scheduleId === s.id && ![fired.runId, missed.runId, again.runId].includes(e.runId), 5000, 'fired a fourth time');
    await rt.cancelRun(fourth.runId);
    await rec.waitFor((e) => e.type === 'run.cancelled' && e.runId === fourth.runId, 2000, 'cancelled');
    const fifth = await rec.waitFor((e) => e.type === 'schedule.fired' && e.scheduleId === s.id && ![fired.runId, missed.runId, again.runId, fourth.runId].includes(e.runId), 5000, 'fired for the retry');
    const after = await rec.waitFor((e) => e.type === 'agent.message' && e.automationId === automationId && ![msg.runId, late.runId].includes(e.runId), 5000, 'message after the cancel');
    assert.equal(after.runId, fifth.runId);
    await rec.waitFor((e) => e.type === 'schedule.completed' && e.runId === fifth.runId, 5000, 'completed');
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(firedFor(5), 'no phantom fire after the counters caught up');
    rec.unsubscribe();
  } finally {
    await rt.stop();
  }
});
