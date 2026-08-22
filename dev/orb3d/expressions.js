'use strict';
/**
 * The character, as data. Both the 3D orb and the texture test sheet import
 * this, so the sheet can never quietly drift from what the orb actually shows.
 *
 * Sober is the BASELINE, not a ceiling: if two neighbouring states cannot be
 * told apart at a glance the range is too narrow to be useful. Eye SIZE does
 * a lot of that separating -- wide reads alert and delighted, small reads flat
 * and closed-off -- which frees the mouth from having to carry every reading
 * on its own.
 */

export const TONE = {
  base:    { color: 0xff8a00, rough: 0.34, sheen: 0.40 },
  warm:    { color: 0xffa51f, rough: 0.28, sheen: 0.55 },   // up, a bit brighter
  excited: { color: 0xffb92e, rough: 0.20, sheen: 0.75 },   // glossier: it catches more light
  blue:    { color: 0x7a8798, rough: 0.42, sheen: 0.26 },   // down, cooled off
  red:     { color: 0xe04a24, rough: 0.30, sheen: 0.45 },   // cross
  grey:    { color: 0x6d6d73, rough: 0.54, sheen: 0.08 },   // asleep, no colour left
};

export const EXPRESSIONS = {
  //                              eyes                          mouth
  //             tone       lid   scale asym    width  open  curve
  calm:      { tone: 'base',    lidTop: 0.00, eyeScale: 1.00, mouthW: 0.90, mouthOpen: 0.00, mouthCurve: 0.52 },
  attentive: { tone: 'base',    lidTop: 0.00, eyeScale: 1.05, mouthW: 0.74, mouthOpen: 0.00, mouthCurve: 0.30 },
  pleased:   { tone: 'warm',    lidTop: 0.14, eyeScale: 1.00, mouthW: 1.06, mouthOpen: 0.12, mouthCurve: 1.00 },
  happy:     { tone: 'warm',    lidTop: 0.06, eyeScale: 1.00, mouthW: 1.14, mouthOpen: 0.34, mouthCurve: 0.95 },
  excited:   { tone: 'excited', lidTop: 0.00, eyeScale: 1.08, mouthW: 1.34, mouthOpen: 0.92, mouthCurve: 0.80 },
  listening: { tone: 'base',    lidTop: 0.00, eyeScale: 1.14, mouthW: 0.42, mouthOpen: 0.58, mouthCurve: 0.05 },
  thinking:  { tone: 'base',    lidTop: 0.04, eyeScale: 0.98, eyeAsym: 0.30, mouthW: 0.54, mouthOpen: 0.00, mouthCurve: -0.05 },
  working:   { tone: 'base',    lidTop: 0.10, eyeScale: 0.96, mouthW: 0.68, mouthOpen: 0.14, mouthCurve: 0.30 },
  sad:       { tone: 'blue',    lidTop: 0.02, eyeScale: 1.04, mouthW: 0.92, mouthOpen: 0.00, mouthCurve: -1.00 },
  cross:     { tone: 'red',     lidTop: 0.52, eyeScale: 0.86, mouthW: 0.72, mouthOpen: 0.00, mouthCurve: -0.55 },
  sleepy:    { tone: 'base',    lidTop: 0.82, eyeScale: 1.00, mouthW: 0.62, mouthOpen: 0.08, mouthCurve: 0.25 },
  asleep:    { tone: 'grey',    lidTop: 1.00, eyeScale: 1.00, mouthW: 0.56, mouthOpen: 0.00, mouthCurve: 0.18, lit: 0.20 },
};
