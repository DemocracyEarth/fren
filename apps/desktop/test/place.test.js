'use strict';
/**
 * Keeping fren reachable.
 *
 * Every test here is a way the orb got lost, or could. The one that actually
 * happened is "dragged off the right edge" — the drag handler moved the window
 * with no clamp at all, and a frameless window has no title bar to drag back.
 */
const test = require('node:test');
const assert = require('node:assert');
const { clampInto } = require('../main/place.js');

const SCREEN = { x: 0, y: 0, width: 1512, height: 950 };   // a laptop work area
const ORB = { width: 150, height: 150 };
const WIN = { width: 150, height: 150 };
const PANEL = { width: 384, height: 604 };

const at = (x, y, size = WIN) => clampInto({ x, y, ...size }, ORB, SCREEN);

test('a window already on screen is left alone', () => {
  assert.deepEqual(at(1338, 776), { x: 1338, y: 776 });
  assert.deepEqual(at(400, 300), { x: 400, y: 300 });
});

test('dragged off the right edge, it comes back', () => {
  // What actually happened.
  const p = at(2400, 500);
  assert.ok(p.x <= SCREEN.width - WIN.width, `x ${p.x} is still off the right`);
  assert.equal(p.x, 1362);
});

test('dragged off every other edge, it comes back', () => {
  for (const [x, y] of [[-900, 400], [400, -700], [400, 3000], [-2000, -2000], [5000, 5000]]) {
    const p = at(x, y);
    const orbX = p.x + WIN.width - ORB.width;
    const orbY = p.y + WIN.height - ORB.height;
    assert.ok(orbX >= SCREEN.x && orbX + ORB.width <= SCREEN.x + SCREEN.width,
      `from ${x},${y}: orb x ${orbX} is off screen`);
    assert.ok(orbY >= SCREEN.y && orbY + ORB.height <= SCREEN.y + SCREEN.height,
      `from ${x},${y}: orb y ${orbY} is off screen`);
  }
});

test('the panel may hang off the edge, the character may not', () => {
  // The whole point of clamping the orb rather than the window: with the panel
  // open the window is 384x604 of mostly empty space, and forcing all of that
  // on screen would shove fren away from the corner people park it in.
  const p = clampInto({ x: 1290, y: 400, ...PANEL }, ORB, SCREEN);
  assert.equal(p.x, 1128, 'the window keeps its position');
  const orbX = p.x + PANEL.width - ORB.width;
  assert.ok(orbX + ORB.width <= SCREEN.width, 'and the orb is fully visible');
});

test('a second display to the left is a real place to be', () => {
  // Negative coordinates are normal with a display left of the primary, and
  // must not read as "off screen".
  const left = { x: -1920, y: 0, width: 1920, height: 1080 };
  const p = clampInto({ x: -1000, y: 300, ...WIN }, ORB, left);
  assert.deepEqual(p, { x: -1000, y: 300 });
});

test('a menu bar or dock is respected', () => {
  const inset = { x: 0, y: 38, width: 1512, height: 912 };   // menu bar at the top
  const p = clampInto({ x: 400, y: 0, ...WIN }, ORB, inset);
  assert.ok(p.y + WIN.height - ORB.height >= inset.y, 'the orb clears the menu bar');
});

test('a window larger than the screen still lands somewhere visible', () => {
  // At maximum size with the panel open the window can exceed a small display.
  // The range inverts here, and the orb must end up at the corner it lives in
  // rather than off the far side.
  const small = { x: 0, y: 0, width: 800, height: 600 };
  const big = { width: 384, height: 748 };
  const p = clampInto({ x: 300, y: 200, ...big }, ORB, small);
  const orbY = p.y + big.height - ORB.height;
  assert.ok(orbY + ORB.height <= small.y + small.height + 1,
    `orb bottom ${orbY + ORB.height} exceeds ${small.height}`);
  assert.ok(orbY >= small.y - 1, `orb top ${orbY} is above the work area`);
});

test('it returns whole pixels', () => {
  const p = clampInto({ x: 10.4, y: 20.6, ...WIN }, ORB, SCREEN);
  assert.equal(p.x, Math.round(p.x));
  assert.equal(p.y, Math.round(p.y));
});
