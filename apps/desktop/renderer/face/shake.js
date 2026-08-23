'use strict';
/**
 * Is fren being shaken?
 *
 * A shake is a drag that keeps changing its mind: swing one way, swing back,
 * again, again. So this looks for direction REVERSALS rather than for speed.
 * Speed alone is useless here — carrying the orb across a large screen is fast
 * too, and a speed test would set it wobbling every time someone moved it.
 *
 * Three conditions, each rejecting a specific thing that is not a shake:
 *
 *   the turn must be SHARP        — and because the reference direction is
 *                                   updated on every sample, a gradual arc
 *                                   turns the reference with it and never
 *                                   registers as a reversal at all
 *   each swing must GET SOMEWHERE — straight-line distance from the last
 *                                   reversal, NOT distance travelled. A tremor
 *                                   reverses constantly and covers a lot of
 *                                   ground without ever leaving one spot;
 *                                   summing path length counts that as a swing,
 *                                   and a 5px synthetic tremor duly set it off
 *   the reversals must be CLOSE   — rejects a slow deliberate there-and-back
 *
 * Pure: no DOM, no timers, the clock is passed in. The whole point of pulling
 * it out of the event handler is that those rejections can be tested against
 * synthetic gestures, since they are what decides whether this is a delight or
 * an accident that keeps firing.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FrenShake = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const DEFAULTS = {
    minStep: 1.5,    // px between samples below which nothing is happening
    turn: -0.25,     // cos of the turn angle: about 105 degrees or sharper
    minSwing: 26,    // px a swing must cover before it counts as a swing
    windowMs: 520,   // reversals must land within this of each other
    needed: 3,       // and there must be this many before anything happens
    topUpMs: 90,     // never add energy faster than this
  };

  function createShakeDetector(options = {}) {
    const o = { ...DEFAULTS, ...options };
    let last = null;      // previous point
    let dir = null;       // unit direction of the swing in progress
    let pivot = null;     // where the swing in progress began
    let turns = [];       // timestamps of recent reversals
    let fedAt = -Infinity;

    return {
      reset() {
        last = null;
        dir = null;
        pivot = null;
        turns = [];
        // fedAt is deliberately NOT reset: letting go and grabbing again should
        // not be a way to bypass the rate limit.
      },

      /**
       * One pointer sample. Returns { power, turns } when the shake should be
       * fed, and null the rest of the time — which is almost always.
       */
      feed(x, y, now) {
        const pt = { x, y };
        if (!last) { last = pt; pivot = pt; return null; }
        const dx = pt.x - last.x;
        const dy = pt.y - last.y;
        const d = Math.hypot(dx, dy);
        last = pt;
        if (d < o.minStep) return null;

        const ux = dx / d;
        const uy = dy / d;
        let fired = null;

        // How far this swing has actually got from where it began — not how far
        // the pointer travelled getting there.
        const swing = pivot ? Math.hypot(pt.x - pivot.x, pt.y - pivot.y) : 0;

        if (dir && (ux * dir.x + uy * dir.y) < o.turn && swing >= o.minSwing) {
          turns = turns.filter((t) => now - t < o.windowMs);
          turns.push(now);
          pivot = pt;
          if (turns.length >= o.needed && now - fedAt >= o.topUpMs) {
            fedAt = now;
            // A harder, faster shake is a longer list. Topping the energy up
            // rather than restarting is what lets a sustained shake build
            // instead of stutter.
            fired = {
              power: Math.max(0.35, Math.min(1, (turns.length - 2) / 4)),
              turns: turns.length,
            };
          }
        }
        dir = { x: ux, y: uy };
        return fired;
      },
    };
  }

  return { createShakeDetector, DEFAULTS };
});
