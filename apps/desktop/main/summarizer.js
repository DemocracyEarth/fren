// Periodically turns raw observations into compact semantic memories via the
// gateway, and prunes old observations and screenshot files. Only the
// app/window timeline is sent — screenshots stay on disk, always.
const fs = require('fs');
const { config } = require('../../../packages/shared');
const gateway = require('./gatewayClient');
const state = require('./state');

function createSummarizer({ memory, log = console.log, onSummary = null }) {
  let timer = null;
  let running = false;

  // Retention runs unconditionally — pausing observation or losing the
  // gateway must never suspend the data-retention promise.
  function runCleanup() {
    try {
      const { deletedObservations, screenshotPathsToDelete } = memory.cleanup({
        retentionDays: config.OBSERVATION_RETENTION_DAYS,
        maxScreenshots: config.MAX_SCREENSHOTS_KEPT,
      });
      for (const p of screenshotPathsToDelete) fs.rm(p, { force: true }, () => {});
      if (deletedObservations > 0 || screenshotPathsToDelete.length > 0) {
        log(
          `[summarizer] pruned ${deletedObservations} observations, ` +
            `${screenshotPathsToDelete.length} screenshot files`
        );
      }
    } catch (err) {
      log(`[summarizer] cleanup failed: ${err.message}`);
    }
  }

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      const observations = memory.getUnsummarizedObservations();
      if (observations.length < config.SUMMARIZE_MIN_OBSERVATIONS) return;

      state.beginWork();
      try {
        const summary = await gateway.summarize(
          observations.map(({ ts, activeApp, windowTitle }) => ({ ts, activeApp, windowTitle }))
        );
        memory.addMemory({
          tsStart: observations[0].ts,
          tsEnd: observations[observations.length - 1].ts,
          activity: summary.activity,
          apps: summary.applications,
          confidence: summary.confidence,
          rawCount: observations.length,
        });
        memory.markSummarized(observations.map((o) => o.id));
        // Also append it to today's Markdown log, so the day is readable
        // without a database client. Best-effort: a failed write here must
        // never cost the memory that was just stored.
        if (typeof onSummary === 'function') {
          try { onSummary(summary.activity, observations[0].ts); }
          catch (err) { log(`[summarizer] daily log write failed: ${err.message}`); }
        }
        // PRIVACY: counts only — the activity text is derived from window
        // titles and must not end up in logs.
        log(`[summarizer] created a memory from ${observations.length} observations`);
        state.flashIdea();
      } finally {
        state.endWork();
      }
    } catch (err) {
      log(`[summarizer] skipped: ${err.message}`);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      runCleanup();
      timer = setInterval(() => {
        runCleanup();
        if (state.get().observing) runOnce();
      }, config.SUMMARIZE_INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runOnce,
    runCleanup,
  };
}

module.exports = { createSummarizer };
