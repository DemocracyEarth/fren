'use strict';
/**
 * Keeping the gateway alive. "Already running" at launch is true of that
 * instant only: reopen fren quickly and the gateway that answers is the
 * previous life's, about to exit with its parent. Whenever a health check
 * fails the question has to be asked again — once at a time.
 */
const test = require('node:test');
const assert = require('node:assert');
const { ensureGateway, reviveGateway } = require('../main/gateway-process.js');

/** A gateway that answers, or not, on demand. */
function world({ up = false } = {}) {
  const w = { up, starts: 0, lines: [] };
  w.health = async () => { if (!w.up) throw new Error('fetch failed'); return { ok: true }; };
  w.start = () => { w.starts += 1; setTimeout(() => { w.up = true; }, 5); };
  w.log = (l) => w.lines.push(l);
  w.opts = () => ({ health: w.health, log: w.log, start: w.start, pollMs: 2, timeoutMs: 500 });
  return w;
}

test('a gateway that answers is left alone', async () => {
  const w = world({ up: true });
  assert.equal(await ensureGateway(w.opts()), 'existing');
  assert.equal(w.starts, 0);
});

test('no gateway: ours is started and waited for', async () => {
  const w = world();
  assert.equal(await ensureGateway(w.opts()), 'started');
  assert.equal(w.starts, 1);
  assert.ok(w.lines.includes('[gateway] up'));
});

test('one that never comes up is a timeout, in words', async () => {
  const w = world();
  w.start = () => { w.starts += 1; };          // starts, never answers
  assert.equal(await ensureGateway({ ...w.opts(), timeoutMs: 20 }), 'timeout');
  assert.ok(w.lines.includes('[gateway] did not come up in time'));
});

test('the previous life\'s gateway answers at launch, then dies: the next failed health check starts ours', async () => {
  const w = world({ up: true });
  assert.equal(await reviveGateway(w.opts()), 'existing');    // launch: someone answers
  w.up = false;                                                // it exits with its old parent
  assert.equal(await reviveGateway(w.opts()), 'started');     // a health check failed: ask again
  assert.equal(w.starts, 1);
});

test('reviving is one attempt at a time, however many health checks fail meanwhile', async () => {
  const w = world();
  const [a, b, c] = await Promise.all([reviveGateway(w.opts()), reviveGateway(w.opts()), reviveGateway(w.opts())]);
  assert.deepEqual([a, b, c], ['started', 'started', 'started']);
  assert.equal(w.starts, 1);
  // And it can be asked again afterwards.
  w.up = false;
  assert.equal(await reviveGateway(w.opts()), 'started');
  assert.equal(w.starts, 2);
});

test('a health check that throws oddly never rejects the revive', async () => {
  const lines = [];
  const how = await reviveGateway({ health: async () => { throw new Error('nope'); }, start: () => { throw new Error('no node'); }, log: (l) => lines.push(l), pollMs: 2, timeoutMs: 10 });
  assert.equal(how, 'error');
  assert.ok(lines.some((l) => /\[gateway\] ensure: no node/.test(l)));
});
