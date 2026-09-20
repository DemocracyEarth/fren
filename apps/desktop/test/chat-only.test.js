'use strict';
// fren is the orb and its chat, and nothing else. Two things about that can
// only go wrong silently, so they are checked against the source:
//
//  - a call with no handler. `window.fren.x()` with nothing behind it is
//    "No handler registered" at the moment someone clicks, and neither the
//    linter nor any unit test sees across the renderer / preload / main seam;
//  - the retired host-script lane coming back. Its every gate was a click in
//    the window that no longer exists, so main must not be able to run one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function filesUnder(dir, keep) {
  const out = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) out.push(...filesUnder(p, keep));
    else if (keep.test(f.name)) out.push(p);
  }
  return out;
}

/** preload.js as { 'voice.session': { kind: 'invoke', channel: 'fren:voice.session' }, … } */
function preloadEntries() {
  const entries = {};
  let inVoice = false;
  for (const line of read('preload.js').split('\n')) {
    if (/^\s*voice:\s*\{/.test(line)) { inVoice = true; continue; }
    if (inVoice && /^\s*\},/.test(line)) { inVoice = false; continue; }
    const m = /^\s*([A-Za-z]+):\s*\(.*?\)\s*=>\s*ipcRenderer\.(invoke|on)\('([^']+)'/.exec(line);
    if (m) entries[(inVoice ? 'voice.' : '') + m[1]] = { kind: m[2], channel: m[3] };
  }
  return entries;
}

const mainSource = filesUnder(path.join(root, 'main'), /\.js$/).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

test('everything the windows call exists in preload, and everything in preload is answered by main', () => {
  const entries = preloadEntries();
  assert.ok(Object.keys(entries).length > 40, 'preload.js was not parsed');

  const called = new Set();
  for (const f of filesUnder(path.join(root, 'renderer'), /\.(js|html)$/)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bfren\.(voice\.)?([A-Za-z]+)\s*\(/g)) called.add((m[1] || '') + m[2]);
  }
  // A card's chip names its entry as data, so those count as calls too.
  for (const m of read('main/own-business.js').matchAll(/call: '([A-Za-z]+)'/g)) called.add(m[1]);
  for (const name of called) assert.ok(entries[name], `a window calls fren.${name}, which preload does not have`);

  const handled = new Set([...mainSource.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]));
  const sent = new Set([...mainSource.matchAll(/(?:send|sendToOrb)\(\s*'([^']+)'/g)].map((m) => m[1]));
  for (const [name, e] of Object.entries(entries)) {
    if (e.kind === 'invoke') assert.ok(handled.has(e.channel), `preload's ${name} invokes ${e.channel}, which main does not handle`);
    else assert.ok(sent.has(e.channel), `preload's ${name} listens for ${e.channel}, which main never sends`);
  }
});

test('there is no second window to go to, and the chat can be closed from the keyboard', () => {
  for (const f of ['dashboard.html', 'dashboard.js', 'dashboard.css']) {
    assert.ok(!fs.existsSync(path.join(root, 'renderer', f)), `${f} is back`);
  }
  assert.ok(!/openDashboard|dashboard\.html/.test(mainSource), 'main still opens a second window');
  const html = read('renderer/index.html');
  const lights = [...html.matchAll(/class="light"/g)];
  assert.equal(lights.length, 1, 'one light');
  assert.match(html, /id="light-quit"/);
  // Red quits, so something that is not a mouse gesture has to close the chat.
  const app = read('renderer/app.js');
  assert.match(app, /e\.key !== 'Escape'/);
  // And quitting still asks first.
  const quit = mainSource.slice(mainSource.indexOf("ipcMain.handle('fren:quit'"));
  assert.match(quit.slice(0, 600), /showMessageBoxSync\(win,[\s\S]*defaultId: 1[\s\S]*app\.quit\(\)/);
});

test('main cannot run a host script: the lane was retired with the only place it could be approved', () => {
  const index = read('main/index.js');
  assert.ok(!/require\('\.\/executor'\)/.test(index), 'main requires the executor again');
  assert.ok(!/getAutomations\(|runAutomation\b|fren:(approve|schedule|keep|run)Automation\b/.test(index), 'the script lane is back');
});
