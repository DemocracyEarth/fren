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
  state.set({ observing: true, mascot: 'watching' });
}

function stopObserving() {
  observer.stop();
  state.set({ observing: false, mascot: 'sleeping' });
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

  ipcMain.handle('fren:setPanelOpen', (_e, open) => {
    positionWindow(open ? PANEL_SIZE : ORB_SIZE);
    state.set({ panelOpen: !!open });
  });

  ipcMain.handle('fren:quit', () => app.quit());

  ipcMain.handle('fren:chat', async (_e, text) => {
    const question = String(text ?? '').trim().slice(0, 2000);
    if (!question) return { reply: '…' };
    state.set({ mascot: 'thinking' });
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
      state.set({ mascot: state.get().observing ? 'watching' : 'sleeping' });
    }
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (observer) observer.stop();
  if (summarizer) summarizer.stop();
  if (memory) memory.close();
});
