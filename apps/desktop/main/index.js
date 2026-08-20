// Electron main process: creates the mascot window and wires the loop
// observe -> remember -> summarize -> chat. Owns the observation on/off state.
const path = require('path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { config, loadEnv } = require('../../../packages/shared');
const { openMemory } = require('../../../packages/memory');
const state = require('./state');
const gateway = require('./gatewayClient');
const { createObserver } = require('./observer');
const { createSummarizer } = require('./summarizer');

loadEnv();
// The desktop process must never hold provider credentials — only the gateway
// talks to the LLM provider. .env is shared with the gateway, so scrub here.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const ORB_SIZE = { width: 128, height: 128 };
const PANEL_SIZE = { width: 344, height: 566 };
const MARGIN = 24;

let win = null;
let memory = null;
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
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  positionWindow(ORB_SIZE);
}

function startObserving() {
  observer.start();
  state.set({ observing: true }); // mascot is computed from this
}

function stopObserving() {
  observer.stop();
  state.set({ observing: false });
}

app.whenReady().then(() => {
  memory = openMemory(path.join(app.getPath('userData'), 'fren.db'));

  observer = createObserver({
    onObservation: (obs) => memory.addObservation(obs),
    log,
  });
  summarizer = createSummarizer({ memory, log });
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
      const { reply } = await gateway.chat({ question, memories, observations });
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
  if (observer) observer.stop();
  if (summarizer) summarizer.stop();
  if (memory) memory.close();
});
