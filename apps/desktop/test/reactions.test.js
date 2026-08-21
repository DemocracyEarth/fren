'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createReactions, POOLS } = require('../renderer/face/reactions.js');

/** Deterministic RNG so the behaviour is assertable. */
const seeded = (seed) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

test('the same trigger does not always give the same face', () => {
  const r = createReactions({ random: seeded(7) });
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(r.pick('hover', i * 9000).emotion);
  assert.ok(seen.size >= 4, `expected variety, got ${[...seen].join(',')}`);
});

test('never repeats the previous face back to back', () => {
  const r = createReactions({ random: seeded(3) });
  let prev = null;
  for (let i = 0; i < 200; i++) {
    const { emotion } = r.pick(i % 2 ? 'hover' : 'click', i * 9000);
    assert.notEqual(emotion, prev, 'reaction repeated immediately');
    prev = emotion;
  }
});

test('only ever returns emotions that exist in the pools', () => {
  const r = createReactions({ random: seeded(11) });
  const known = new Set(
    Object.values(POOLS).flatMap((byMood) => Object.values(byMood).flat().map(([n]) => n))
  );
  for (const trigger of ['hover', 'click', 'reply', 'idle']) {
    for (let i = 0; i < 50; i++) {
      assert.ok(known.has(r.pick(trigger, i * 900).emotion));
    }
  }
});

test('poking it repeatedly winds it up; being ignored calms it down', () => {
  const r = createReactions({ random: seeded(5), energy: 0.4 });
  for (let i = 0; i < 6; i++) r.pick('hover', 1000 + i * 500);   // rapid pokes
  assert.ok(r.energy() > 0.6, `energy should climb, got ${r.energy()}`);
  r.decay(60_000);
  assert.ok(r.energy() < 0.6, `energy should bleed off, got ${r.energy()}`);
});

test('mood tracks energy across its three bands', () => {
  assert.equal(createReactions({ energy: 0.9 }).mood(), 'bright');
  assert.equal(createReactions({ energy: 0.5 }).mood(), 'neutral');
  assert.equal(createReactions({ energy: 0.1 }).mood(), 'low');
});

test('a low mood favours quiet faces and a bright one favours lively ones', () => {
  const count = (energy, trigger) => {
    const r = createReactions({ random: seeded(23), energy });
    const tally = {};
    for (let i = 0; i < 120; i++) {
      const e = r.pick(trigger, i * 60_000).emotion;   // spaced out: no streak
      tally[e] = (tally[e] || 0) + 1;
      r.decay(0);
    }
    return tally;
  };
  const low = count(0.05, 'idle');
  const bright = count(0.95, 'idle');
  const quiet = (t) => (t.calm || 0) + (t.tired || 0) + (t.resting || 0) + (t.peaceful || 0);
  assert.ok(quiet(low) > quiet(bright), 'low mood should skew quiet');
});

test('events move the mood in the direction you would expect', () => {
  const r = createReactions({ energy: 0.5 });
  r.note('error');
  const afterError = r.energy();
  assert.ok(afterError < 0.5);
  r.note('idea');
  assert.ok(r.energy() > afterError);
});

test('decay never drives energy below zero', () => {
  const r = createReactions({ energy: 0.2 });
  r.decay(10_000_000);
  assert.equal(r.energy(), 0);
});
