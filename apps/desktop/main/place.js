'use strict';
/**
 * Keeping fren on a screen.
 *
 * The window is mostly empty space: the orb sits in its bottom-right corner and
 * the chat panel grows up and to the left out of it. So clamping the WINDOW
 * into the work area would stop you parking fren against an edge, which is
 * exactly where people put it. What has to stay visible is the character.
 *
 * This exists because dragging fren past the edge of a display left it there
 * for good. Nothing clamped the drag, nothing persisted a position that could
 * be corrected, and a frameless window has no title bar to grab it back by —
 * so an orb carried off the screen was simply gone, with the app still running.
 *
 * Pure, and separate from Electron, so the arithmetic can be tested against the
 * cases that actually lose it rather than reasoned about.
 */

/**
 * Where the window should sit so the orb stays inside `workArea`.
 *
 * `bounds` is the whole window; `orb` is the character's size in its
 * bottom-right corner. Returns only x and y — the size is not this function's
 * business.
 */
function clampInto(bounds, orb, workArea) {
  // Solved for the ORB's rect, which is
  //   x: bounds.x + bounds.width  - orb.width
  //   y: bounds.y + bounds.height - orb.height
  // sitting inside the work area.
  const minX = workArea.x - bounds.width + orb.width;
  const maxX = workArea.x + workArea.width - bounds.width;
  const minY = workArea.y - bounds.height + orb.height;
  const maxY = workArea.y + workArea.height - bounds.height;
  return {
    // min before max: when the window is wider than the work area, the range
    // inverts and the orb should end up at the right/bottom edge, which is
    // where it lives. Ordering it the other way parks it off the far side.
    x: Math.round(Math.min(Math.max(bounds.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(bounds.y, minY), maxY)),
  };
}

/**
 * Where the character is drawn inside a window of a given size.
 *
 * The one place that answers "where is the orb, really", and the whole mechanism
 * by which the panel changes sides without the orb moving a pixel. The panel
 * fills the window; the orb sits at one corner of it, and which corner is the
 * only thing that varies:
 *
 *   side  'left'  panel to the LEFT of the orb   — orb at the window's right
 *         'right' panel to the RIGHT of the orb  — orb at the window's left
 *   drop  false   panel ABOVE the orb            — orb at the window's bottom
 *         true    panel BELOW the orb            — orb at the window's top
 *
 * The shadow's strip stays on the right and the bottom whichever corner is
 * chosen, because the shadow always falls down-right — the light does not move
 * when the window does.
 */
function offsetInWindow(size, character, pad, room, { side = 'left', drop = false } = {}) {
  return {
    x: side === 'right' ? pad : size.width - pad - room - character.width,
    y: drop ? pad : size.height - pad - room - character.height,
  };
}

/**
 * Where to put a window of `size` so the character lands exactly on `rect`.
 *
 * Opening the panel is this and nothing else: measure where the character is,
 * pick the corner, and place the new window around it.
 */
function windowFor(rect, size, character, pad, room, how) {
  const off = offsetInWindow(size, character, pad, room, how);
  return { x: rect.x - off.x, y: rect.y - off.y };
}

/**
 * The biggest window whose PANEL still lands inside the work area.
 *
 * The panel, not the window. The window carries a transparent strip on its
 * right and bottom for the shadow, and that strip is allowed to hang off the
 * screen — clampToScreen permits exactly that so fren can be parked against an
 * edge. Requiring the whole window on screen instead makes the far edge
 * unreachable and cannot be satisfied by shrinking anything, because in
 * left-growing mode the window's right edge is pinned past the character and
 * does not move when the width does.
 *
 * The stage insets its content by `pad` on the left and top, and by
 * `pad + room` on the right and bottom. Working the panel's own edges back
 * through that, for a window of size S with the character pinned:
 *
 *   growing left   panelLeft  = charX - S.w + 2*pad + room + charW
 *   growing right  panelRight = charX + S.w - 2*pad - room
 *   growing up     panelTop   = charY - S.h + 2*pad + room + charH
 *   growing down   panelBottom= charY + S.h - 2*pad - room
 *
 * and each of those against its edge of the work area gives the allowance.
 */
function roomFor(rect, character, pad, room, workArea, how) {
  const slack = 2 * pad + room;
  return {
    width: how.side === 'right'
      ? (workArea.x + workArea.width) - rect.x + slack
      : rect.x + character.width + slack - workArea.x,
    height: how.drop
      ? (workArea.y + workArea.height) - rect.y + slack
      : rect.y + character.height + slack - workArea.y,
  };
}

/**
 * Which corner the panel grows into, and how big it may be there.
 *
 * Two things had to be decided together. Choosing a corner alone is not enough:
 * the panel window is taller than the room on EITHER side when the character is
 * halfway up the screen — pinned to the window's bottom it needs 450px above,
 * pinned to the top it needs 622px below, and a character at 390px has neither.
 * A sweep of the screen found 238 positions like that.
 *
 * So the side is picked for having the most room, and then the panel takes the
 * room that is actually there. It gets narrower or shorter rather than hanging
 * off the edge; the conversation scrolls, which it already did.
 *
 * Preference, when both sides fit, is the way it has always opened: up and to
 * the left.
 */
/**
 * How much roomier the other corner has to be before the panel will swap to it.
 *
 * Only relevant while something is moving — a corner chosen once and left alone
 * never reconsiders. Big enough that a drag does not flutter, small enough that
 * carrying fren to the far side of the screen still turns the panel round.
 */
const BETTER_BY = 96;

function chooseSide(rect, size, character, pad, room, workArea, prefer = null) {
  const roomOn = (how) => roomFor(rect, character, pad, room, workArea, how);
  const fitsW = (side) => roomOn({ side, drop: false }).width >= size.width;
  const fitsH = (drop) => roomOn({ side: 'left', drop }).height >= size.height;

  // A corner already in use is kept unless the other one is BETTER_BY pixels
  // roomier. Without that the choice is re-made on every frame of a drag, and
  // in the band across the middle of the screen where neither direction fits
  // the panel, the better corner changes every pixel — so a hand that is merely
  // not perfectly still swings a 600px panel back and forth across the orb.
  const stickier = (a, b, roomOf) => {
    if (!prefer) return null;
    // The margin is the whole rule. A corner that has run out of room loses by
    // far more than BETTER_BY and is dropped anyway, so there is no need to ask
    // separately whether the panel still fits where it is — and asking made the
    // stickiness vanish in the one band, across the middle of the screen, where
    // nothing fits anywhere and it is most needed.
    const was = typeof a === 'string' ? prefer.side : prefer.drop;
    const kept = was === a ? a : (was === b ? b : null);
    if (kept === null) return null;
    const other = kept === a ? b : a;
    return roomOf(other) > roomOf(kept) + BETTER_BY ? other : kept;
  };

  const widthOn = (s) => roomOn({ side: s, drop: false }).width;
  const heightOn = (d) => roomOn({ side: 'left', drop: d }).height;

  const side = stickier('left', 'right', widthOn) ?? (
    fitsW('left') ? 'left'
      : (fitsW('right') ? 'right'
        : (widthOn('right') > widthOn('left') ? 'right' : 'left')));
  const drop = stickier(false, true, heightOn) ?? (
    fitsH(false) ? false
      : (fitsH(true) ? true
        : heightOn(true) > heightOn(false)));

  const avail = roomFor(rect, character, pad, room, workArea, { side, drop });
  return {
    side,
    drop,
    // Never larger than asked for, never larger than there is room for.
    size: {
      width: Math.max(0, Math.min(size.width, avail.width)),
      height: Math.max(0, Math.min(size.height, avail.height)),
    },
  };
}

/**
 * The character's box at scale 1 — #orb-zone in styles.css, the drag halo.
 *
 * Not the sphere inside it, and not a round number near it. This is the
 * rectangle the browser lays out, so it is the rectangle main has to model: the
 * whole mechanism for keeping the orb still is "hold this box fixed while the
 * window changes around it", and holding the WRONG box fixed moves the right
 * one by the difference. It was modelled as 150 for a while, and the 6px that
 * bought showed up as the orb twitching every time the panel changed corner.
 */
const CHARACTER_BASE = 144;
/** #stage's own padding on its left and top, from styles.css. */
const STAGE_PAD = 4;
/**
 * Room along the stage's right and bottom for the character's shadow to finish.
 *
 * The window clips: anything drawn past its edge simply is not on screen. A CSS
 * blur(r) paints about 1.5r past its own box — sigma is half the radius and a
 * Gaussian is only spent by three sigma — so a shadow with nowhere to fade ends
 * along a straight line instead.
 *
 * Down AND right, because the shadow falls away from the key light, which sits
 * up and to the left of the sphere (orb.js: key.position -2.2, 4.2, 3.0).
 */
const SHADOW_ROOM = 22;

module.exports = {
  clampInto, offsetInWindow, windowFor, chooseSide, roomFor,
  CHARACTER_BASE, STAGE_PAD, SHADOW_ROOM,
};
