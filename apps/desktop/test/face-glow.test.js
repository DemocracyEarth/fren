'use strict';
/**
 * The glow around the eyes and mouth is the body's own colour. It used to be
 * five fixed ambers, tuned against the orange body — and stayed amber when the
 * body went green to listen, red to record, or wore another colour: an orange
 * halo on a green face.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../renderer/face/face-texture.js');
const rgb = (css) => [1, 3, 5].map((i) => parseInt(css.slice(i, i + 2), 16));
function hue(css) {
  const [r, g, b] = rgb(css).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return null;
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? ((b - r) / d + 2) : ((r - g) / d + 4);
  return h * 60;
}
const sat = (css) => { const [r, g, b] = rgb(css).map((v) => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; return mx === mn ? 0 : (l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn)) * 100; };
const near = (a, b, within) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) <= within;

test('the shipped orange still gives off the hand-tuned ambers', async () => {
  const { glowFrom } = await load();
  const tuned = ['#ff7a00', '#ff8a00', '#ffb14a', '#ffd08a', '#ffe9c4'];
  const got = glowFrom(0xffa200);
  assert.equal(got.length, 5);
  got.forEach((c, i) => {
    assert.match(c, /^#[0-9a-f]{6}$/);
    const off = rgb(c).reduce((sum, v, k) => sum + Math.abs(v - rgb(tuned[i])[k]), 0);
    assert.ok(off <= 3, `layer ${i}: ${c} drifted from ${tuned[i]}`);
  });
});

test('a green body gives off green light, a red one red, a teal one teal — never amber', async () => {
  const { glowFrom } = await load();
  for (const [name, body, bodyHue] of [['lime', 0x7fbe37, 88], ['a leaf green', 0x35883b, 124], ['recording', 0xd93425, 5], ['lagoon', 0x11a8a8, 180], ['sad', 0x758ec7, 222]]) {
    const layers = glowFrom(body);
    for (const c of layers.slice(0, 3)) {                // the coloured layers; the bloom is nearly white
      assert.ok(near(hue(c), bodyHue, 6), `${name}: ${c} is at ${hue(c).toFixed(0)}deg, the body at ${bodyHue}`);
      assert.ok(!near(hue(c), 32, 12) || near(bodyHue, 32, 26), `${name}: ${c} is still amber`);
    }
  }
});

test('the light is as saturated as the body allows: vivid from a vivid body, drained from a drained one', async () => {
  const { glowFrom } = await load();
  assert.ok(sat(glowFrom(0xffa200)[0]) > 95);
  const soft = sat(glowFrom(0x649e3d)[0]);               // the calm listening green (s about 44%)
  assert.ok(soft > 45 && soft < 70, `soft body gave ${soft.toFixed(0)}%`);
  assert.ok(sat(glowFrom(0x6d6d73)[0]) < 12, 'an asleep, grey orb gives off grey light');
});

test('the warm drift belongs to orange: a green body\'s light never leans toward yellow-green', async () => {
  const { glowFrom } = await load();
  // Orange keeps its tuned, redder spill…
  assert.ok(hue(glowFrom(0xffa200)[0]) < 31);
  // …while the listening greens give off their own hue, not a limier one.
  for (const [body, bodyHue] of [[0x649e3d, 96], [0x35883b, 124]]) {
    for (const c of glowFrom(body).slice(0, 4)) assert.ok(hue(c) >= bodyHue - 3, `${c} leans lime (${hue(c).toFixed(0)}deg)`);
  }
});

test('it goes from the colour itself out to nearly white, as light does', async () => {
  const { glowFrom } = await load();
  const light = (css) => { const [r, g, b] = rgb(css); return (Math.max(r, g, b) + Math.min(r, g, b)) / 510; };
  const layers = glowFrom(0x35883b).map(light);
  for (let i = 1; i < layers.length; i++) assert.ok(layers[i] >= layers[i - 1] - 0.001, 'each layer at least as light as the one outside it');
  assert.ok(layers[4] > 0.85);
});

test('nonsense in, a usable light out', async () => {
  const { glowFrom } = await load();
  for (const junk of [null, undefined, NaN, 'green', -1]) {
    const layers = glowFrom(junk);
    assert.equal(layers.length, 5);
    for (const c of layers) assert.match(c, /^#[0-9a-f]{6}$/);
  }
});

test('the orb paints the face in the colour the body is wearing this frame', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'face', 'orb.js'), 'utf8');
  assert.match(src, /this\.p\.glow = glowFrom\(bodyHex\)/);
  // After the body's colour is final for the frame (mood, listening, recording), not before.
  const paintAt = src.indexOf('this.p.glow = glowFrom(bodyHex)');
  for (const earlier of ['this.material.color.copy(DRAINED)', '_recLow.setHex(REC.low)', 'this.material.color.lerp(_attend']) {
    assert.ok(src.indexOf(earlier) > -1 && src.indexOf(earlier) < paintAt, `${earlier} must come before the glow is taken`);
  }
});
