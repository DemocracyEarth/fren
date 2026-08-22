// Activity observer for the Electron main process. Runs on macOS, Windows and
// Linux; the platform-specific part lives in active-window.js. Samples the frontmost
// app/window on an interval and occasionally grabs a downscaled screenshot.
// Privacy invariant: stop() guarantees no further capture, and screenshots are
// written to local disk only — this module never touches the network.
const fs = require('node:fs');
const path = require('node:path');
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
  let sampleCount = 0;
  let titleFailures = 0;
  let unknownApps = 0;
  let titleBackoffUntil = 0;
  let warnedNoScreenPermission = false;
  let screenshotDirMade = false;

  // Electron is required lazily so the child-process helpers above stay
  // loadable (and testable) under plain Node.
  async function captureScreenshot(ts) {
    const { desktopCapturer, systemPreferences, app } = require('electron');
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      if (!warnedNoScreenPermission) {
        warnedNoScreenPermission = true;
        // One throwaway capture attempt so macOS registers the app in the
        // Screen Recording privacy pane (and prompts on newer macOS).
        // getMediaAccessStatus alone never triggers registration.
        try {
          await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1, height: 1 },
          });
        } catch (_err) {
          // expected while permission is missing
        }
        log(
          'observer: screenshots disabled — ' +
            (process.platform === 'darwin'
              ? 'enable Screen Recording for this app in System Settings > ' +
                'Privacy & Security, then restart fren'
              : 'the system refused a screen capture')
        );
      }
      return undefined;
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: config.SCREENSHOT_MAX_WIDTH,
        height: Math.round(config.SCREENSHOT_MAX_WIDTH * 0.72),
      },
    });
    if (!timer) return undefined; // stopped while the capture was in flight
    const thumbnail = sources && sources[0] && sources[0].thumbnail;
    if (!thumbnail || thumbnail.isEmpty()) return undefined;

    const dir = path.join(app.getPath('userData'), 'screenshots');
    if (!screenshotDirMade) {
      fs.mkdirSync(dir, { recursive: true });
      screenshotDirMade = true;
    }
    const file = path.join(dir, ts + '.jpg');
    fs.writeFileSync(file, thumbnail.toJPEG(config.SCREENSHOT_JPEG_QUALITY));
    return file;
  }

  async function tick() {
    const ts = Date.now();
    sampleCount += 1;

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

    if (sampleCount % config.SCREENSHOT_EVERY_N_SAMPLES === 0) {
      const screenshotPath = await captureScreenshot(ts);
      if (!timer) {
        // Stopped while capturing: never report it, and never keep an
        // untracked file that retention could not reach.
        if (screenshotPath) fs.rmSync(screenshotPath, { force: true });
        return;
      }
      if (screenshotPath) obs.screenshotPath = screenshotPath;
    }

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
