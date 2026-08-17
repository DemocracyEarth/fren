// macOS activity observer for the Electron main process. Samples the frontmost
// app/window on an interval and occasionally grabs a downscaled screenshot.
// Privacy invariant: stop() guarantees no further capture, and screenshots are
// written to local disk only — this module never touches the network.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../../../packages/shared');

const LSAPPINFO = '/usr/bin/lsappinfo';
const OSASCRIPT = '/usr/bin/osascript';
const LSAPPINFO_TIMEOUT_MS = 1000;
const OSASCRIPT_TIMEOUT_MS = 1500;
const TITLE_FAILURES_BEFORE_BACKOFF = 3;
const TITLE_BACKOFF_MS = 5 * 60 * 1000; // avoid Accessibility permission-dialog spam

const FRONT_WINDOW_TITLE_SCRIPT =
  'tell application "System Events" to get title of front window of ' +
  '(first application process whose frontmost is true)';

function execFileP(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// -> app name string, or "unknown" on any failure. Needs no permissions.
async function getActiveApp() {
  try {
    const asn = (await execFileP(LSAPPINFO, ['front'], LSAPPINFO_TIMEOUT_MS)).trim();
    if (!asn) return 'unknown';
    const out = await execFileP(
      LSAPPINFO,
      ['info', '-only', 'name', asn],
      LSAPPINFO_TIMEOUT_MS
    );
    const match = out.match(/"name"\s*=\s*"([^"]+)"/); // e.g. "name"="Safari"
    return match ? match[1] : 'unknown';
  } catch (_err) {
    return 'unknown';
  }
}

// -> window title string. Throws on failure (needs macOS Accessibility permission).
async function getWindowTitle() {
  const out = await execFileP(
    OSASCRIPT,
    ['-e', FRONT_WINDOW_TITLE_SCRIPT],
    OSASCRIPT_TIMEOUT_MS
  );
  return out.trim();
}

// Combined sampler, exported for tests. `titleFailed` lets the caller do
// failure bookkeeping without conflating "no title" and "lookup failed".
async function getActiveWindowInfo({ skipTitle = false } = {}) {
  const activeApp = await getActiveApp();
  if (skipTitle) return { activeApp, windowTitle: undefined, titleFailed: false };
  try {
    const title = await getWindowTitle();
    return { activeApp, windowTitle: title || undefined, titleFailed: false };
  } catch (_err) {
    return { activeApp, windowTitle: undefined, titleFailed: true };
  }
}

function createObserver({ onObservation, log = console.error }) {
  let timer = null;
  let ticking = false; // no overlapping ticks if child processes run long
  let sampleCount = 0;
  let titleFailures = 0;
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
        log('observer: screenshots disabled until Screen Recording permission is granted');
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
    if (!timer) return; // stopped mid-tick: drop the sample (privacy invariant)

    if (!skipTitle) {
      if (info.titleFailed) {
        titleFailures += 1;
        if (titleFailures >= TITLE_FAILURES_BEFORE_BACKOFF) {
          titleFailures = 0;
          titleBackoffUntil = Date.now() + TITLE_BACKOFF_MS;
          log('observer: window titles unavailable (Accessibility permission?); pausing title lookups for 5 minutes');
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
      if (!timer) return; // stopped while capturing: never report it
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
