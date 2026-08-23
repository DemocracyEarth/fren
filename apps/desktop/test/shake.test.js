'use strict';
/**
 * Shake detection.
 *
 * Almost every test here is about what must NOT fire. Detection is easy; the
 * feature lives or dies on whether moving the orb across the desk, or a hand
 * that is not perfectly steady, sets it wobbling — because a companion that
 * convulses when you reposition it is worse than one that never wobbles.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createShakeDetector } = require('../renderer/face/shake.js');

/** Play a path through the detector, one sample per step. */
function play(points, { stepMs = 8 } = {}) {
  const d = createShakeDetector();
  const fires = [];
  let t = 0;
  for (const [x, y] of points) {
    const r = d.feed(x, y, t);
    if (r) fires.push({ at: t, ...r });
    t += stepMs;
  }
  return fires;
}

/** A horizontal shake: `swings` legs of `amp` px, sampled every `step` px. */
function shakePath(swings, amp = 60, step = 12) {
  const pts = [[0, 0]];
  let x = 0;
  for (let s = 0; s < swings; s++) {
    const dir = s % 2 ? -1 : 1;
    for (let travelled = 0; travelled < amp; travelled += step) {
      x += dir * step;
      pts.push([x, 0]);
    }
  }
  return pts;
}

test('an aggressive shake fires', () => {
  assert.ok(play(shakePath(8)).length > 0, 'a real shake must be detected');
});

test('it takes three reversals, not one', () => {
  // One there-and-back is someone changing their mind about where to put it.
  assert.equal(play(shakePath(2)).length, 0, 'one reversal is not a shake');
  assert.equal(play(shakePath(3)).length, 0, 'two reversals is not a shake');
  assert.ok(play(shakePath(5)).length > 0, 'four reversals is');
});

test('carrying it across the screen never fires', () => {
  // The single most important rejection: this is what people do all the time.
  const straight = [];
  for (let x = 0; x <= 1400; x += 14) straight.push([x, 300]);
  assert.equal(play(straight).length, 0, 'a long fast drag is not a shake');
});

test('a curved drag never fires', () => {
  // Sweeping the orb round in an arc reverses the overall direction, but does
  // it gradually — and the reference direction turns with it.
  const arc = [];
  for (let i = 0; i <= 200; i++) {
    const a = (i / 200) * Math.PI;
    arc.push([Math.cos(a) * 400, Math.sin(a) * 400]);
  }
  assert.equal(play(arc).length, 0, 'an arc is not a shake');
});

test('a full circle never fires', () => {
  const circle = [];
  for (let i = 0; i <= 400; i++) {
    const a = (i / 400) * Math.PI * 2;
    circle.push([Math.cos(a) * 300, Math.sin(a) * 300]);
  }
  assert.equal(play(circle).length, 0, 'a circle is not a shake');
});

test('a tremor never fires', () => {
  // Reverses constantly but travels nowhere. This one actually fired while the
  // swing was measured as path length: enough tiny oscillations summed past the
  // threshold. It is measured as displacement from the last reversal now.
  const jitter = [];
  for (let i = 0; i < 400; i++) jitter.push([(i % 2) * 5, 0]);
  assert.equal(play(jitter).length, 0, 'small fast jitter is not a shake');
});

test('a slow there-and-back never fires', () => {
  // Wide swings, but far apart in time — someone lining the orb up, not
  // shaking it.
  assert.equal(play(shakePath(8), { stepMs: 90 }).length, 0,
    'reversals outside the window do not accumulate');
});

test('shaking harder hits harder', () => {
  const gentle = play(shakePath(5));
  const hard = play(shakePath(14));
  assert.ok(gentle.length > 0 && hard.length > 0);
  assert.ok(Math.max(...hard.map((f) => f.power)) > Math.max(...gentle.map((f) => f.power)),
    'more reversals in the window must mean more power');
  assert.ok(Math.max(...hard.map((f) => f.power)) <= 1, 'power stays in range');
  assert.ok(Math.min(...gentle.map((f) => f.power)) >= 0.35, 'and never arrives as a twitch');
});

test('a sustained shake tops up repeatedly rather than firing once', () => {
  // The energy has to keep being fed or a long shake dies out mid-gesture.
  const fires = play(shakePath(30), { stepMs: 12 });
  assert.ok(fires.length > 3, `expected repeated top-ups, got ${fires.length}`);
});

test('the rate limit holds', () => {
  const fires = play(shakePath(40), { stepMs: 4 });
  for (let i = 1; i < fires.length; i++) {
    assert.ok(fires[i].at - fires[i - 1].at >= 90,
      `top-ups ${fires[i - 1].at}ms and ${fires[i].at}ms apart`);
  }
});

test('letting go and grabbing again does not bypass the rate limit', () => {
  const d = createShakeDetector();
  let t = 0;
  const feed = (pts) => {
    const out = [];
    for (const [x, y] of pts) { const r = d.feed(x, y, t); if (r) out.push(t); t += 8; }
    return out;
  };
  const first = feed(shakePath(8));
  assert.ok(first.length > 0);
  d.reset();
  const all = [...first, ...feed(shakePath(8))];
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i] - all[i - 1] >= 90, 'the limit survives a reset');
  }
});

test('reset forgets the gesture but not the clock', () => {
  const d = createShakeDetector();
  let t = 0;
  for (const [x, y] of shakePath(3)) { d.feed(x, y, t); t += 8; }
  d.reset();
  // Two more reversals would have been enough had the earlier ones counted.
  let fired = 0;
  for (const [x, y] of shakePath(3)) { if (d.feed(x, y, t)) fired++; t += 8; }
  assert.equal(fired, 0, 'reversals from before the reset must not carry over');
});
