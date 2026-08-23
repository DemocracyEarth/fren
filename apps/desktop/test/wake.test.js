'use strict';
/**
 * Whether fren is watching when it launches.
 *
 * This is the highest-consequence default in the app: it decides whether
 * capture begins before anyone has said anything this session. The resolution
 * is a pure function so it can be asserted directly, rather than inferred from
 * an Electron boot.
 */
const test = require('node:test');
const assert = require('node:assert');
const { wakeOnLaunchFrom } = require('../main/wake.js');

test('never chosen means awake', () => {
  // Including for everyone who completed setup before the question existed —
  // a read-side default, so there is no migration to get wrong.
  assert.equal(wakeOnLaunchFrom(null), true);
  assert.equal(wakeOnLaunchFrom(undefined), true);
});

test('an explicit choice is honoured in both directions', () => {
  assert.equal(wakeOnLaunchFrom(true), true);
  assert.equal(wakeOnLaunchFrom(false), false);
});

test('only a real false turns it off', () => {
  // The setting round-trips through JSON, so a boolean stays a boolean. But a
  // value that is merely falsy — an empty string from a hand-edited database,
  // a 0 — must not silently read as "start dark" and leave someone wondering
  // why fren stopped waking up.
  assert.equal(wakeOnLaunchFrom(0), false, '0 is a deliberate off');
  assert.equal(wakeOnLaunchFrom('false'), false);
  assert.equal(wakeOnLaunchFrom(''), true, 'an empty value is not a choice');
  assert.equal(wakeOnLaunchFrom('yes'), true);
  assert.equal(wakeOnLaunchFrom(1), true);
});
