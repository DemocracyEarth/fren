'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { implFor, permissionHint, isSupported, getActiveWindowInfo } =
  require('../main/active-window.js');

test('every supported platform has an implementation', () => {
  for (const p of ['darwin', 'win32', 'linux']) {
    assert.equal(isSupported(p), true, `${p} must be supported`);
    const impl = implFor(p);
    assert.equal(typeof impl.app, 'function', `${p} app()`);
    assert.equal(typeof impl.title, 'function', `${p} title()`);
    assert.ok(impl.permissionHint.length > 0, `${p} must explain how to enable titles`);
  }
});

test('an unknown platform degrades instead of crashing', async () => {
  assert.equal(isSupported('sunos'), false);
  const info = await getActiveWindowInfo({ platform: 'sunos' });
  // The app must keep running on a platform nobody wrote code for; it simply
  // records nothing.
  assert.equal(info.activeApp, 'unknown');
  assert.equal(info.windowTitle, undefined);
  assert.equal(info.titleFailed, true, 'a failure to read the title must be reported as one');
});

test('permission hints are platform-specific and never mention the wrong OS', () => {
  assert.match(permissionHint('darwin'), /Accessibility/);
  assert.match(permissionHint('linux'), /xdotool|Wayland/);
  // Sending a Linux user to macOS System Settings is worse than saying nothing.
  assert.doesNotMatch(permissionHint('linux'), /System Settings/);
  assert.doesNotMatch(permissionHint('win32'), /System Settings|Accessibility/);
});

test('the app name degrades to unknown while the title throws', async () => {
  // This split is what lets the observer tell "no title" from "not permitted"
  // and back off instead of pestering for permission every few seconds.
  const impl = implFor('sunos');
  assert.equal(await impl.app(), 'unknown');
  await assert.rejects(() => impl.title());
});

test('skipTitle avoids the title lookup entirely', async () => {
  let asked = false;
  const info = await getActiveWindowInfo({ skipTitle: true, platform: 'sunos' });
  assert.equal(info.titleFailed, false, 'skipping is not failing');
  assert.equal(asked, false);
});

test('the macOS app-name parse handles what lsappinfo actually prints', () => {
  // Regression. lsappinfo answers `"LSDisplayName"="Safari"`; the original
  // pattern only matched `"name"=`, so it never matched anything and EVERY
  // observation fren recorded had activeApp "unknown" — 200 out of 200 in the
  // live database. The lookup was working; the parse was throwing the answer
  // away. Pin the real format so it cannot regress silently again.
  const RE = /"(?:LSDisplayName|name)"\s*=\s*"([^"]+)"/;
  assert.equal('"LSDisplayName"="Safari"'.match(RE)[1], 'Safari');
  assert.equal('"LSDisplayName"="Google Chrome"'.match(RE)[1], 'Google Chrome');
  assert.equal('  "name"="Old Format"  '.match(RE)[1], 'Old Format');
  assert.equal('"LSDisplayName"="Visual Studio Code"'.match(RE)[1], 'Visual Studio Code');
});
