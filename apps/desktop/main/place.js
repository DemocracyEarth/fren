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

module.exports = { clampInto };
