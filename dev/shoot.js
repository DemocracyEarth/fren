#!/usr/bin/env electron
// Dev-only: render the real renderer inside Electron and capture the window
// itself (never the desktop), so the UI can be reviewed at pixel fidelity.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const OUT = process.env.FREN_SHOT_OUT || '/tmp/fren-shot.png';
const OPEN = process.env.FREN_SHOT_PANEL !== '0';

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: OPEN ? 360 : 150,
    height: OPEN ? 600 : 150,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'shoot-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'apps', 'desktop', 'renderer', 'index.html'));

  await win.webContents.executeJavaScript(`
    document.documentElement.style.background =
      'linear-gradient(150deg,#4a4550,#211f28 60%,#14131a)';
    ${OPEN ? `
      document.getElementById('panel').hidden = false;
      const m = document.getElementById('messages');
      const t = document.getElementById('typing');
      const e = document.getElementById('empty');
      if (e) e.remove();
      const add = (w, x) => { const b = document.createElement('div');
        b.className = 'bubble ' + w; b.textContent = x; m.insertBefore(b, t); };
      add('user', 'What have I been doing?');
      add('fren', "You've been on the auth flow for about 35 minutes — mostly observer.js in VS Code, with runs back to Chrome to re-test the login redirect.");
    ` : ''}
    'ok';
  `);

  // Let the springs settle into the resting pose before capturing.
  await new Promise((r) => setTimeout(r, 1400));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUT, image.toPNG());
  console.log('wrote ' + OUT);
  app.quit();
});
