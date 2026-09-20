// Activity observer for the Electron main process. Runs on macOS, Windows and
// Linux; the platform-specific part lives in active-window.js. Samples the
// frontmost app and its window title on an interval, and nothing else: it used
// to keep a screenshot every few samples for the dashboard's day view, and with
// that window gone nothing could show them, so it no longer takes them. (The one
// picture fren does take is asked for, and lives in screen.js.)
// Privacy invariant: stop() guarantees no further capture, and this module
// never touches the network.
const { config } = require('../../../packages/shared');
const activeWindow = require('./active-window');

const TITLE_FAILURES_BEFORE_BACKOFF = 3;
const TITLE_BACKOFF_MS = 5 * 60 * 1000; // avoid permission-dialog spam

// Sampling the front window is the one genuinely platform-specific thing fren
// does. active-window.js keeps the three implementations apart; the contract
// they share is that the app name degrades to "unknown" while the title THROWS,
// so the back-off below can tell "no title" from "not allowed to read titles".
const getActiveWindowInfo = activeWindow.getActiveWindowInfo;

function createObserver({ onObservation, log = console.error }) {
  let timer = null;
  let ticking = false; // no overlapping ticks if child processes run long
  let titleFailures = 0;
  let unknownApps = 0;
  let titleBackoffUntil = 0;

  async function tick() {
    const ts = Date.now();

    const skipTitle = ts < titleBackoffUntil;
    const info = await getActiveWindowInfo({ skipTitle });

    // Guard against the silent-empty-input failure this app already had once:
    // every sample returning "unknown" means fren is recording nothing usable,
    // and nothing else in the system would ever say so.
    if (info.activeApp === 'unknown') {
      unknownApps += 1;
      if (unknownApps === 10) {
        log('observer: 10 samples in a row could not identify the front app — ' +
            `fren is recording nothing usable. ${activeWindow.permissionHint()}`);
      }
    } else {
      unknownApps = 0;
    }
    if (!timer) return; // stopped mid-tick: drop the sample (privacy invariant)

    if (!skipTitle) {
      if (info.titleFailed) {
        titleFailures += 1;
        if (titleFailures >= TITLE_FAILURES_BEFORE_BACKOFF) {
          titleFailures = 0;
          titleBackoffUntil = Date.now() + TITLE_BACKOFF_MS;
          log(`observer: window titles unavailable — ${activeWindow.permissionHint()}. ` +
              'Pausing title lookups for 5 minutes.');
        }
      } else {
        titleFailures = 0;
      }
    }

    // Self-filter: watching ourselves is noise.
    const appName = info.activeApp.toLowerCase();
    if (appName === 'electron' || appName === 'fren') return;

    const obs = { ts, activeApp: info.activeApp, windowTitle: info.windowTitle };

    onObservation(obs);
  }

  function runTick() {
    if (ticking) return;
    ticking = true;
    tick()
      .catch((err) => log('observer: tick failed: ' + (err && err.message ? err.message : err)))
      .finally(() => {
        ticking = false;
      });
  }

  function start() {
    if (timer) return;
    timer = setInterval(runTick, config.SAMPLE_INTERVAL_MS);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null; // in-flight ticks see this and drop their sample
  }

  function isRunning() {
    return timer !== null;
  }

  return { start, stop, isRunning };
}

module.exports = { createObserver, getActiveWindowInfo };
