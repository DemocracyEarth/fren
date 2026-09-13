'use strict';
/**
 * Runs: what the runtime reports about a run, turned into Core events.
 *
 * The first test guards a bug that hid for weeks: the `agent.working` case in
 * runs.onRuntimeEvent read `run.kind` from a `run` that only existed in the
 * neighbouring case blocks. The throw was caught by the runtime's listener
 * wrapper and logged — twice per chat run, on and off — and the event never
 * reached Core's log or the desktop. So the assertion here is not "no error":
 * it is that the events actually land, with the run's kind on them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCore } = require('..');
const { openCoreStore } = require('../store');
const { createMockRuntime } = require('../../runtime-mock');

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-runs-'));
  const store = openCoreStore(path.join(dir, 'core.db'));
  const runtime = createMockRuntime({ replyDelayMs: 2, ...opts.runtime });
  const core = createCore({ store, runtime, complete: null, log: () => {}, reprobeMs: 0 });
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

test('a chat run puts agent.working on and off onto the event log, with its kind', async () => {
  const { store, core } = setup();
  await core.start();
  await core.startRuntime();
  const run = await core.runs.start({ text: 'say pong', persona: 'terse' });
  await until(() => core.runs.get(run.id).status === 'completed');
  const working = store.eventsSince(0).filter((e) => e.type === 'agent.working' && e.runId === run.id);
  assert.ok(working.length >= 2, `expected on+off, got ${working.length}`);
  assert.equal(working[0].on, true);
  assert.equal(working[working.length - 1].on, false);
  for (const e of working) assert.equal(e.kind, 'chat');
  await core.stop();
});

test('agent.working for a run Core does not know still lands, kind unknown, without throwing', async () => {
  const { store, core } = setup();
  await core.start();
  const before = store.eventsSince(0).length;
  assert.equal(core.runs.onRuntimeEvent({ type: 'agent.working', runId: 'run_0000000000000000', on: true }), true);
  assert.equal(core.runs.onRuntimeEvent({ type: 'agent.working', on: false }), true);
  const added = store.eventsSince(0).slice(before).filter((e) => e.type === 'agent.working');
  assert.equal(added.length, 2);
  assert.equal(added[0].kind, null);
  assert.equal(added[0].runId, 'run_0000000000000000');
  assert.equal(added[1].runId, null);
  await core.stop();
});
