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
  // Reading is pure and happens at the top; DOING anything about it waits for the interview.
  assert.ok(at('if (setup) return handleSetupAnswer') < at('window.fren.ownBusiness(deed.verb'), 'the interview still comes first');
  assert.ok(parsed < at('looksScheduled(question)'));
  assert.ok(parsed < at('askThroughRuntime(question'));
  assert.ok(parsed < at('window.fren.chat(question)'));
  // Creation only runs when the sentence was NOT fren's own business.
  assert.match(body, /if \(!deed && looksScheduled\(question\)\)/);
  // …and the parser is handed the sentence and the names — nothing a model wrote.
  assert.match(body, /parse\(question, \{ names: ownNames \}\)/);
});

test('an instruction to fren never answers a waiting proposal', () => {
  // "please stop watching" opens with a yes-word and "don't read this site"
  // with a no-word: read as answers, the first KEEPS an unattended automation
  // and both lose the instruction.
  const body = app.slice(app.indexOf('async function sendMessage('), app.indexOf('const REDUCED ='));
  assert.ok(body.indexOf('window.FrenOwnBusiness.parse(question') < body.indexOf('if (pendingProposal)'));
  assert.match(body, /const answer = deed \? null : readYesNo\(question\);/);
  // …and the sentences in question really are deeds.
  const OB = require('../renderer/own-business.js');
  for (const s of ['please stop watching', 'ok stop watching', 'okay pause', 'please go dark', "don't read this site", 'do not read github.com', 'skip github.com', "don't interrupt me", 'cancel my stretch reminder']) {
    assert.ok(OB.parse(s), `"${s}" is an instruction`);
  }
  // Wiping the conversation lets a proposal go with its bubble.
  const wipe = app.slice(app.indexOf("c.then === 'wipe'"), app.indexOf('if (c.done)'));
  assert.match(wipe, /if \(pendingProposal\) pendingProposal\.settle\(\{ keep: false, answer: false \}\);/);
});

test('a typed message leaves the box, and a queued one is not shown twice', () => {
  const body = app.slice(app.indexOf('async function sendMessage('), app.indexOf('const REDUCED ='));
  assert.match(body, /if \(text === undefined\) els\.input\.value = '';/);
  assert.match(body, /if \(!shown\) addBubble\('user', question\);/);
  assert.match(body, /sendMessage\(next, \{ shown: true \}\)/);
});

test('the transcript is loaded before anything can write a bubble, and only once at a time', () => {
  // The panel fills only while EMPTY, so a hello, a recovered permission card
  // or a spoken turn written first would keep yesterday's conversation out.
  const init = app.slice(app.indexOf('(async function init()'));
  const load = init.indexOf('await loadPanelHistory();');
  assert.ok(load !== -1, 'init loads the transcript');
  const firstListener = init.search(/window\.fren\.on[A-Z]|window\.fren\.greeting\(|window\.fren\.getState\(|voiceStatus\(/);
  assert.ok(load < firstListener, 'before any subscription, the greeting and the first render');
  assert.match(app, /if \(!historyLoading\) historyLoading = fillPanelFromDisk\(\)\.finally/);
});

test('the quiet voice gives way to the owner, and fren does not talk over it', () => {
  assert.match(app, /function hush\(\) \{ if \(quietVoice && audioStop\) audioStop\(\); \}/);
  const startsWithHush = (name) => new RegExp(`async function ${name}\\([^)]*\\) \\{\\n(?:  vlog\\([^\\n]*\\n)?  hush\\(\\);`).test(app);
  assert.ok(startsWithHush('startTalking'), 'dictation stops it');
  assert.ok(startsWithHush('speak'), 'a reply stops it');
  const starts = [...app.matchAll(/voice\.start\(\)/g)].length;
  const guarded = [...app.matchAll(/hush\(\);\s*voice\.start\(\)/g)].length;
  assert.equal(starts - guarded, 1, 'every line the owner opens by hand hushes first; the wake word refuses instead');
  assert.match(app, /if \(busyForSpeech\(\) \|\| quietVoice\) later\.push\(fn\);/);
  assert.match(app, /if \(!message \|\| speaking \|\| awaitingReply \|\| quietVoice \|\| voiceActive\(\)\)/);
});

test('on the spoken line fren obeys only what makes it see or say less', () => {
  const fn = app.slice(app.indexOf('async function obeySpoken'), app.indexOf('/** What fren is running, by name'));
  assert.ok(fn.indexOf('reducesOnly(deed)) return null') < fn.indexOf('window.fren.ownBusiness('), 'checked before anything is done');
  assert.match(fn, /ownBusiness\(deed\.verb, deed\.args\);/, 'no `heard`: the line writes its own transcript');
  const session = read('renderer/voice-session.js');
  assert.match(session, /if \(role === 'user' && heard\)/, "never fren's own words");
  assert.match(app, /heard: obeySpoken,/);
});

test('a passing note hands a held suggestion its note back', () => {
  assert.match(app, /hintNote = pendingSuggestion \? SUGGESTION_NOTE : null;/);
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
