#!/usr/bin/env electron
// Dev-only: render every emotion in one grid and capture it, so the whole
// expressive range can be reviewed at a glance.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const OUT = process.env.FREN_SHEET_OUT || '/tmp/fren-emotions.png';
const RENDERER = path.join(__dirname, '..', 'apps', 'desktop', 'renderer');
const COLS = Number(process.env.FREN_SHEET_COLS) || 6;
// Count the emotions from the source rather than hardcoding it, or the grid
// silently crops whenever the set grows.
const COUNT = (fs
  .readFileSync(path.join(__dirname, '..', 'apps', 'desktop', 'renderer', 'face', 'face.js'), 'utf8')
  .match(/const ORDER = \[([\s\S]*?)\];/)[1]
  .match(/'[a-z]+'/g) || []).length;
const SIZE = Number(process.env.FREN_SHEET_SIZE) || 150;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const cell = SIZE + 42;
  const rows = Math.ceil(COUNT / COLS);
  const width = COLS * cell + 48;
  const height = rows * cell + 96;

  const html = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="file://${path.join(RENDERER, 'tokens.css')}">
<style>
  body { margin:0; padding:24px; background:#0B0B0D; font-family:var(--font); }
  h1 { margin:0 0 18px 2px; font-size:17px; color:var(--on-dark); letter-spacing:-.01em; }
  h1 b { color:var(--orange); }
  .grid { display:grid; grid-template-columns:repeat(${COLS}, ${cell}px); }
  .cell { text-align:center; }
  .name { margin-top:2px; font-size:12.5px; color:var(--on-dark-soft); }
</style>
<h1><b>fren</b> — the emotional range</h1>
<div class="grid" id="g"></div>
<script src="file://${path.join(RENDERER, 'face', 'face.js')}"></script>
<script>
  const { Face, ORDER } = window.FrenFace;
  const g = document.getElementById('g');
  for (const name of ORDER) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const mount = document.createElement('div');
    cell.appendChild(mount);
    const label = document.createElement('div');
    label.className = 'name';
    label.textContent = name;
    cell.appendChild(label);
    g.appendChild(cell);
    const f = new Face(mount, { size: ${SIZE} });
    f.set(name, { immediate: true });
    if (name === 'talking') f.startTalking();
  }
</script>`;

  const file = path.join(os.tmpdir(), 'fren-sheet.html');
  fs.writeFileSync(file, html);

  const win = new BrowserWindow({
    width, height, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(file);
  // Let the idle animations breathe so particles and blinks are represented.
  await new Promise((r) => setTimeout(r, 1800));
  fs.writeFileSync(OUT, (await win.webContents.capturePage()).toPNG());
  console.log(`wrote ${OUT} (${width}x${height})`);
  app.quit();
});
