'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldGreetOnReturn, MIN_AWAY_MS, MIN_BETWEEN_MS } = require('../main/arrival.js');

test('a return is a return only after a while away, and only once', () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldGreetOnReturn({ awayMs: 2 * 60 * 1000, now }).greet, false, 'a coffee is not a homecoming');
  assert.equal(shouldGreetOnReturn({ awayMs: MIN_AWAY_MS, now }).greet, true);
  assert.equal(shouldGreetOnReturn({ awayMs: 3 * 3600 * 1000, now, lastGreetAt: now - 60 * 1000 }).greet, false, 'wake then unlock is one return');
  assert.equal(shouldGreetOnReturn({ awayMs: 3 * 3600 * 1000, now, lastGreetAt: now - MIN_BETWEEN_MS }).greet, true);
  assert.equal(shouldGreetOnReturn({ awayMs: NaN, now }).greet, false);
  assert.equal(shouldGreetOnReturn({ awayMs: 0, now }).greet, false);
});
