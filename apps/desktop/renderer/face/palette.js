'use strict';
/**
 * What colour fren is.
 *
 * The tone palette in expressions.js is not a list of colours, it is a set of
 * RELATIONSHIPS. `warm` is the base hue nudged 3.4 degrees and lifted 6% in
 * lightness; `excited` is +7.4 and +9; `hearing` is +7.5 and +18. Saturation is
 * identical across all of them. Those numbers are what make the moods read as
 * the same character in different states rather than as different characters,
 * so re-colouring means moving the base and reapplying the offsets — not
 * picking four new colours.
 *
 * ONLY THE IDENTITY FAMILY MOVES. `blue` is sadness, `red` is cross, `grey` is
 * asleep. They are meanings, not decoration: a cheerful green "sad" face is
 * simply wrong, and an asleep orb has to look drained whatever colour the awake
 * one is.
 *
 * The saturation floor is not a matter of taste either. fren's central promise
 * is that the light being on means it is watching, and asleep is signalled by
 * draining the colour out. Let someone choose a near-grey orb and awake stops
 * being distinguishable from asleep — the privacy signal would be gone, chosen
 * away in a settings pane. So the picker clamps, and says why.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FrenPalette = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  /** Measured from the original palette; see the note above. */
  // To three places, so choosing the default colour reproduces the original
  // palette byte for byte rather than approximately.
  const FAMILY = {
    base:    { dH: 0,     dL: 0 },
    warm:    { dH: 3.422, dL: 6.078 },
    excited: { dH: 7.434, dL: 9.020 },
    hearing: { dH: 7.529, dL: 17.647 },
  };
  const SHEEN = { dH: 2.160, dL: 20.784 };

  /** Meanings rather than decoration. These never move. */
  const SEMANTIC = {
    blue: { color: 0x7a8798, rough: 0.42, sheen: 0.26 },
    red:  { color: 0xe04a24, rough: 0.30, sheen: 0.45 },
    grey: { color: 0x6d6d73, rough: 0.54, sheen: 0.08 },
  };

  /** Surface qualities belong to the MOOD, not to the hue, so they are fixed. */
  const SURFACE = {
    base:    { rough: 0.34, sheen: 0.40 },
    warm:    { rough: 0.28, sheen: 0.55 },
    excited: { rough: 0.20, sheen: 0.75 },
    hearing: { rough: 0.14, sheen: 0.95 },
  };

  const MIN_SAT = 45;   // below this, awake stops reading as different from asleep
  const MIN_LIT = 36;   // below this the face, which is emissive, has nothing to sit on
  const MAX_LIT = 64;   // above this the orb washes out and the face vanishes into it

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const wrapHue = (h) => ((h % 360) + 360) % 360;

  function toHsl(hex) {
    const r = ((hex >> 16) & 255) / 255;
    const g = ((hex >> 8) & 255) / 255;
    const b = (hex & 255) / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    let h = 0;
    let s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? ((b - r) / d + 2) : ((r - g) / d + 4);
      h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }

  function toHex({ h, s, l }) {
    const S = clamp(s, 0, 100) / 100;
    const L = clamp(l, 0, 100) / 100;
    const k = (n) => (n + wrapHue(h) / 30) % 12;
    const a = S * Math.min(L, 1 - L);
    const f = (n) => Math.round(255 * (L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    return (f(0) << 16) | (f(8) << 8) | f(4);
  }

  /**
   * The nearest colour fren can actually wear.
   *
   * Returns what will be used, so the interface can show it rather than quietly
   * substituting something the person did not pick.
   */
  function usable(hex) {
    const c = toHsl(Number(hex) || 0);
    return toHex({ h: c.h, s: clamp(c.s, MIN_SAT, 100), l: clamp(c.l, MIN_LIT, MAX_LIT) });
  }

  /** A full tone palette built from one chosen colour. */
  function tonesFrom(hex) {
    const c = toHsl(usable(hex));
    const out = {};
    for (const [name, off] of Object.entries(FAMILY)) {
      out[name] = {
        color: toHex({ h: c.h + off.dH, s: c.s, l: clamp(c.l + off.dL, 0, 96) }),
        rough: SURFACE[name].rough,
        sheen: SURFACE[name].sheen,
      };
    }
    for (const [name, tone] of Object.entries(SEMANTIC)) out[name] = { ...tone };
    return out;
  }

  /** The warm specular tint, which has to follow the body or it reads as grime. */
  function sheenColorFrom(hex) {
    const c = toHsl(usable(hex));
    return toHex({ h: c.h + SHEEN.dH, s: c.s, l: clamp(c.l + SHEEN.dL, 0, 96) });
  }

  // --- the interface accent ------------------------------------------------
  //
  // Choosing a colour changes the whole app, not just the sphere: the buttons,
  // the highlights, the active row, the focus ring. An orange app with a green
  // orb in the corner reads as a bug rather than as a choice.
  //
  // Measured from the shipped orange family, as offsets from --orange.
  const ACCENT = {
    lite:   { dH:  4.5, dS:  8.4, dL:  12.9 },
    deep:   { dH: -4.2, dS: -5.9, dL:  -9.0 },
    shadow: { dH: -6.8, dS: -2.5, dL: -21.6 },
  };

  const CREAM = 0xF0E7D6;     // the surface accent text sits on
  const INK = 0x1A1712;
  const WHITE = 0xffffff;
  const AA = 4.5;

  const lum = (hex) => {
    const ch = (s) => {
      const v = ((hex >> s) & 255) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0);
  };

  function contrast(a, b) {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  /**
   * The text weight of a colour: dark enough to read on the cream.
   *
   * Solved rather than offset. A fixed lightness shift produces a readable
   * brown from orange and an unreadable one from yellow, because contrast is a
   * function of luminance and luminance is not a function of lightness alone.
   */
  function inkFor(h, s) {
    for (let l = 44; l >= 6; l -= 1) {
      const c = toHex({ h, s: Math.min(100, s + 2), l });
      if (contrast(c, CREAM) >= AA + 0.3) return c;
    }
    return INK;
  }

  /**
   * A background that can carry a label, and the label to put on it.
   *
   * White on the shipped orange is 2.54:1 — the send button and the sidebar
   * badges have always failed, and at other hues they fail differently. So the
   * pair is solved together: keep the accent bright if dark ink reads on it,
   * and only darken for white when nothing else works.
   */
  function solidFor(hex) {
    const c = toHsl(hex);
    if (contrast(INK, hex) >= AA) return { solid: hex, on: INK };
    if (contrast(WHITE, hex) >= AA) return { solid: hex, on: WHITE };
    for (let l = c.l; l >= 8; l -= 0.5) {
      const cand = toHex({ h: c.h, s: c.s, l });
      if (contrast(WHITE, cand) >= AA) return { solid: cand, on: WHITE };
    }
    return { solid: toHex({ h: c.h, s: c.s, l: 8 }), on: WHITE };
  }

  /** Every accent token the interface needs, derived from one colour. */
  function accentFrom(hex) {
    const c = toHsl(usable(hex));
    const shade = (o) => toHex({
      h: c.h + o.dH,
      s: clamp(c.s + o.dS, 0, 100),
      l: clamp(c.l + o.dL, 4, 96),
    });
    const accent = toHex({ h: c.h, s: c.s, l: c.l });
    const { solid, on } = solidFor(accent);
    return {
      accent,
      lite: shade(ACCENT.lite),
      deep: shade(ACCENT.deep),
      shadow: shade(ACCENT.shadow),
      ink: inkFor(c.h, c.s),
      solid,
      on,
      // For the tints, which are written as rgba(...) at a dozen opacities.
      rgb: [(accent >> 16) & 255, (accent >> 8) & 255, accent & 255].join(', '),
    };
  }

  const asHex = (n) => '#' + n.toString(16).padStart(6, '0');
  const asRgb = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', ');

  /**
   * Dress the interface in the chosen colour.
   *
   * Both windows call this, because the accent is not the orb's colour — it is
   * the app's, and the orb happens to be the largest thing wearing it.
   */
  function applyAccent(hex, target) {
    const a = accentFrom(hex);
    const root = target || (typeof document !== 'undefined' ? document.documentElement : null);
    if (!root) return a;
    root.style.setProperty('--orange', asHex(a.accent));
    root.style.setProperty('--orange-lite', asHex(a.lite));
    root.style.setProperty('--orange-deep', asHex(a.deep));
    root.style.setProperty('--orange-shadow', asHex(a.shadow));
    root.style.setProperty('--orange-ink', asHex(a.ink));
    root.style.setProperty('--accent-solid', asHex(a.solid));
    root.style.setProperty('--on-accent', asHex(a.on));
    root.style.setProperty('--accent-rgb', a.rgb);
    root.style.setProperty('--accent-shadow-rgb', asRgb(a.shadow));
    return a;
  }

  /**
   * Names, not swatches. "Blue" tells you the hue and nothing else; a name
   * gives the thing a character, which is the entire point of choosing one.
   */
  // There is no yellow. A marigold sat 11 degrees from Ember and read as the
  // same swatch twice — a choice that is not a choice is worse than one fewer.
  const PRESETS = [
    { id: 'ember',      name: 'Ember',      hex: 0xff8a00, note: 'how fren comes' },
    { id: 'rhubarb',    name: 'Rhubarb',    hex: 0xe8446b },
    { id: 'mulberry',   name: 'Mulberry',   hex: 0xa259d9 },
    { id: 'cornflower', name: 'Cornflower', hex: 0x4a7fe0 },
    { id: 'lagoon',     name: 'Lagoon',     hex: 0x11a8a8 },
    { id: 'moss',       name: 'Moss',       hex: 0x5aa838 },
  ];

  const DEFAULT_HEX = 0xff8a00;

  return {
    PRESETS, DEFAULT_HEX, tonesFrom, sheenColorFrom, usable, toHsl, toHex,
    accentFrom, applyAccent, contrast,
    LIMITS: { MIN_SAT, MIN_LIT, MAX_LIT, AA },
  };
});
