'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCron, nextCron, firesPerDay, describeCron } = require('../cron');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const local = (ms) => {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};

// 2026-09-02 is a Wednesday.

test('every day at nine', () => {
  const next = nextCron('0 9 * * *', at(2026, 9, 2, 8, 30));
  assert.deepEqual(local(next), [2026, 9, 2, 9, 0]);
  const after = nextCron('0 9 * * *', at(2026, 9, 2, 9, 0));
  assert.deepEqual(local(after), [2026, 9, 3, 9, 0], 'strictly after: the same minute does not count');
});

test('weekdays only skip the weekend', () => {
  // Friday 2026-09-04 at 10:00 -> Monday 2026-09-07 at 09:00
  const next = nextCron('0 9 * * 1-5', at(2026, 9, 4, 10, 0));
  assert.deepEqual(local(next), [2026, 9, 7, 9, 0]);
});

test('names and steps parse', () => {
  assert.deepEqual(local(nextCron('*/15 * * * *', at(2026, 9, 2, 8, 3))), [2026, 9, 2, 8, 15]);
  assert.deepEqual(local(nextCron('30 18 * * fri', at(2026, 9, 2, 8, 0))), [2026, 9, 4, 18, 30]);
  assert.deepEqual(local(nextCron('0 0 1 jan *', at(2026, 9, 2, 8, 0))), [2027, 1, 1, 0, 0]);
});

test('day-of-month and day-of-week together mean either, like cron', () => {
  // The 1st is a Tuesday in Sep 2026; "1st or every Friday" from the 2nd -> Friday the 4th.
  assert.deepEqual(local(nextCron('0 9 1 * 5', at(2026, 9, 2, 8, 0))), [2026, 9, 4, 9, 0]);
});

test('sunday is 0 and 7', () => {
  const a = nextCron('0 9 * * 0', at(2026, 9, 2));
  const b = nextCron('0 9 * * 7', at(2026, 9, 2));
  assert.equal(a, b);
  assert.deepEqual(local(a), [2026, 9, 6, 9, 0]);
});

test('impossible dates give null rather than a hang', () => {
  assert.equal(nextCron('0 9 31 feb *', at(2026, 9, 2)), null);
});

test('bad expressions are rejected with a code', () => {
  for (const bad of ['', '* * * *', '60 * * * *', 'a b c d e', '0 9 * * 8', '0-1-2 * * * *', '*/0 * * * *']) {
    assert.throws(() => parseCron(bad), (err) => err.code === 'INVALID_CRON', bad);
  }
});

test('fires per day bounds the schedule', () => {
  assert.equal(firesPerDay('0 9 * * *'), 1);
  assert.equal(firesPerDay('0 9,18 * * *'), 2);
  assert.equal(firesPerDay('*/15 * * * *'), 96);
});

test('describes the common shapes', () => {
  assert.equal(describeCron('0 9 * * *'), 'every day at 09:00');
  assert.equal(describeCron('30 8 * * 1-5'), 'weekdays at 08:30');
  assert.equal(describeCron('0 10 * * 0,6'), 'weekends at 10:00');
  assert.equal(describeCron('0 18 * * fri'), 'Fri at 18:00');
  assert.equal(describeCron('*/15 * * * *'), '*/15 * * * *');
  assert.equal(describeCron('nonsense'), 'nonsense');
});
