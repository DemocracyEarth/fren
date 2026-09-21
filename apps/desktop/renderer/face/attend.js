'use strict';
/**
 * How the orb shows it is listening, during a spoken conversation.
 *
 * A steady green said "the line is open", but not "I am with you": a colour
 * that does not move reads as a state, not as attention. So while fren
 * listens, the green BREATHES — from the lighter leaf green to the darker one
 * and back, slowly, the pace of someone listening rather than of something
 * loading — and your voice pushes it deeper, so the breath visibly answers
 * you. Only the colour moves: the orb stays solid, no glow, no fading.
 *
 * Pure, so it tests without a GPU: given how long fren has been listening,
 * how loud you are, and whether motion should be kept still, how deep into
 * the listening green it is — 0 is the lighter green, 1 the darker.
 */

/** One full breath, lighter → darker → lighter, in seconds. */
export const BREATH_S = 3.2;
/** How far the breath alone travels toward the darker green, and what your voice adds. */
const BREATH_REACH = 0.85;   // on its own the breath must be FELT, not inferred
const VOICE_REACH = 0.15;

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/**
 * @param {number} listeningFor seconds since fren started listening (this turn)
 * @param {number} level        your voice, 0..1, already smoothed
 * @param {boolean} still       reduced motion: no breath, a steady middle green
 */
export function attendDepth(listeningFor, level = 0, still = false) {
  const t = Math.max(0, Number.isFinite(listeningFor) ? listeningFor : 0);
  // Starts at the lighter end, so the turn opens bright and settles in.
  const breath = still ? 0.5 : 0.5 - 0.5 * Math.cos((t / BREATH_S) * Math.PI * 2);
  return clamp01(breath * BREATH_REACH + clamp01(level) * VOICE_REACH);
}
