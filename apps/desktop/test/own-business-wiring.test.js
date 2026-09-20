'use strict';
// The chat window is a script nobody can unit-test without a browser, and the
// things that matter most about the own-business layer are about ORDER and
// REACH: the owner's words are read before any model sees them, a card's chip
// can only call entries that exist, and approvals stay a click. Those are
// checked against the source, the way settings-pane.test.js checks the pane.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('renderer/app.js');
const preload = read('preload.js');
const html = read('renderer/index.html');
const mainSide = read('main/own-business.js');
const index = read('main/index.js');

test('the parser is loaded before the chat script, and there is exactly one new door in preload', () => {
  assert.ok(html.indexOf('src="own-business.js"') !== -1, 'index.html loads own-business.js');
  assert.ok(html.indexOf('src="own-business.js"') < html.indexOf('src="app.js"'));
  assert.match(preload, /ownBusiness: \(verb, args, heard\) => ipcRenderer\.invoke\('fren:ownBusiness', verb, args, heard\)/);
  assert.match(index, /ipcMain\.handle\('fren:ownBusiness'/);
});

test('the owner\'s words are read before the scheduling gate and before either model lane', () => {
  const body = app.slice(app.indexOf('async function sendMessage('), app.indexOf('const REDUCED ='));
  const at = (needle) => { const i = body.indexOf(needle); assert.ok(i !== -1, `sendMessage has no ${needle}`); return i; };
  const parsed = at('window.FrenOwnBusiness.parse(question');
  assert.ok(at('if (setup) return handleSetupAnswer') < parsed, 'the interview still comes first');
  assert.ok(parsed < at('looksScheduled(question)'));
  assert.ok(parsed < at('askThroughRuntime(question'));
  assert.ok(parsed < at('window.fren.chat(question)'));
  // Creation only runs when the sentence was NOT fren's own business.
  assert.match(body, /if \(!deed && looksScheduled\(question\)\)/);
  // …and the parser is handed the sentence and the names — nothing a model wrote.
  assert.match(body, /parse\(question, \{ names: ownNames \}\)/);
});

test('every entry a card chip names is on the chat window\'s list, and exists in preload', () => {
  const allowed = /const CHIP_CALLS = new Set\(\[([^\]]+)\]\)/.exec(app)[1].match(/[A-Za-z]+/g);
  for (const name of allowed) assert.match(preload, new RegExp(`\\b${name}: \\(`), `preload has no ${name}`);
  const called = [...mainSide.matchAll(/call: '([A-Za-z]+)'/g)].map((m) => m[1]);
  assert.ok(called.length >= 8);
  for (const name of called) assert.ok(allowed.includes(name), `a chip calls ${name}, which the chat window would refuse`);
  // The management card's chips are the entries that were always there.
  for (const name of ['setRoutineEnabled', 'deleteRoutine', 'patchAgentAutomation', 'deleteAgentAutomation', 'runAgentAutomation']) {
    assert.ok(called.includes(name), `no chip calls ${name}`);
    assert.match(index, new RegExp(`ipcMain\\.handle\\('fren:${name}'`));
  }
  // Nothing a chip can call decides a permission.
  assert.ok(!allowed.includes('decidePermission'));
});

test('open permission requests are fetched when the line comes up, and an error is not a list', () => {
  const fn = app.slice(app.indexOf('async function recoverPermissionCards'), app.indexOf('/** What fren is running, by name'));
  assert.match(fn, /permissionRequests\('open'\)/);
  assert.match(fn, /if \(!Array\.isArray\(open\)\) return;/);
  assert.match(fn, /showPermissionCard\(request\)/);
  assert.match(app, /if \(state\.gatewayOk && !was\.gatewayOk\) \{ recoverPermissionCards\(\);/);
});

test('approvals stay a click: no typed or dictated word reaches decidePermission', () => {
  const calls = [...app.matchAll(/decidePermission\(/g)];
  assert.equal(calls.length, 1, 'decidePermission is called from one place');
  const card = app.slice(app.indexOf('async function showPermissionCard'), app.indexOf('async function recoverPermissionCards'));
  assert.match(card, /decidePermission\(/);
  assert.doesNotMatch(card, /readYesNo/);
});

test('"stop interrupting me" is true at once: the cached profile is read again', () => {
  const fn = app.slice(app.indexOf('async function showOwnReply'), app.indexOf('function drawCard'));
  assert.match(fn, /res\.refresh\.includes\('profile'\)/);
  assert.match(fn, /profile = await window\.fren\.getProfile\(\)/);
  // A card needs a click, so the panel opens for it.
  assert.match(fn, /if \(carded && !state\.panelOpen\) await setPanel\(true\)/);
});

test('nothing fren says points at the big window any more', () => {
  const said = [...app.matchAll(/speak\(\s*`[^`]*`|speak\(\s*'[^']*'|speak\(\s*"[^"]*"/g)].map((m) => m[0]).join('\n');
  assert.doesNotMatch(said, /full window|under Routines|under Automations|automations list|dashboard/i);
  assert.match(app, /Ask me what I'm running/);
});

test('main hands own-business plain functions, not handler bodies', () => {
  for (const fn of ['applyBrowserSettings', 'setOrbColour', 'setWakeOnLaunch', 'setVolunteer', 'listRoutines']) {
    assert.match(index, new RegExp(`function ${fn}\\(`), `${fn} is a function`);
  }
  // The switches that used to call this are gone with their window: asking is
  // the only way in, so there is one caller and no second door to keep in step.
  assert.doesNotMatch(index, /fren:setBrowserSettings/);
  assert.match(index, /ipcMain\.handle\('fren:voice\.remember', \(_e, note\) => rememberNote\(note, 'voice'\)\)/);
  assert.match(index, /setBrowser: applyBrowserSettings/);
  assert.match(index, /remember: \(note\) => rememberNote\(note, 'chat'\)/);
});
