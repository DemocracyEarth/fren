'use strict';
/**
 * The orb's colour.
 *
 * Two things are being protected here. The tone palette encodes RELATIONSHIPS
 * between moods, not four independent colours, so re-hueing has to move them
 * together. And the awake/asleep distinction is fren's central promise — asleep
 * is signalled by draining the colour away, so a colour choice must never be
 * able to make an awake orb look drained.
 */
const test = require('node:test');
const assert = require('node:assert');
const P = require('../renderer/face/palette.js');

const hx = (n) => '#' + n.toString(16).padStart(6, '0');

test('the default colour reproduces the original palette exactly', () => {
  // Not approximately. Someone who never touches this setting must get the
  // palette that was tuned by hand, byte for byte.
  const t = P.tonesFrom(P.DEFAULT_HEX);
  assert.equal(hx(t.base.color), '#ff8a00');
  assert.equal(hx(t.warm.color), '#ffa51f');
  assert.equal(hx(t.excited.color), '#ffb92e');
  assert.equal(hx(t.hearing.color), '#ffc85a');
  assert.equal(hx(P.sheenColorFrom(P.DEFAULT_HEX)), '#ffc06a');
});

test('the mood relationships survive a change of colour', () => {
  // warm is brighter than base, excited brighter than warm, hearing brightest.
  // If a new hue flattened that ordering the moods would stop being tellable
  // apart, which is the whole reason the palette exists.
  for (const preset of P.PRESETS) {
    const t = P.tonesFrom(preset.hex);
    const l = (c) => P.toHsl(c).l;
    assert.ok(l(t.warm.color) > l(t.base.color), `${preset.name}: warm brighter than base`);
    assert.ok(l(t.excited.color) > l(t.warm.color), `${preset.name}: excited brighter than warm`);
    assert.ok(l(t.hearing.color) > l(t.excited.color), `${preset.name}: hearing brightest`);
  }
});

test('surface qualities belong to the mood, not the hue', () => {
  // excited is glossier than base whatever colour fren is.
  for (const preset of P.PRESETS) {
    const t = P.tonesFrom(preset.hex);
    assert.equal(t.base.rough, 0.34);
    assert.equal(t.excited.rough, 0.20);
    assert.ok(t.hearing.sheen > t.base.sheen);
  }
});

test('sad, cross and asleep never change colour', () => {
  // They are meanings. A cheerful green "sad" face is simply wrong, and an
  // asleep orb has to look drained whatever the awake one looks like.
  const original = P.tonesFrom(P.DEFAULT_HEX);
  for (const preset of P.PRESETS) {
    const t = P.tonesFrom(preset.hex);
    for (const semantic of ['blue', 'red', 'grey']) {
      assert.equal(t[semantic].color, original[semantic].color,
        `${preset.name} must not move ${semantic}`);
    }
  }
});

test('a colour too washed out to be told from asleep is refused', () => {
  // THE ONE THAT MATTERS. Asleep is signalled by draining the colour out. Let
  // someone pick a near-grey orb and awake becomes indistinguishable from
  // asleep — the privacy signal would be gone, chosen away in a settings pane.
  for (const drab of [0x808080, 0x777c80, 0xa0a0a0, 0x4a4a4a]) {
    const got = P.toHsl(P.usable(drab));
    assert.ok(got.s >= P.LIMITS.MIN_SAT - 0.5,
      `${hx(drab)} came back at only ${got.s.toFixed(0)}% saturation`);
  }
});

test('a colour too dark or too pale for the face is pulled back', () => {
  // The face is an emissive map drawn OVER the body. Near-black leaves it
  // floating on nothing; near-white swallows it.
  for (const extreme of [0x000000, 0x0a0a3f, 0xffffff, 0xfff8f0]) {
    const got = P.toHsl(P.usable(extreme));
    assert.ok(got.l >= P.LIMITS.MIN_LIT - 0.5 && got.l <= P.LIMITS.MAX_LIT + 0.5,
      `${hx(extreme)} came back at lightness ${got.l.toFixed(0)}`);
  }
});

test('a colour already in range is returned untouched', () => {
  // Clamping must be the exception. If every choice were nudged, the swatch
  // someone picked would never be the one they got.
  for (const preset of P.PRESETS) {
    assert.equal(P.usable(preset.hex), preset.hex, `${preset.name} should not be adjusted`);
  }
});

test('every preset is distinguishable from every other', () => {
  // Two presets 8 degrees apart is a menu that looks broken.
  const hues = P.PRESETS.map((p) => P.toHsl(p.hex).h);
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      const d = Math.abs(hues[i] - hues[j]);
      const apart = Math.min(d, 360 - d);
      assert.ok(apart > 20,
        `${P.PRESETS[i].name} and ${P.PRESETS[j].name} are only ${apart.toFixed(0)} degrees apart`);
    }
  }
});

test('presets are named, and the default is among them', () => {
  assert.ok(P.PRESETS.length >= 5);
  for (const p of P.PRESETS) {
    assert.match(p.id, /^[a-z]+$/);
    assert.ok(p.name && p.name[0] === p.name[0].toUpperCase(), 'names are proper nouns');
  }
  assert.ok(P.PRESETS.some((p) => p.hex === P.DEFAULT_HEX), 'the original colour is offered');
});

test('nonsense input does not produce a broken orb', () => {
  for (const junk of [null, undefined, NaN, -1, 'orange', 0x1000000]) {
    const c = P.toHsl(P.usable(junk));
    assert.ok(c.l >= P.LIMITS.MIN_LIT - 0.5 && c.l <= P.LIMITS.MAX_LIT + 0.5);
    assert.ok(Number.isFinite(P.usable(junk)));
  }
});

test('hex and hsl round-trip', () => {
  for (const hex of [0xff8a00, 0x4a7fe0, 0x11a8a8, 0x5aa838]) {
    const back = P.toHex(P.toHsl(hex));
    const off = Math.abs(((back >> 16) & 255) - ((hex >> 16) & 255))
              + Math.abs(((back >> 8) & 255) - ((hex >> 8) & 255))
              + Math.abs((back & 255) - (hex & 255));
    assert.ok(off <= 3, `${hx(hex)} -> ${hx(back)} drifted by ${off}`);
  }
});
