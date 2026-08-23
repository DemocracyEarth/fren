'use strict';
/**
 * Routines: things fren does at a time, rather than when asked.
 *
 * What a routine can do is deliberately narrow. It asks fren a question and
 * reads the answer back — the same thing you could ask by holding the orb,
 * just at a time you chose. It does NOT run commands, and nothing here can:
 * scheduling arbitrary generated scripts is a different and much larger
 * decision than scheduling a question, and it should be taken explicitly rather
 * than arrived at by extending this file.
 *
 * Two rules shape the timing:
 *
 *   A missed routine expires. If the machine was asleep at nine, a morning
 *   recap arriving at half past two is noise, not a recap. After the grace
 *   window it is simply skipped.
 *
 *   Nothing runs while fren is paused. A routine reads back observed activity,
 *   and doing that with the light off would be the one thing the light exists
 *   to rule out.
 */

const TICK_MS = 30 * 1000;
const GRACE_MS = 30 * 60 * 1000;   // after this, a missed routine is stale

/** The moment a routine was due on the day `now` falls in. */
function scheduledFor(routine, now) {
  const d = new Date(now);
  d.setHours(routine.hour, routine.minute, 0, 0);
  return d.getTime();
}

/**
 * Should this routine run right now?
 *
 * Exported for tests, because "did it fire at the right moment, exactly once"
 * is not something anyone should have to verify by waiting until nine.
 */
function isDue(routine, now = Date.now()) {
  if (!routine.enabled) return false;
  const day = new Date(now).getDay();
  if (routine.days.length && !routine.days.includes(day)) return false;

  const due = scheduledFor(routine, now);
  if (now < due) return false;                      // not yet
  if (now - due > GRACE_MS) return false;           // too late to be worth saying
  if (routine.lastRun && routine.lastRun >= due) return false;  // already ran today
  return true;
}

/** When it will next come round, for showing in the interface. */
function nextRunAt(routine, now = Date.now()) {
  for (let i = 0; i < 8; i++) {
    const probe = new Date(now);
    probe.setDate(probe.getDate() + i);
    probe.setHours(routine.hour, routine.minute, 0, 0);
    const t = probe.getTime();
    if (t <= now) continue;
    if (routine.days.length && !routine.days.includes(probe.getDay())) continue;
    return t;
  }
  return null;
}

function createRoutineRunner({ memory, state, run, log = console.log }) {
  let timer = null;
  let busy = false;

  async function tick() {
    if (busy) return;
    // A routine reads back what fren observed. With the light off there is
    // nothing to read back, and looking anyway would break the invariant.
    if (!state.get().observing) return;

    let due = [];
    try {
      due = memory.getRoutines().filter((r) => isDue(r, Date.now()));
    } catch (err) {
      log(`[routines] could not read routines: ${err.message}`);
      return;
    }
    if (!due.length) return;

    busy = true;
    try {
      for (const routine of due) {
        // Mark it BEFORE running. A routine that fails should not retry every
        // thirty seconds for the rest of its grace window.
        memory.markRoutineRun(routine.id, Date.now(), null);
        try {
          const text = await run(routine);
          if (text) memory.markRoutineRun(routine.id, Date.now(), text);
          // PRIVACY: the routine's name only. Its answer is derived from
          // window titles and does not belong in a log.
          log(`[routines] ran "${routine.name}"`);
        } catch (err) {
          log(`[routines] "${routine.name}" failed: ${err.message}`);
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_MS);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}

module.exports = { createRoutineRunner, isDue, nextRunAt, scheduledFor, GRACE_MS, TICK_MS };
