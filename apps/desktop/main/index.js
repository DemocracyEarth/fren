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

const ORB_SIZE = { width: 96, height: 96 };
const PANEL_SIZE = { width: 340, height: 520 };
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

  // Preserve wherever the user dragged the orb: grow/shrink around the
  // current top-left corner (clamped into the current display's work area)
  // instead of teleporting back to the bottom-right default.
  let savedOrbPos = null;
  ipcMain.handle('fren:setPanelOpen', (_e, open) => {
    const cur = win.getBounds();
    if (open) {
      savedOrbPos = { x: cur.x, y: cur.y };
      const { workArea } = screen.getDisplayMatching(cur);
      const x = Math.min(Math.max(cur.x, workArea.x), workArea.x + workArea.width - PANEL_SIZE.width);
      const y = Math.min(Math.max(cur.y, workArea.y), workArea.y + workArea.height - PANEL_SIZE.height);
      win.setBounds({ x, y, ...PANEL_SIZE });
    } else {
      win.setBounds({ ...(savedOrbPos ?? { x: cur.x, y: cur.y }), ...ORB_SIZE });
    }
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
