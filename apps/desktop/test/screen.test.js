'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// These assert a PROMISE, not an implementation. docs/privacy.md says nothing
// automatic takes a picture of the screen; the screen-look feature sends one on
// request. Both can be true only while the two paths stay separate, so the
// separation is what is tested.

const mainDir = path.join(__dirname, '..', 'main');
const observer = fs.readFileSync(path.join(mainDir, 'observer.js'), 'utf8');
const screen = fs.readFileSync(path.join(mainDir, 'screen.js'), 'utf8');
const index = fs.readFileSync(path.join(mainDir, 'index.js'), 'utf8');

test('the observer takes no pictures, and never transmits what it samples', () => {
  // App names and window titles, handed to main. If this ever gains a capture
  // or a gateway call, the promise in docs/privacy.md has quietly become false.
  assert.ok(!/desktopCapturer|toJPEG|writeFileSync/.test(observer), 'observer.js must not capture the screen');
  assert.ok(!/gateway\./.test(observer), 'observer.js must not call the gateway');
  assert.ok(!/vision|toJPEG\(\)\.toString\(.base64.\)/.test(observer),
    'observer.js must not base64 a capture for sending');
});

test('the on-request capture never writes to disk', () => {
  // The opposite promise: this one is transmitted, so it must not accumulate.
  assert.ok(!/writeFileSync|appendFileSync|createWriteStream/.test(screen),
    'screen.js must not persist an image it is about to transmit');
  assert.match(screen, /base64/, 'it does need to encode for transport');
});

test('looking at the screen is refused while fren is paused', () => {
  const handler = index.slice(index.indexOf("ipcMain.handle('fren:lookAtScreen'"));
  const body = handler.slice(0, handler.indexOf('ipcMain.handle', 10));
  assert.match(body, /state\.get\(\)\.observing/,
    'looking with the light off is exactly what the light rules out');
});

test('the capture is bounded in size', () => {
  const { MAX_WIDTH } = require('../main/screen.js');
  assert.ok(MAX_WIDTH > 0 && MAX_WIDTH <= 1600, 'a screenshot should not be an expensive way to ask');
});
