'use strict';
/**
 * When a return deserves a hello.
 *
 * The machine waking or the screen unlocking is a return only after a while
 * away: a two-minute lock to get a coffee is not a homecoming, and greeting
 * it would wear the hello out fast. And once greeted, a second signal for the
 * same return (macOS wakes, then unlocks) stays quiet. Pure, so the rule can
 * be read in one place and tested without a machine going to sleep.
 */
const MIN_AWAY_MS = 10 * 60 * 1000;
const MIN_BETWEEN_MS = 5 * 60 * 1000;

function shouldGreetOnReturn({ awayMs, lastGreetAt = 0, now = Date.now(), minAwayMs = MIN_AWAY_MS, minBetweenMs = MIN_BETWEEN_MS } = {}) {
  if (!Number.isFinite(awayMs) || awayMs < minAwayMs) return { greet: false, why: 'not away long enough' };
  if (lastGreetAt && now - lastGreetAt < minBetweenMs) return { greet: false, why: 'just greeted' };
  return { greet: true, why: 'back after a while' };
}

module.exports = { shouldGreetOnReturn, MIN_AWAY_MS, MIN_BETWEEN_MS };
