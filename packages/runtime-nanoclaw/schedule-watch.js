'use strict';
/**
 * Fires FREN did not start, read off the host's task list.
 *
 * The host fires a scheduled task on its own clock and tells nobody. Its
 * task list is the record: one live row per series (the next occurrence and
 * its time), a count of completed and of failed occurrences, and whether the
 * series is paused. Read every few seconds and compared with the previous
 * reading, that record yields what FREN wants to know:
 *
 *   fired    the live row's time has passed and it is still pending: the
 *            host picks it up at its next sweep. Its row id is watched for
 *            the acknowledgement like a run FREN started, so the run ends
 *            exactly and whatever the agent sends lands on it.
 *   settled  a counter moved while a fired run was still open: the run
 *            ended and the acknowledgement never reached us.
 *   missed   a counter moved with no run open: a fire came and went out of
 *            sight (FREN was down, or the row was never seen due).
 *   paused   the series is paused and the host says why: it gave up on it
 *            after repeated failures.
 *
 * Runs the host saw to the end move the counters too, a sweep later. Each
 * such end is remembered and the next counter move it explains is absorbed,
 * so one fire is never two records. A remembered end that nothing explains
 * within ten minutes is forgotten. An end FREN decided on its own (a cancel,
 * a stop) is only released: the row is let go of, and what the host does
 * with it is still reported. A row the host gives a new time to (a retry
 * after a restart, a backoff) is a new attempt, whatever ended it before.
 *
 * `observe`, `remember` and `release` are pure over a Map of readings; the
 * loop around them is `createScheduleWatch`.
 */
const POLL_MS = 15_000;
/** How long a remembered end may wait for the counters to catch up. */
const ABSORB_MS = 10 * 60 * 1000;

function fresh() {
  return { partial: true, open: null, settledRow: null, pending: [], pausedReported: false };
}

/**
 * Compare the schedules the host lists now with the last reading.
 * @param {Map<string, object>} last  series id -> reading; updated in place
 * @param {Array<object>} schedules   what listSchedules returned
 * @param {number} now
 * @returns {Array<object>} findings, in the order they should be acted on
 */
function observe(last, schedules, now) {
  const findings = [];
  for (const s of schedules) {
    const seriesId = s.id;
    const rowId = (s.runtimeRef && s.runtimeRef.rowId) || seriesId;
    const prev = last.get(seriesId) || fresh();
    const next = {
      rowId, paused: !s.enabled, nextRunAt: s.nextRunAt || null,
      runs: Number(s.runs || 0), failedRuns: Number(s.failedRuns || 0),
      open: prev.open, settledRow: prev.settledRow, pausedReported: prev.pausedReported,
      pending: prev.pending.filter((p) => now - p.at < ABSORB_MS),
    };

    if (!prev.partial) {
      let completed = Math.max(0, next.runs - prev.runs);
      let failed = Math.max(0, next.failedRuns - prev.failedRuns);
      // Ends FREN already saw explain counter moves: like for like first, then any.
      const takeExact = (ok) => { const i = next.pending.findIndex((p) => p.ok === ok); if (i < 0) return false; next.pending.splice(i, 1); return true; };
      while (completed > 0 && takeExact(true)) completed -= 1;
      while (failed > 0 && takeExact(false)) failed -= 1;
      while (completed > 0 && next.pending.length) { next.pending.shift(); completed -= 1; }
      while (failed > 0 && next.pending.length) { next.pending.shift(); failed -= 1; }
      if ((completed > 0 || failed > 0) && next.open) {
        const ok = failed === 0;
        findings.push({ kind: 'settled', seriesId, rowId: next.open, ok });
        next.settledRow = next.open;
        next.open = null;
        if (ok) completed -= 1; else failed -= 1;
      }
      for (; completed > 0; completed -= 1) findings.push({ kind: 'missed', seriesId, ok: true });
      for (; failed > 0; failed -= 1) findings.push({ kind: 'missed', seriesId, ok: false });
    }

    // The same occurrence, given a new time by the host: a new attempt.
    if (!prev.partial && prev.rowId === rowId && prev.nextRunAt !== next.nextRunAt && next.settledRow === rowId) next.settledRow = null;

    const due = !next.paused && next.nextRunAt !== null && next.nextRunAt <= now;
    if (due && next.open !== rowId && next.settledRow !== rowId) {
      next.open = rowId;
      findings.push({ kind: 'fired', seriesId, rowId });
    }

    if (next.paused) {
      if (!next.pausedReported && s.pausedByRuntime) {
        findings.push({ kind: 'paused', seriesId, detail: s.pausedByRuntime });
        next.pausedReported = true;
      }
    } else {
      next.pausedReported = false;
    }
    last.set(seriesId, next);
  }
  // A series not listed is between an acknowledgement and the next sweep, or
  // gone. Its reading stays so an open run can still settle; deletes forget it.
  return findings;
}

/** The host confirmed the end of a run of this series; its counter move is spoken for. */
function remember(last, seriesId, rowId, ok, now) {
  const r = last.get(seriesId) || fresh();
  if (r.settledRow === rowId) return; // observe() already took this end off the counters
  if (r.open === rowId) r.open = null;
  r.settledRow = rowId;
  r.pending.push({ at: now, ok });
  last.set(seriesId, r);
}

/** FREN let go of a run of this series without hearing from the host; the row is not re-fired as it stands. */
function release(last, seriesId, rowId) {
  const r = last.get(seriesId) || fresh();
  if (r.open === rowId) r.open = null;
  r.settledRow = rowId;
  last.set(seriesId, r);
}

function createScheduleWatch({ list, onFinding, ready = () => true, now = Date.now, log = () => {}, intervalMs = POLL_MS }) {
  const last = new Map();
  let timer = null;
  let busy = false;

  async function poll() {
    if (busy || !ready()) return;
    busy = true;
    try {
      const findings = observe(last, await list(), now());
      for (const f of findings) {
        try { await onFinding(f); } catch (err) { log(`[runtime] schedule ${f.kind}: ${err.message}`); }
      }
    } catch (err) {
      log(`[runtime] schedule watch: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void poll(); }, intervalMs);
      if (timer.unref) timer.unref();
      void poll();
    },
    stop() {
      clearInterval(timer);
      timer = null;
      last.clear();
    },
    settled(seriesId, rowId, ok) { remember(last, seriesId, rowId, ok, now()); },
    release(seriesId, rowId) { release(last, seriesId, rowId); },
    forget(seriesId) { last.delete(seriesId); },
    poll,
  };
}

module.exports = { observe, remember, release, createScheduleWatch, POLL_MS, ABSORB_MS };
