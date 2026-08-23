'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isDue, nextRunAt, GRACE_MS } = require('../main/routines.js');

const at = (day, h, m = 0) => new Date(2026, 7, day, h, m, 0, 0).getTime();
const routine = (o = {}) => ({
  id: 1, name: 'recap', prompt: 'what happened?',
  hour: 9, minute: 0, days: [], enabled: true, lastRun: null, ...o,
});

// 2026-08-20 is a Thursday (day 4); 2026-08-22 is a Saturday (day 6).

test('runs at its time, and not before', () => {
  assert.equal(isDue(routine(), at(20, 8, 59)), false, 'a minute early is not due');
  assert.equal(isDue(routine(), at(20, 9, 0)), true);
  assert.equal(isDue(routine(), at(20, 9, 20)), true, 'still worth saying 20 minutes late');
});

test('a missed routine expires rather than arriving hours later', () => {
  // If the machine was asleep at nine, a morning recap at half past two is
  // noise. This is the whole reason for the grace window.
  const now = at(20, 9, 0) + GRACE_MS + 60000;
  assert.equal(isDue(routine(), now), false);
});

test('it runs once, not every tick inside its window', () => {
  const ran = at(20, 9, 0);
  assert.equal(isDue(routine({ lastRun: ran }), at(20, 9, 1)), false);
  assert.equal(isDue(routine({ lastRun: ran }), at(20, 9, 25)), false);
  // But tomorrow is a different day and it should come round again.
  assert.equal(isDue(routine({ lastRun: ran }), at(21, 9, 0)), true);
});

test('day restrictions are honoured', () => {
  const weekdays = routine({ days: [1, 2, 3, 4, 5] });
  assert.equal(isDue(weekdays, at(20, 9)), true, 'Thursday is a weekday');
  assert.equal(isDue(weekdays, at(22, 9)), false, 'Saturday is not');
  const fridays = routine({ days: [5] });
  assert.equal(isDue(fridays, at(21, 9)), true);
  assert.equal(isDue(fridays, at(20, 9)), false);
});

test('a disabled routine never runs', () => {
  assert.equal(isDue(routine({ enabled: false }), at(20, 9)), false);
});

test('nextRunAt skips to the next allowed day', () => {
  // Saturday evening, a weekdays-only routine: next is Monday morning.
  const next = nextRunAt(routine({ days: [1, 2, 3, 4, 5] }), at(22, 20));
  const d = new Date(next);
  assert.equal(d.getDay(), 1, 'Monday');
  assert.equal(d.getHours(), 9);
  assert.equal(d.getDate(), 24);
});

test('nextRunAt rolls to tomorrow once today has passed', () => {
  const next = nextRunAt(routine(), at(20, 14));
  assert.equal(new Date(next).getDate(), 21);
});

test('nextRunAt gives today when the time is still ahead', () => {
  const next = nextRunAt(routine(), at(20, 7));
  assert.equal(new Date(next).getDate(), 20);
  assert.equal(new Date(next).getHours(), 9);
});
