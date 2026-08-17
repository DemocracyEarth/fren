// Periodically turns raw observations into compact semantic memories via the
// gateway, then prunes old observations and screenshot files. Only the
// app/window timeline is sent — screenshots stay on disk, always.
const fs = require('fs');
const { config } = require('../../../packages/shared');
const gateway = require('./gatewayClient');
const state = require('./state');

function createSummarizer({ memory, log = console.log }) {
  let timer = null;
  let running = false;

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      const observations = memory.getUnsummarizedObservations();
      if (observations.length < config.SUMMARIZE_MIN_OBSERVATIONS) return;

      if (state.get().observing) state.set({ mascot: 'thinking' });
      try {
        const summary = await gateway.summarize(
          observations.map(({ ts, activeApp, windowTitle }) => ({ ts, activeApp, windowTitle })),
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
        log(`[summarizer] memory: ${summary.activity} (${observations.length} obs)`);
      } finally {
        if (state.get().mascot === 'thinking') {
          state.set({ mascot: state.get().observing ? 'watching' : 'sleeping' });
        }
      }

      const { screenshotPathsToDelete } = memory.cleanup({
        retentionDays: config.OBSERVATION_RETENTION_DAYS,
        maxScreenshots: config.MAX_SCREENSHOTS_KEPT,
      });
      for (const p of screenshotPathsToDelete) fs.rm(p, { force: true }, () => {});
    } catch (err) {
      log(`[summarizer] skipped: ${err.message}`);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (state.get().observing) runOnce();
      }, config.SUMMARIZE_INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
}

module.exports = { createSummarizer };
