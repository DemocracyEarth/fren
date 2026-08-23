#!/usr/bin/env electron
// Dev-only: render the real renderer inside Electron and capture the window
// itself (never the desktop), so the UI can be reviewed at pixel fidelity.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');

// Same custom scheme the real app uses. Loading from file:// would block the
// ES modules and quietly capture the SVG fallback instead of what ships.
const RENDERER_DIR = path.join(__dirname, '..', 'apps', 'desktop', 'renderer');
protocol.registerSchemesAsPrivileged([{
  scheme: 'fren',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

const OUT = process.env.FREN_SHOT_OUT || '/tmp/fren-shot.png';
const OPEN = process.env.FREN_SHOT_PANEL !== '0';

// The orb renders with WebGL now, so leave the GPU alone -- software
// rasterising it would not be representative of what ships.
if (process.env.FREN_SHOT_SOFTWARE === '1') app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    // Match ORB_SIZE / PANEL_SIZE in apps/desktop/main/index.js, or the
    // capture clips the very thing it is meant to show.
    width: OPEN ? 344 : 150,
    height: OPEN ? 578 : 150,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'shoot-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  protocol.handle('fren', async (request) => {
    const { pathname } = new URL(request.url);
    const file = path.resolve(RENDERER_DIR, '.' + decodeURIComponent(pathname));
    if (path.relative(RENDERER_DIR, file).startsWith('..')) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
  await win.loadURL('fren://app/index.html');

  await win.webContents.executeJavaScript(`
    document.documentElement.style.background =
      'linear-gradient(150deg,#4a4550,#211f28 60%,#14131a)';
    ${OPEN ? `
      document.getElementById('panel').hidden = false;
      const m = document.getElementById('messages');
      const t = document.getElementById('typing');
      const e = document.getElementById('empty');
      // FREN_SHOT_EMPTY captures the first thing a new user sees, so the
      // seeded conversation has to be skipped entirely rather than deleted
      // afterwards — removing the bubbles cannot bring #empty back.
      if (${JSON.stringify(process.env.FREN_SHOT_EMPTY !== '1')}) {
        if (e) e.remove();
        const add = (w, x) => { const b = document.createElement('div');
          b.className = 'bubble ' + w; b.textContent = x; m.insertBefore(b, t); };
        add('user', 'What have I been doing?');
        add('fren', "You've been on the auth flow for about 35 minutes — mostly observer.js in VS Code, with runs back to Chrome to re-test the login redirect.");
      }
    ` : ''}
    'ok';
  `);

  // Let the springs settle into the resting pose before capturing.
  await new Promise((r) => setTimeout(r, 1400));
  // Report which renderer actually took over, so a silent fallback to the SVG
  // face cannot masquerade as a successful 3D capture.
  if (process.env.FREN_SHOT_VIEW) {
    await win.webContents.executeJavaScript(
      `document.querySelector('.tab[data-view="${process.env.FREN_SHOT_VIEW}"]').click()`);
    await new Promise((r) => setTimeout(r, 900));
  }

  if (process.env.FREN_SHOT_CLICK) {
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(process.env.FREN_SHOT_CLICK)}))?.click()`);
    await new Promise((r) => setTimeout(r, 1200));
  }

  if (process.env.FREN_SHOT_SCROLL) {
    await win.webContents.executeJavaScript(
      `document.getElementById('patterns').scrollTop = ${Number(process.env.FREN_SHOT_SCROLL)}`);
    await new Promise((r) => setTimeout(r, 400));
  }

  if (process.env.FREN_SHOT_KNOW === '1') {
    await win.webContents.executeJavaScript("document.getElementById('what-i-know').click()");
    await new Promise((r) => setTimeout(r, 900));
  }

  console.log('renderer', await win.webContents.executeJavaScript(
    "JSON.stringify({renderer:(window.FrenFace&&window.FrenFace.renderer)||'MODULE DID NOT RUN'," +
    "canvas:document.querySelectorAll('#orb canvas').length," +
    "svg:document.querySelectorAll('#orb svg').length})"));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUT, image.toPNG());
  console.log('wrote ' + OUT);
  app.quit();
});
