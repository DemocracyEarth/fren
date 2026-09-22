'use strict';
/**
 * The listening breath: while fren listens in a spoken conversation its
 * colour swings from the orb's own orange out to a lime green and back, and
 * the owner's voice pushes it further out. 0 is the orb's own colour, 1 the
 * lime.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../renderer/face/attend.js');

test('a turn opens at the orb\'s own colour, reaches the lime half a breath in, and comes back', async () => {
  const { attendDepth, BREATH_S } = await load();
  assert.equal(attendDepth(0, 0), 0);
  assert.ok(Math.abs(attendDepth(BREATH_S / 2, 0) - 0.85) < 1e-9, 'the breath alone goes most of the way: it has to be felt');
  assert.ok(attendDepth(BREATH_S, 0) < 1e-9);
  assert.ok(Math.abs(attendDepth(BREATH_S * 3.5, 0) - 0.85) < 1e-9, 'and keeps going, breath after breath');
});

test('it is a slow breath — the pace of listening, not of loading', async () => {
  const { BREATH_S } = await load();
  assert.ok(BREATH_S >= 2.5 && BREATH_S <= 4.5, `${BREATH_S}s`);
});

test('it moves smoothly: out all the way through the first half, back all the way through the second', async () => {
  const { attendDepth, BREATH_S } = await load();
  let last = -1;
  for (let t = 0; t <= BREATH_S / 2; t += 0.05) { const d = attendDepth(t, 0); assert.ok(d >= last - 1e-12); last = d; }
  last = attendDepth(BREATH_S / 2, 0);        // the peak itself: the loop above stops a float short of it
  for (let t = BREATH_S / 2; t <= BREATH_S; t += 0.05) { const d = attendDepth(t, 0); assert.ok(d <= last + 1e-12); last = d; }
  // No frame-to-frame jump anyone could see as a flicker (60 fps).
  for (let t = 0; t < BREATH_S; t += 1 / 60) assert.ok(Math.abs(attendDepth(t + 1 / 60, 0) - attendDepth(t, 0)) < 0.02);
});

test('your voice pushes it further out, and it never leaves the span between the two', async () => {
  const { attendDepth, BREATH_S } = await load();
  assert.equal(attendDepth(0, 1), 0.15);
  assert.equal(attendDepth(BREATH_S / 2, 1), 1);
  for (let t = 0; t < 10; t += 0.13) for (const level of [-3, 0, 0.3, 1, 7, NaN]) {
    const d = attendDepth(t, level);
    assert.ok(d >= 0 && d <= 1, `depth ${d} at t=${t} level=${level}`);
  }
  assert.ok(attendDepth(1, 0.8) > attendDepth(1, 0.1));
});

test('reduced motion: no breath — held at the breath\'s own far end, the lime, still answering the voice', async () => {
  const { attendDepth } = await load();
  assert.equal(attendDepth(0, 0, true), attendDepth(1.3, 0, true));
  // Not a midway: 0.425 of the way from orange lands on mustard and never
  // reaches anything green. The far end is the point of the state.
  assert.equal(attendDepth(0, 0, true), 0.85);
  assert.ok(attendDepth(0, 1, true) > attendDepth(0, 0, true));
});

test('nonsense times are the start of a breath, not a broken colour', async () => {
  const { attendDepth } = await load();
  for (const t of [NaN, -5, undefined, Infinity]) assert.equal(attendDepth(t, 0), 0);
});

test('the orb breathes through it, from its own colour; a new turn starts a new breath only once the last one has faded', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'face', 'orb.js'), 'utf8');
  assert.match(src, /import \{ attendDepth \} from '\.\/attend\.js'/);
  assert.match(src, /attendDepth\(\s*this\.attendFor\b[\s\S]{0,120}?this\.reduced\s*\)/);
  // The near end is the colour the orb already wears, the far end the palette's lime.
  assert.match(src, /_attend\.copy\(this\.material\.color\)\.lerp\(_attendDeep\.setHex\(lime\.color\), depth\)/);
  // Restarting mid-fade snaps dark to light in one frame (a short "mm-hm" from the agent).
  assert.match(src, /attendLevel === null[^;\n]*attendMix < 0\.05[^;\n]*\)\s*\{?\s*this\.attendFor = 0/);
  // Only the colour moves: nothing under the voice attribute fades, scales or glows.
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /voice-breathe/);
  for (const rule of css.match(/\[data-voice="1"\][^{]*\{[^}]*\}/g) || []) {
    assert.doesNotMatch(rule, /opacity|transform|filter|animation/, `the conversation line must not style the orb: ${rule.slice(0, 60)}`);
  }
});

test('the SVG fallback breathes the same breath (it cannot import the module, so its copy is pinned)', async () => {
  const { BREATH_S } = await load();
  const face = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'face', 'face.js'), 'utf8');
  const breath = face.split('\n').find((l) => l.includes('const attendBreath ='));
  const deep = face.split('\n').find((l) => l.includes('const attendDeep ='));
  assert.ok(breath && deep, 'the fallback has its breath');
  assert.ok(breath.includes(`/ ${BREATH_S})`), 'same period');
  assert.ok(breath.includes('this.reduced ? 1'), 'reduced motion holds the far end');
  assert.ok(deep.includes('* 0.85') && deep.includes('* 0.15') && deep.includes('* 1.4'), 'same reach, same voice');
  // And it darkens as it turns, so it reads lighter-to-darker, not only as a change of hue.
  assert.match(face, /const l = clamp\(BASE\.l \+ p\.tone - attendDim/);
  // No local recording over a live line: record red under the breath would swing red to lime.
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(app, /async function startTalking\(\) \{[\s\S]{0,400}?if \(voiceActive\(\)\) \{ vlog\([^)]*\); return; \}/);
  // And softens as it turns, or a full-saturation lime is neon — the look the owner turned down.
  assert.match(face, /const s = clamp\(BASE\.s \* p\.sat \* \(1 - 0\.45 \* this\.attendHue \/ 60\)/);
});
