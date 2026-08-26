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

test('the default colour reproduces the shipped palette exactly', () => {
  // Not approximately. Someone who never touches this setting must get the
  // palette that was tuned by hand, byte for byte.
  //
  // These bytes have moved once: the original ember #ff8a00 was a solid, and
  // when the body became a gold-to-coral gradient the base was regraded to the
  // gradient's MIDPOINT — softer and pinker, since the shader rotates the gold
  // and coral stops out of whatever this is. The relationships are unchanged;
  // that is the other tests' job to prove.
  const t = P.tonesFrom(P.DEFAULT_HEX);
  assert.equal(hx(t.base.color), '#f28b54');
  // Saturation rises with lightness — the regraded base is soft enough that
  // lightness alone walked the happy moods into pastel grey.
  assert.equal(hx(t.warm.color), '#fa9660');
  assert.equal(hx(t.excited.color), '#ff9b66');
  assert.equal(hx(t.hearing.color), '#ffb97a');
  assert.equal(hx(P.sheenColorFrom(P.DEFAULT_HEX)), '#f9d0b7');
});

test('no mood wears the listening colour', () => {
  // The reason this exists: excited was +7.434 degrees of hue and hearing
  // +7.529 — the same colour to a tenth of a degree. Tolerable while listening
  // was a state you glanced at; not once the orb began PULSING toward it, when
  // an excited fren and a listening fren became the same yellow.
  //
  // Listening has to mean exactly one thing, at every colour fren can wear.
  for (const preset of [...P.PRESETS, { name: 'a custom teal', hex: 0x11a8a8 },
                        { name: 'a custom pink', hex: 0xff2fa0 }]) {
    const t = P.tonesFrom(preset.hex);
    const hue = (c) => P.toHsl(c).h;
    const listening = hue(t.hearing.color);
    for (const mood of ['base', 'warm', 'excited']) {
      const gap = Math.abs(hue(t[mood].color) - listening);
      assert.ok(gap >= 5,
        `${preset.name}: ${mood} is ${gap.toFixed(1)}deg from the listening tone`);
    }
    // And the moods agree with each other, so only brightness tells them apart.
    assert.ok(Math.abs(hue(t.warm.color) - hue(t.base.color)) < 0.5, `${preset.name}: warm drifted`);
    assert.ok(Math.abs(hue(t.excited.color) - hue(t.base.color)) < 0.5, `${preset.name}: excited drifted`);
  }
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

// --- the interface accent --------------------------------------------------
//
// Choosing a colour re-dresses the whole app, so every accent surface has to
// stay readable at every hue — not just at the orange it was designed around.
// These are the tests that stop a pretty colour from producing a button nobody
// can read.

const CREAM = 0xF0E7D6;   // main surfaces
const BONE = 0xFBF6EC;    // the panel's lighter ground
const SIDEBAR = 0xE9E1D2; // the dark end of the sidebar gradient

/** Presets plus two awkward hues a picker could easily produce. */
const HUES = [
  ...P.PRESETS.map((p) => [p.name, p.hex]),
  ['a yellow', 0xE8C520],
  ['a navy', 0x22306E],
  ['a hot pink', 0xFF2FA0],
  ['a lime', 0xB6E800],
];

test('accent text is readable on every surface it lands on, at every hue', () => {
  for (const [name, hex] of HUES) {
    const a = P.accentFrom(hex);
    for (const [where, bg] of [['cream', CREAM], ['bone', BONE], ['sidebar', SIDEBAR]]) {
      const r = P.contrast(a.ink, bg);
      assert.ok(r >= P.LIMITS.AA, `${name}: accent text on ${where} is only ${r.toFixed(2)}`);
    }
  }
});

test('a label on a solid accent button is readable at every hue', () => {
  // White on the shipped orange was 2.54:1 — the send button and the sidebar
  // badges always failed. The background and its label are solved together, so
  // whichever pair wins, it clears AA.
  for (const [name, hex] of HUES) {
    const a = P.accentFrom(hex);
    const r = P.contrast(a.on, a.solid);
    assert.ok(r >= P.LIMITS.AA, `${name}: button label is only ${r.toFixed(2)}`);
  }
});

test('the bright accent is kept as the button wherever it can be', () => {
  // Darkening is the fallback, not the default: an app that dulls its own
  // accent for every colour has quietly traded the look for the rule.
  const kept = HUES.filter(([, hex]) => {
    const a = P.accentFrom(hex);
    return a.solid === a.accent;
  });
  assert.ok(kept.length >= HUES.length - 3,
    `only ${kept.length} of ${HUES.length} hues kept their bright accent`);
});

test('the default colour leaves the shipped accent where it was', () => {
  // "Shipped" means the literals in tokens.css: the app must look the same the
  // frame before applyAccent runs as the frame after, or launch flashes the
  // old orange. When this test moves, tokens.css moves with it — same bytes.
  const a = P.accentFrom(P.DEFAULT_HEX);
  assert.equal(hx(a.accent), '#f28b54');
  assert.equal(hx(a.lite), '#fcbb8c');
  assert.equal(hx(a.deep), '#e86330');
  assert.equal(hx(a.shadow), '#c63c12');
  assert.equal(hx(a.ink), '#ac430b');
  // The tints are driven from this, so it has to be the components of the accent.
  assert.equal(a.rgb, '242, 139, 84');
});

test('every accent token comes back as something CSS can use', () => {
  for (const [name, hex] of HUES) {
    const a = P.accentFrom(hex);
    for (const k of ['accent', 'lite', 'deep', 'shadow', 'ink', 'solid', 'on']) {
      assert.ok(Number.isInteger(a[k]) && a[k] >= 0 && a[k] <= 0xffffff,
        `${name}: ${k} is not a colour`);
    }
    assert.match(a.rgb, /^\d{1,3}, \d{1,3}, \d{1,3}$/, `${name}: rgb is malformed`);
  }
});

test('the accent family keeps its ordering', () => {
  // lite is lighter than the accent, deep and shadow darker, shadow darkest.
  for (const [name, hex] of HUES) {
    const a = P.accentFrom(hex);
    const l = (c) => P.toHsl(c).l;
    assert.ok(l(a.lite) > l(a.accent), `${name}: lite must be lighter`);
    assert.ok(l(a.deep) < l(a.accent), `${name}: deep must be darker`);
    assert.ok(l(a.shadow) < l(a.deep), `${name}: shadow must be darkest`);
  }
});

test('the pre-palette fallback wears the same bytes as the derived default', async () => {
  // expressions.js carries a literal TONE table for the moment before the
  // palette module has run (and for the SVG fallback face). If it drifts from
  // what tonesFrom(DEFAULT_HEX) derives, the orb visibly re-colours a beat
  // after boot — the kind of flash nobody can debug from a report.
  const { TONE } = await import('../renderer/face/expressions.js');
  const t = P.tonesFrom(P.DEFAULT_HEX);
  for (const name of ['base', 'warm', 'excited', 'hearing']) {
    assert.equal(hx(TONE[name].color), hx(t[name].color), `${name} drifted from the palette`);
  }
  for (const name of ['blue', 'red', 'grey']) {
    assert.equal(hx(TONE[name].color), hx(t[name].color), `${name} drifted from the semantics`);
  }
});
