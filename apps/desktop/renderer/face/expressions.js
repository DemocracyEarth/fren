'use strict';
/**
 * The character, as data.
 *
 * This is the whole personality in one table, and it is the source of truth
 * for every renderer — the 3D orb, the texture test sheet, anything later.
 * Keeping it as plain data is what made it possible to change renderer without
 * redrawing the character.
 *
 * Two rules earn their keep here:
 *
 *   Sober is the BASELINE, not a ceiling. If two neighbouring states cannot be
 *   told apart at a glance the range is too narrow to be useful — but a face
 *   that beams at you all day reads as unhinged rather than friendly. So the
 *   resting register is calm and the extremes are reserved.
 *
 *   Lowered lids read as ANGER. It is the strongest single cue on a face, so
 *   it belongs to `annoyed` and to genuine sleepiness, and nothing else may
 *   borrow it. Sadness is carried by the mouth and the cooled body instead.
 *
 *   The eyes are ALWAYS symmetric. An uneven pair reads as a wink or a smirk,
 *   which is charming in a toy and wrong in an assistant that sits on someone's
 *   desktop all day. `eyeAsym` still exists in the parameter space, and is
 *   deliberately never set.
 */

/** One palette, anchored on the brand orange. Mood shifts hue within a family. */
export const TONE = {
  base:    { color: 0xff8a00, rough: 0.34, sheen: 0.40 },
  warm:    { color: 0xffa51f, rough: 0.28, sheen: 0.55 },   // up, a little brighter
  excited: { color: 0xffb92e, rough: 0.20, sheen: 0.75 },   // glossier: catches more light
  blue:    { color: 0x7a8798, rough: 0.42, sheen: 0.26 },   // down, cooled off
  red:     { color: 0xe04a24, rough: 0.30, sheen: 0.45 },   // cross
  grey:    { color: 0x6d6d73, rough: 0.54, sheen: 0.08 },   // asleep, no colour left
};

const E = (tone, lidTop, eyeScale, mouthW, mouthOpen, mouthCurve, extra) =>
  Object.assign({ tone, lidTop, eyeScale, eyeAsym: 0, mouthW, mouthOpen, mouthCurve,
                  mouthWave: 0, lit: 1 }, extra);

export const EXPRESSIONS = {
  // ---- lit, and glad about it ---------------------------------------------
  happy:        E('warm',    0.06, 1.00, 1.14, 0.34, 0.95),
  excited:      E('excited', 0.00, 1.08, 1.34, 0.92, 0.80),
  joyful:       E('excited', 0.05, 1.04, 1.28, 0.74, 0.95),
  laughing:     E('excited', 0.92, 1.00, 1.26, 0.82, 1.00),
  overjoyed:    E('excited', 0.96, 1.00, 1.30, 0.78, 1.00),
  content:      E('warm',    0.10, 1.00, 1.00, 0.00, 0.85),
  proud:        E('warm',    0.08, 1.02, 1.06, 0.10, 0.90),
  hopeful:      E('warm',    0.00, 1.06, 0.96, 0.10, 0.75),
  love:         E('warm',    0.05, 1.05, 1.10, 0.30, 0.95),

  // ---- lit, and up to something -------------------------------------------
  playful:      E('warm',    0.05, 1.02, 1.00, 0.26, 0.85),
  cheeky:       E('warm',    0.10, 1.00, 0.96, 0.30, 0.80),
  silly:        E('warm',    0.00, 1.05, 1.02, 0.36, 0.50, { mouthWave: 1 }),
  blushing:     E('warm',    0.20, 0.98, 0.86, 0.08, 0.80),
  shy:          E('warm',    0.32, 0.95, 0.70, 0.00, 0.60),

  // ---- lit, and working ---------------------------------------------------
  calm:         E('base',    0.00, 1.00, 0.90, 0.00, 0.52),
  watching:     E('base',    0.00, 1.05, 0.74, 0.00, 0.30),
  listening:    E('base',    0.00, 1.14, 0.42, 0.58, 0.05),
  talking:      E('base',    0.02, 1.00, 0.90, 0.40, 0.40),
  thinking:     E('base',    0.04, 0.98, 0.54, 0.00, -0.05),
  processing:   E('base',    0.10, 0.98, 0.56, 0.12, 0.20),
  focused:      E('base',    0.12, 0.96, 0.60, 0.00, 0.10),
  determined:   E('base',    0.16, 0.98, 0.70, 0.00, 0.05),
  curious:      E('base',    0.00, 1.10, 0.50, 0.30, 0.20),
  surprised:    E('base',    0.00, 1.20, 0.46, 0.75, 0.00),
  realization:  E('excited', 0.00, 1.16, 0.52, 0.60, 0.30),

  // ---- lit, and not glad --------------------------------------------------
  // Round OPEN eyes on all of these. Narrow them and they read as angry.
  confused:     E('base',    0.06, 1.00, 0.60, 0.10, -0.20),
  concerned:    E('blue',    0.04, 1.02, 0.80, 0.00, -0.55),
  worried:      E('blue',    0.02, 1.05, 0.86, 0.08, -0.70),
  sad:          E('blue',    0.02, 1.04, 0.92, 0.00, -1.00),
  disappointed: E('blue',    0.14, 0.98, 0.80, 0.00, -0.70),
  annoyed:      E('red',     0.52, 0.86, 0.72, 0.00, -0.55),   // the one that gets lids

  // ---- winding down -------------------------------------------------------
  tired:        E('base',    0.55, 0.96, 0.60, 0.05, -0.10),
  resting:      E('base',    0.80, 1.00, 0.70, 0.00, 0.50),
  peaceful:     E('base',    0.88, 1.00, 0.60, 0.00, 0.45),
  sleepy:       E('base',    0.82, 1.00, 0.62, 0.08, 0.25),
  waking:       E('base',    0.45, 1.00, 0.70, 0.10, 0.40, { lit: 0.70 }),

  // ---- the light is off ---------------------------------------------------
  // `private` is the fail-closed default: if anything upstream breaks, this is
  // what shows, and it must never look like it is watching.
  sleeping:     E('grey',    1.00, 1.00, 0.50, 0.12, 0.20, { lit: 0.14 }),
  private:      E('grey',    1.00, 1.00, 0.56, 0.00, 0.18, { lit: 0.16 }),
};

// Names the app already calls. Kept so a renderer swap cannot silently drop an
// expression somewhere in the codebase.
EXPRESSIONS.neutral = EXPRESSIONS.calm;
EXPRESSIONS.idea = EXPRESSIONS.realization;
EXPRESSIONS.delighted = EXPRESSIONS.joyful;
EXPRESSIONS.mischief = EXPRESSIONS.cheeky;
EXPRESSIONS.wink = EXPRESSIONS.playful;
EXPRESSIONS.bored = EXPRESSIONS.tired;
EXPRESSIONS.oops = EXPRESSIONS.surprised;
EXPRESSIONS.alert = EXPRESSIONS.focused;
EXPRESSIONS.relieved = EXPRESSIONS.resting;

/** Display order for contact sheets. */
export const ORDER = Object.keys(EXPRESSIONS);
