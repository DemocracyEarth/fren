// Loads one page, counts the animation frames it actually renders, and reports.
//
// Counting frames is not a nicety: a page that failed to load costs nothing,
// which is indistinguishable from a page that is genuinely cheap. A 404 once
// read as "the SVG face is free". Frames make that failure mode loud.
const { app, BrowserWindow } = require('electron');

const URL_ = process.env.BENCH_URL || 'about:blank';
const WARMUP = Number(process.env.BENCH_WARMUP || 6) * 1000;
const WINDOW = Number(process.env.BENCH_WINDOW || 20) * 1000;

if (process.env.BENCH_REDUCED === '1') {
  app.commandLine.appendSwitch('force-prefers-reduced-motion');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (o) => new Promise((r) => process.stdout.write(JSON.stringify(o) + '\n', r));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 148, height: 148, frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  let status = 0;
  win.webContents.on('did-fail-load', (_e, code, desc) => say({ event: 'loadfail', code, desc }));
  win.webContents.session.webRequest.onCompleted((d) => {
    if (d.resourceType === 'mainFrame') status = d.statusCode;
  });

  await win.loadURL(URL_);
  await sleep(WARMUP);

  // Probe what is actually on the page, then start counting frames.
  const probe = await win.webContents.executeJavaScript(`(() => {
    // PASSIVE. Counting must not itself schedule frames, or every page --
    // including one whose loop has correctly halted -- looks like it is
    // animating, and condition C could never fail.
    window.__f = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => { window.__f++; return raf(cb); };
    return {
      title: document.title,
      svg: document.querySelectorAll('svg').length,
      canvas: document.querySelectorAll('canvas').length,
      bodyChars: document.body ? document.body.textContent.trim().length : -1,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  })()`);

  await say({ event: 'ready', status, ...probe });
  await sleep(WINDOW);
  const frames = await win.webContents.executeJavaScript('window.__f');
  await say({ event: 'done', frames, fps: +(frames / (WINDOW / 1000)).toFixed(1) });
  // Stay alive until the orchestrator has sampled the process tree and tells
  // us to go. Exiting here would delete the very thing being measured.
  process.stdin.on('data', () => app.exit(0));
  process.stdin.resume();
});
app.on('window-all-closed', () => app.quit());
