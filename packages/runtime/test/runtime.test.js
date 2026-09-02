'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRuntime, newId, isTerminal, isRuntimeEvent, RuntimeUnavailable, METHODS } = require('..');

test('ids are prefixed and unique', () => {
  const a = newId('run');
  const b = newId('run');
  assert.match(a, /^run_[0-9a-f]{16}$/);
  assert.notEqual(a, b);
});

test('terminal statuses are the four that end a run', () => {
  for (const s of ['completed', 'failed', 'cancelled', 'interrupted']) assert.equal(isTerminal(s), true);
  for (const s of ['queued', 'running']) assert.equal(isTerminal(s), false);
});

test('assertRuntime names every missing method', () => {
  assert.throws(() => assertRuntime({}), /missing kind, start, stop/);
  const partial = { kind: 'x' };
  for (const m of METHODS) partial[m] = () => {};
  partial.getCapabilities = () => ({});
  assert.throws(() => assertRuntime(partial), /capabilities missing tokenStreaming/);
});

test('event and error shapes', () => {
  assert.equal(isRuntimeEvent({ type: 'run.started', runId: 'x' }), true);
  assert.equal(isRuntimeEvent({ type: 'made.up' }), false);
  const err = new RuntimeUnavailable('no container runtime', 'Install Docker Desktop');
  assert.equal(err.name, 'RuntimeUnavailable');
  assert.equal(err.hint, 'Install Docker Desktop');
});
