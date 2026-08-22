// Electron main process: creates the mascot window and wires the loop
// observe -> remember -> summarize -> chat. Owns the observation on/off state.
const path = require('path');
const { app, BrowserWindow, ipcMain, screen, protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');
const { config, loadEnv } = require('../../../packages/shared');
const { openMemory } = require('../../../packages/memory');
const state = require('./state');
const gateway = require('./gatewayClient');
const { createObserver } = require('./observer');
const { createSummarizer } = require('./summarizer');
const whisper = require('./whisper');
const soul = require('./soul');

loadEnv();
// The desktop process must never hold provider credentials — only the gateway
// talks to the LLM provider. .env is shared with the gateway, so scrub here.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.ELEVENLABS_API_KEY;

// The renderer is served over a custom scheme rather than loaded from disk.
// ES modules are blocked over file:// as cross-origin, so the 3D face -- which
// is a module, and imports three.js as one -- would silently never load and the
// app would quietly fall back to the SVG renderer. A standard scheme also gives
// the page a real origin, so the existing `script-src 'self'` CSP still applies.
const SCHEME = 'fren';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

function serveRenderer() {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const file = path.resolve(RENDERER_DIR, '.' + decodeURIComponent(pathname));
    // Never serve anything outside the renderer directory.
    if (path.relative(RENDERER_DIR, file).startsWith('..')) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

const ORB_SIZE = { width: 150, height: 150 };
const PANEL_SIZE = { width: 344, height: 578 };
const MARGIN = 24;

let win = null;
let memory = null;
let gazeTimer = null;
let drag = null;
let observer = null;
let summarizer = null;

const log = (...args) => console.log(...args);

function positionWindow(size) {
  // Anchor to the bottom-right corner of the primary display's work area.
  const { workArea } = screen.getPrimaryDisplay();
  win.setBounds({
    x: workArea.x + workArea.width - size.width - MARGIN,
    y: workArea.y + workArea.height - size.height - MARGIN,
    ...size,
  });
}

function createWindow() {
  win = new BrowserWindow({
    ...ORB_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Forward the renderer's voice tracing into the run log, so a hold-to-talk
  // failure can be read afterwards rather than reproduced.
  win.webContents.on('console-message', (...args) => {
    const msg = typeof args[0] === 'object' && args[0] && args[0].message ? args[0].message : args[2];
    if (msg && String(msg).startsWith('[voice]')) log(String(msg));
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(`${SCHEME}://app/index.html`);
  positionWindow(ORB_SIZE);
}

function orbCenter() {
  const b = win.getBounds();
  return { x: b.x + b.width - ORB_SIZE.width / 2, y: b.y + b.height - ORB_SIZE.height / 2 };
}

/**
 * Let fren glance at the pointer, so it reads as paying attention to your
 * work. The cursor position is used for gaze only — never stored, never
 * summarized, never sent anywhere — and it is only sampled while observing,
 * because closed eyes have nothing to follow.
 */
function startGaze() {
  if (gazeTimer) return;
  const FALLOFF = 420;   // px at which the eyes are fully deflected
  let lastX = 0;
  let lastY = 0;
  gazeTimer = setInterval(() => {
    if (!win || win.isDestroyed() || drag) return;
    const c = screen.getCursorScreenPoint();
    const o = orbCenter();
    const nx = Math.max(-1, Math.min(1, (c.x - o.x) / FALLOFF));
    const ny = Math.max(-1, Math.min(1, (c.y - o.y) / FALLOFF));
    if (Math.abs(nx - lastX) < 0.02 && Math.abs(ny - lastY) < 0.02) return;
    lastX = nx;
    lastY = ny;
    win.webContents.send('fren:cursor', { x: nx, y: ny });
  }, 70);
}

function stopGaze() {
  if (gazeTimer) clearInterval(gazeTimer);
  gazeTimer = null;
  if (win && !win.isDestroyed()) win.webContents.send('fren:cursor', null);
}

function startObserving() {
  observer.start();
  startGaze();
  state.set({ observing: true }); // mascot is computed from this
}

function stopObserving() {
  observer.stop();
  stopGaze();
  state.set({ observing: false });
}

app.whenReady().then(() => {
  serveRenderer();
  memory = openMemory(path.join(app.getPath('userData'), 'fren.db'));

  observer = createObserver({
    onObservation: (obs) => memory.addObservation(obs),
    log,
  });
  summarizer = createSummarizer({
    memory,
    log,
    // Every summary also lands in memory/YYYY-MM-DD.md, so a day fren spent
    // with you can be read as a document rather than queried out of SQLite.
    onSummary: (activity, ts) => soul.appendDailyLog(app.getPath('userData'), activity, ts),
  });
  summarizer.start();

  createWindow();

  state.subscribe((s) => {
    if (win && !win.isDestroyed()) win.webContents.send('fren:stateChanged', s);
  });

  const checkHealth = async () => {
    try {
      await gateway.health();
      if (!state.get().gatewayOk) state.set({ gatewayOk: true });
    } catch {
      if (state.get().gatewayOk) state.set({ gatewayOk: false });
    }
  };
  checkHealth();
  setInterval(checkHealth, 30_000);

  ipcMain.handle('fren:getState', () => state.get());

  ipcMain.handle('fren:toggleObservation', () => {
    if (state.get().observing) stopObserving();
    else startObserving();
    return state.get();
  });

  // The orb lives at the window's bottom-right, so the window grows up and to
  // the left: the character stays exactly where the user parked it.
  ipcMain.handle('fren:setPanelOpen', (_e, open) => {
    const cur = win.getBounds();
    const size = open ? PANEL_SIZE : ORB_SIZE;
    const anchorRight = cur.x + cur.width;
    const anchorBottom = cur.y + cur.height;
    const { workArea } = screen.getDisplayMatching(cur);
    const x = Math.min(
      Math.max(anchorRight - size.width, workArea.x),
      workArea.x + workArea.width - size.width
    );
    const y = Math.min(
      Math.max(anchorBottom - size.height, workArea.y),
      workArea.y + workArea.height - size.height
    );
    win.setBounds({ x, y, ...size });
    state.set({ panelOpen: !!open });
  });

  ipcMain.handle('fren:dragStart', () => {
    const cursor = screen.getCursorScreenPoint();
    const b = win.getBounds();
    drag = { dx: cursor.x - b.x, dy: cursor.y - b.y, moved: false, timer: null };
    drag.timer = setInterval(() => {
      if (!drag || !win || win.isDestroyed()) return;
      const c = screen.getCursorScreenPoint();
      const x = c.x - drag.dx;
      const y = c.y - drag.dy;
      const cur = win.getBounds();
      if (Math.abs(x - cur.x) > 2 || Math.abs(y - cur.y) > 2) drag.moved = true;
      win.setPosition(x, y);
    }, 16);
  });

  ipcMain.handle('fren:dragEnd', () => {
    if (!drag) return { moved: false };
    clearInterval(drag.timer);
    const moved = drag.moved;
    drag = null;
    return { moved };
  });

  // Voice. Transcription runs locally: the audio is written to a temp file,
  // handed to whisper.cpp, and deleted. It never touches the network.
  ipcMain.handle('fren:voiceStatus', () => {
    const w = whisper.detect();
    return { stt: w.ready, reason: w.reason || null };
  });

  ipcMain.handle('fren:transcribe', async (_e, bytes) => {
    try {
      const text = await whisper.transcribe(Buffer.from(bytes));
      log(`[voice] transcribed ${bytes.byteLength} bytes -> ${text.length} chars`);
      return { text };
    } catch (err) {
      log(`[voice] transcription failed: ${err.message}`);
      return { error: err.message };
    }
  });

  ipcMain.handle('fren:speak', async (_e, text) => {
    try {
      const audio = await gateway.speak(String(text ?? '').slice(0, 2000));
      return { audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) };
    } catch (err) {
      log(`[voice] speech failed: ${err.message}`);
      return { error: err.message };
    }
  });

  // What the user told fren about themselves during first-run setup. Stored
  // locally in the same SQLite file as everything else; it is sent to the model
  // as chat context and nowhere else.
  ipcMain.handle('fren:getProfile', () => memory.getSetting('profile'));
  ipcMain.handle('fren:setProfile', (_e, profile) => {
    const clean = profile && typeof profile === 'object' ? profile : null;
    memory.setSetting('profile', clean);
    // The interview also becomes fren's character, as Markdown the user can
    // read and edit. Skipping writes nothing: there is no character to define.
    if (clean && clean.name && !clean.skipped) {
      try {
        const p = soul.writeSoul(app.getPath('userData'), clean);
        log(`[setup] wrote ${path.basename(p.soul)} and ${path.basename(p.user)}`);
      } catch (err) {
        log(`[setup] could not write the soul files: ${err.message}`);
      }
    }
    log(`[setup] profile saved (${clean ? Object.keys(clean).join(', ') : 'cleared'})`);
    return memory.getSetting('profile');
  });

  ipcMain.handle('fren:quit', () => app.quit());

  ipcMain.handle('fren:chat', async (_e, text) => {
    const question = String(text ?? '').trim().slice(0, 2000);
    if (!question) return { reply: '…' };
    state.beginWork();
    try {
      const eightHoursAgo = Date.now() - 8 * 60 * 60 * 1000;
      const memories = memory.getRecentMemories({ sinceMs: eightHoursAgo });
      const observations = memory
        .getRecentObservations({ limit: 50 })
        .map(({ ts, activeApp, windowTitle }) => ({ ts, activeApp, windowTitle }));
      const profile = memory.getSetting('profile');
      // Read from disk every time, so editing SOUL.md takes effect on the next
      // message rather than the next launch.
      const character = soul.readContext(app.getPath('userData'));
      const { reply } = await gateway.chat({
        question, memories, observations, profile,
        soul: character.soul, userDoc: character.user,
      });
      return { reply };
    } catch (err) {
      log(`[chat] failed: ${err.message}`);
      return {
        reply:
          "I can't reach my thinking half (the local gateway). Is it running? Try: npm run gateway",
      };
    } finally {
      state.endWork();
    }
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (gazeTimer) clearInterval(gazeTimer);
  if (drag) clearInterval(drag.timer);
  if (observer) observer.stop();
  if (summarizer) summarizer.stop();
  if (memory) memory.close();
});
