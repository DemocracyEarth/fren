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

// --- the panel flipping sides ----------------------------------------------
//
// The orb must never move. It is the one thing anchored to a place on the
// screen, and everything else — the panel, the shadow's room, the window itself
// — arranges itself around wherever it happens to be.

const { offsetInWindow, windowFor, chooseSide } = require('../main/place.js');

const PAD = 4;
const ROOM = 22;
const CHAR = { width: 150, height: 150 };
const ORB_WIN = { width: 150 + ROOM, height: 150 + ROOM };
const PANEL_WIN = { width: 384 + ROOM, height: 460 + 144 + ROOM };

test('the character sits bottom-right when the panel is above', () => {
  const off = offsetInWindow(ORB_WIN, CHAR, PAD, ROOM, { side: 'left', drop: false });
  assert.equal(off.x, ORB_WIN.width - PAD - ROOM - CHAR.width);
  assert.equal(off.y, ORB_WIN.height - PAD - ROOM - CHAR.height);
});

test('and top-right when the panel is below', () => {
  const off = offsetInWindow(ORB_WIN, CHAR, PAD, ROOM, { side: 'left', drop: true });
  assert.equal(off.y, PAD, 'the orb goes to the top, so the panel has room under it');
  assert.equal(off.x, ORB_WIN.width - PAD - ROOM - CHAR.width, 'horizontally unchanged');
});

/** Where the character ends up if a window of `size` is placed by windowFor. */
const landsAt = (rect, size, how) => {
  const w = windowFor(rect, size, CHAR, PAD, ROOM, how);
  const off = offsetInWindow(size, CHAR, PAD, ROOM, how);
  return { x: w.x + off.x, y: w.y + off.y };
};

test('opening the panel ABOVE does not move the orb', () => {
  const at = { x: 1300, y: 700 };
  assert.deepEqual(landsAt(at, PANEL_WIN, { side: 'left', drop: false }), at);
});

test('opening the panel BELOW does not move the orb', () => {
  // The case that was broken: near the top of the screen there is no room
  // above, the window used to be clamped back down, and the orb came with it.
  const at = { x: 1300, y: 40 };
  assert.deepEqual(landsAt(at, PANEL_WIN, { side: 'left', drop: true }), at);
});

test('the orb stays put wherever it is, either way round', () => {
  for (const at of [{ x: 0, y: 0 }, { x: 1300, y: 700 }, { x: -900, y: 300 },
                    { x: 3600, y: 1900 }, { x: 12, y: 5 }]) {
    for (const side of ['left', 'right']) {
      for (const drop of [false, true]) {
        const how = { side, drop };
        assert.deepEqual(landsAt(at, PANEL_WIN, how), at,
          `moved from ${at.x},${at.y} with ${side}/${drop}`);
        assert.deepEqual(landsAt(at, ORB_WIN, how), at, 'and closing does not move it either');
      }
    }
  }
});

test('flipping sides moves the WINDOW, never the character', () => {
  const at = { x: 1300, y: 400 };
  const above = windowFor(at, PANEL_WIN, CHAR, PAD, ROOM, { side: 'left', drop: false });
  const below = windowFor(at, PANEL_WIN, CHAR, PAD, ROOM, { side: 'left', drop: true });
  assert.notDeepEqual(above, below, 'the window has to move for the panel to change sides');
  assert.equal(above.x, below.x, 'but only vertically');
  assert.deepEqual(landsAt(at, PANEL_WIN, { side: 'left', drop: false }), landsAt(at, PANEL_WIN, { side: 'left', drop: true }),
    'and the character lands in the same place either way');
});

// --- choosing the corner ----------------------------------------------------
//
// The panel must never open off the screen, and the orb must never move to
// make room for it. Those two together mean the panel has to choose a corner.

const DESK = { x: 0, y: 0, width: 1512, height: 950 };
const pick = (x, y, area = DESK) =>
  chooseSide({ x, y, ...CHAR }, PANEL_WIN, CHAR, PAD, ROOM, area);

/**
 * Does the PANEL land inside the work area?
 *
 * The panel, not the window. The window is bigger than what you can see: the
 * stage insets it by PAD on the left and top and by PAD + ROOM on the right and
 * bottom, and that extra strip is transparent room for the orb's shadow.
 * clampInto deliberately lets that strip hang off the screen so fren can be
 * parked hard against an edge — so demanding the whole window be on screen both
 * fails positions that look perfectly fine and cannot be fixed by shrinking
 * anything, because the strip's outer edge is pinned to the character.
 */
const shown = (at, size) => ({
  x: at.x + PAD,
  y: at.y + PAD,
  width: size.width - PAD - (PAD + ROOM),
  height: size.height - PAD - (PAD + ROOM),
});

const clear = (x, y, how, area = DESK) => {
  const box = shown(windowFor({ x, y, ...CHAR }, how.size, CHAR, PAD, ROOM, how), how.size);
  return box.x >= area.x && box.y >= area.y &&
         box.x + box.width <= area.x + area.width &&
         box.y + box.height <= area.y + area.height;
};

test('bottom-right of the screen keeps the old behaviour', () => {
  const how = pick(1330, 770);
  assert.equal(how.side, 'left');
  assert.equal(how.drop, false);
  assert.deepEqual(how.size, PANEL_WIN, 'and it opens at full size');
});

test('on the LEFT edge, the panel opens to the right', () => {
  const how = pick(20, 770);
  assert.equal(how.side, 'right', 'a panel growing left would run off the screen');
  assert.ok(clear(20, 770, how));
});

test('at the TOP, the panel opens downward', () => {
  const how = pick(1330, 20);
  assert.equal(how.drop, true);
  assert.ok(clear(1330, 20, how));
});

test('in the top-left corner it turns both ways at once', () => {
  const how = pick(20, 20);
  assert.equal(how.side, 'right');
  assert.equal(how.drop, true);
  assert.deepEqual(how.size, PANEL_WIN, 'with a whole screen to open into');
  assert.ok(clear(20, 20, how));
});

test('the panel never opens off the screen, wherever the orb is', () => {
  // The real assertion, and the reason chooseSide returns a size at all.
  // Sweep the orb across every position it can occupy and require the panel to
  // be wholly on screen at each one.
  //
  // Four corners are not enough on their own. A 1512x950 screen has a band in
  // the middle vertically where NEITHER direction fits a 626px panel: pinned
  // above the orb it needs 450px of headroom, pinned below it needs 622px, and
  // an orb at y=390 has neither. That band is why the panel also has to be
  // allowed to shrink, and this sweep is what found it.
  const off = [];
  for (let x = 0; x <= DESK.width - CHAR.width; x += 37) {
    for (let y = 0; y <= DESK.height - CHAR.height; y += 37) {
      if (!clear(x, y, pick(x, y))) off.push(`${x},${y}`);
    }
  }
  assert.deepEqual(off, [], `panel left the screen at: ${off.slice(0, 6).join(' ')}`);
});

test('it shrinks only as much as it has to, and never past nothing', () => {
  const roomy = pick(1330, 770);
  assert.deepEqual(roomy.size, PANEL_WIN, 'plenty of room: full size');

  for (let x = 0; x <= DESK.width - CHAR.width; x += 37) {
    for (let y = 0; y <= DESK.height - CHAR.height; y += 37) {
      const { size } = pick(x, y);
      assert.ok(size.width > 0 && size.height > 0, `degenerate at ${x},${y}`);
      assert.ok(size.width <= PANEL_WIN.width && size.height <= PANEL_WIN.height,
        `grew beyond its natural size at ${x},${y}`);
    }
  }
});

test('a menu bar and a dock are respected', () => {
  const inset = { x: 0, y: 38, width: 1512, height: 880 };
  const off = [];
  for (let x = 0; x <= inset.width - CHAR.width; x += 53) {
    for (let y = inset.y; y <= inset.y + inset.height - CHAR.height; y += 53) {
      if (!clear(x, y, pick(x, y, inset), inset)) off.push(`${x},${y}`);
    }
  }
  assert.deepEqual(off, [], `panel left the work area at: ${off.slice(0, 6).join(' ')}`);
});

test('on a display too small for the panel it takes the roomier side', () => {
  // Nothing fits, so nothing can be perfect — but it must still choose the side
  // with more of the screen on it rather than the one with less.
  const tiny = { x: 0, y: 0, width: 500, height: 400 };
  assert.equal(chooseSide({ x: 40, y: 200, ...CHAR }, PANEL_WIN, CHAR, PAD, ROOM, tiny).side,
    'right', 'orb near the left: more room to its right');
  assert.equal(chooseSide({ x: 300, y: 200, ...CHAR }, PANEL_WIN, CHAR, PAD, ROOM, tiny).side,
    'left', 'orb near the right: more room to its left');
});

test('choosing a corner still never moves the orb', () => {
  for (const [x, y] of [[20, 20], [1330, 770], [20, 770], [1330, 20], [700, 400]]) {
    const at = { x, y };
    assert.deepEqual(landsAt(at, PANEL_WIN, pick(x, y)), at);
  }
});

// --- and the numbers themselves --------------------------------------------

const { CHARACTER_BASE, STAGE_PAD: PLACE_PAD, SHADOW_ROOM: PLACE_ROOM } =
  require('../main/place.js');

test('the geometry main works in is the geometry the stylesheet lays out', () => {
  // Main cannot measure the DOM, so it models it — and a model that drifts from
  // the stylesheet moves the orb by the difference, silently, in whichever
  // corner does not cancel it out. It drifted by 6px once; this is how that is
  // not allowed to happen again.
  const css = require('node:fs')
    .readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

  const zone = css.match(/#orb-zone\s*\{[^}]*?width:\s*calc\((\d+)px\s*\*\s*var\(--orb-scale/);
  assert.ok(zone, 'could not find #orb-zone in styles.css');
  assert.equal(Number(zone[1]), CHARACTER_BASE,
    'place.js models a character the stylesheet does not draw');

  // #stage's shorthand: `padding: <top> calc(<pad> + <room> * ...) ... <left>`.
  const stage = css.match(/#stage\s*\{[\s\S]*?padding:\s*(\d+)px\s+calc\((\d+)px\s*\+\s*(\d+)px/);
  assert.ok(stage, 'could not find #stage padding in styles.css');
  assert.equal(Number(stage[1]), PLACE_PAD, 'stage top padding');
  assert.equal(Number(stage[2]), PLACE_PAD, 'stage padding inside the shadow room');
  assert.equal(Number(stage[3]), PLACE_ROOM, 'shadow room');
});

test('a closed orb sits in the same place in every corner', () => {
  // What makes closing the panel safe. The window that holds nothing but the
  // character is the character plus the stage's padding, so the offset is
  // STAGE_PAD whichever way round it is — and no amount of corner bookkeeping
  // can move a closed orb.
  for (const scale of [0.65, 0.891, 1, 1.35, 2]) {
    const room = Math.round(PLACE_ROOM * scale);
    const n = Math.round(CHARACTER_BASE * scale);
    const ch = { width: n, height: n };
    const win = { width: n + 2 * PLACE_PAD + room, height: n + 2 * PLACE_PAD + room };
    for (const side of ['left', 'right']) {
      for (const drop of [false, true]) {
        assert.deepEqual(offsetInWindow(win, ch, PLACE_PAD, room, { side, drop }),
          { x: PLACE_PAD, y: PLACE_PAD },
          `closed orb moved at scale ${scale} in ${side}/${drop}`);
      }
    }
  }
});

test('a corner in use is not given up for a pixel', () => {
  // The drag re-chooses every frame. In the band where neither direction fits,
  // the roomier one changes with every pixel of movement, so without this a
  // hand that is merely not perfectly still swings the panel back and forth.
  const squeeze = { x: 700, y: 400, ...CHAR };
  const fresh = chooseSide(squeeze, PANEL_WIN, CHAR, PAD, ROOM, DESK);
  const other = { side: fresh.side, drop: !fresh.drop };

  // One pixel of movement must not flip a corner that is already in use.
  for (let dy = -3; dy <= 3; dy++) {
    const how = chooseSide({ ...squeeze, y: squeeze.y + dy }, PANEL_WIN, CHAR, PAD, ROOM, DESK, other);
    assert.equal(how.drop, other.drop, `flipped after ${dy}px of drift`);
  }

  // But carrying fren to the other end of the screen does turn it round.
  const far = chooseSide({ ...squeeze, y: 40 }, PANEL_WIN, CHAR, PAD, ROOM, DESK,
    { side: 'left', drop: false });
  assert.equal(far.drop, true, 'at the top of the screen it has to open downward');
});

test('stickiness never costs the guarantee', () => {
  // Whatever it prefers, the panel still has to be on screen. Sweep every
  // position with every corner as the incumbent.
  const off = [];
  for (const prefer of [{ side: 'left', drop: false }, { side: 'left', drop: true },
                        { side: 'right', drop: false }, { side: 'right', drop: true }]) {
    for (let x = 0; x <= DESK.width - CHAR.width; x += 41) {
      for (let y = 0; y <= DESK.height - CHAR.height; y += 41) {
        const how = chooseSide({ x, y, ...CHAR }, PANEL_WIN, CHAR, PAD, ROOM, DESK, prefer);
        if (!clear(x, y, how)) off.push(`${x},${y} preferring ${prefer.side}/${prefer.drop}`);
      }
    }
  }
  assert.deepEqual(off, [], `panel left the screen at: ${off.slice(0, 4).join(' | ')}`);
});
