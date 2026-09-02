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
const { check } = require('../../../scripts/nanoclaw-overlay-check');

const FAKE_HOST = path.join(__dirname, 'fake-host.js');

function makeRuntime(extra = {}) {
  // A short socket path: Unix sockets are limited to ~100 bytes.
  const base = fs.mkdtempSync(path.join('/tmp', 'frn-'));
  const runtimeDir = path.join(base, 'rt');
  fs.mkdirSync(runtimeDir, { recursive: true });
  return createNanoclawRuntime({
    dataDir: path.join(base, 'd'), runtimeDir, sandboxUrl: 'http://host.docker.internal:4527/anthropic', sandboxToken: 'fren-test-token',
    timezone: 'UTC', log: () => {}, skipContainerProbe: true, hostCommand: [process.execPath, [FAKE_HOST]], connectTimeoutMs: 10_000,
    ...extra,
  });
}

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
