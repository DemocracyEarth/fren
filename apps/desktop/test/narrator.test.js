'use strict';
/**
 * The thinking-out-loud clockwork: fren has a thought when the place changes,
 * not more often than the floor, and never while the light is off. Everything
 * is injected, so it runs on a fake clock against a fake gateway — `fire()`
 * settles a pending thought without waiting on the real timer.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createNarrator } = require('../main/narrator.js');

function harness({ observing = true, thought = 'a quiet thought', options = {} } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const thoughts = [];
  const calls = [];
  const narrator = createNarrator({
    gateway: { narrate: async (p) => { calls.push(p); return { thought }; } },
    state: { get: () => ({ observing }) },
    getBrowser: () => null,
    soulFor: () => '',
    onThought: (t) => thoughts.push(t),
    log: () => {},
    now: () => clock.t,
    // A settle so long it never fires on its own; the tests drive fire() directly.
    options: { settleMs: 1e9, minIntervalMs: 40_000, ...options },
  });
  return { narrator, thoughts, calls, clock };
}

test('a genuine change gets one thought', async () => {
  const { narrator, thoughts, calls } = harness();
  narrator.note({ kind: 'app', app: 'Code', title: 'narrator.js' });
  await narrator.fire();
  assert.equal(thoughts.length, 1);
  assert.equal(thoughts[0].text, 'a quiet thought');
  assert.equal(thoughts[0].kind, 'app');
  assert.equal(calls.length, 1);
  assert.match(calls[0].activity, /Code/);
});

test('the same place gets no second thought', async () => {
  const { narrator, thoughts } = harness();
  narrator.note({ kind: 'app', app: 'Code' }); await narrator.fire();
  narrator.note({ kind: 'app', app: 'Code' }); await narrator.fire();
  assert.equal(thoughts.length, 1);
});

test('a new place, a new thought', async () => {
  const { narrator, thoughts } = harness({ options: { minIntervalMs: 0 } });
  narrator.note({ kind: 'app', app: 'Code' }); await narrator.fire();
  narrator.note({ kind: 'browser', domain: 'react.dev' }); await narrator.fire();
  assert.equal(thoughts.length, 2);
});

test('the floor defers a too-soon thought until enough time has passed', async () => {
  const { narrator, thoughts, clock } = harness({ options: { minIntervalMs: 60_000 } });
  narrator.note({ kind: 'app', app: 'Code' }); await narrator.fire();
  assert.equal(thoughts.length, 1);
  clock.t += 10_000;                                  // only 10s later
  narrator.note({ kind: 'browser', domain: 'react.dev' }); await narrator.fire();
  assert.equal(thoughts.length, 1, 'too soon — held back');
  clock.t += 60_000;                                  // now well past the floor
  await narrator.fire();                              // the held signal lands
  assert.equal(thoughts.length, 2);
});

test('no thoughts while the light is off', async () => {
  const { narrator, thoughts } = harness({ observing: false });
  narrator.note({ kind: 'app', app: 'Code' }); await narrator.fire();
  assert.equal(thoughts.length, 0);
});

test('an empty thought is dropped, not shown', async () => {
  const { narrator, thoughts } = harness({ thought: '   ' });
  narrator.note({ kind: 'app', app: 'Code' }); await narrator.fire();
  assert.equal(thoughts.length, 0);
});

test('recent thoughts are offered back so it does not repeat itself', async () => {
  const { narrator, calls } = harness({ options: { minIntervalMs: 0 } });
  narrator.note({ kind: 'app', app: 'Code' }); await narrator.fire();
  narrator.note({ kind: 'browser', domain: 'react.dev' }); await narrator.fire();
  assert.ok(calls[1].previous.includes('a quiet thought'));
});
