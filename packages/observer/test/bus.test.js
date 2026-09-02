'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createObservationBus, isObservation } = require('..');

test('only well-formed observations are accepted', () => {
  assert.equal(isObservation({ timestamp: 1, source: 'browser', type: 'page.opened', payload: {} }), true);
  assert.equal(isObservation({ timestamp: 'now', source: 'browser', type: 'x' }), false);
  assert.equal(isObservation({ timestamp: 1, source: 'keyboard', type: 'x' }), false);
  assert.equal(isObservation({ timestamp: 1, source: 'os', type: '' }), false);
  const bus = createObservationBus();
  assert.equal(bus.publish({ nope: true }), false);
  assert.equal(bus.size(), 0);
});

test('subscribers get what their filter matches, and only that', () => {
  const bus = createObservationBus();
  const browser = [];
  const all = [];
  bus.subscribe({ source: 'browser' }, (o) => browser.push(o));
  const off = bus.subscribe(null, (o) => all.push(o));
  bus.publish({ timestamp: 1, source: 'browser', type: 'page.opened', payload: { domain: 'a' } });
  bus.publish({ timestamp: 2, source: 'os', type: 'app.active', payload: { app: 'Code' } });
  assert.equal(browser.length, 1);
  assert.equal(all.length, 2);
  off();
  bus.publish({ timestamp: 3, source: 'user', type: 'chat', payload: {} });
  assert.equal(all.length, 2);
});

test('the ring forgets by age and by size', () => {
  let clock = 10_000;
  const bus = createObservationBus({ maxItems: 3, maxAgeMs: 1000, now: () => clock });
  for (let i = 0; i < 5; i += 1) bus.publish({ timestamp: clock, source: 'os', type: 'tick', payload: i });
  assert.equal(bus.size(), 3);
  assert.deepEqual(bus.recent().map((o) => o.payload), [4, 3, 2]);
  clock += 2000;
  assert.equal(bus.recent().length, 0);
});
