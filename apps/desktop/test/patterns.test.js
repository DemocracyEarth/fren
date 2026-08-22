'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPatternWatcher, fingerprint } = require('../main/patterns.js');

const memories = (n) => Array.from({ length: n }, (_, i) => ({ activity: `thing ${i}` }));

function harness({ found, suggestions = [] } = {}) {
  const added = [];
  const sent = [];
  return {
    added, sent,
    watcher: createPatternWatcher({
      memory: {
        getRecentMemories: () => memories(20),
        getSuggestions: () => suggestions,
        addSuggestion: (s) => added.push(s),
      },
      gateway: { pattern: async () => found },
      state: { get: () => ({ observing: true }), beginWork() {}, endWork() {} },
      onSuggestion: (s) => sent.push(s),
      log: () => {},
    }),
  };
}

const GOOD = {
  interrupt: true, confidence: 0.85, occurrences: 4,
  message: 'You copy the same three fields from the admin panel into the sheet every morning.',
  pattern: 'copy admin panel fields into spreadsheet',
};

test('a confident, repeated pattern is raised', async () => {
  const h = harness({ found: GOOD });
  await h.watcher.look();
  assert.equal(h.added.length, 1);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message, /admin panel/);
});

test('a low-confidence guess is not worth interrupting for', async () => {
  const h = harness({ found: { ...GOOD, confidence: 0.4 } });
  await h.watcher.look();
  assert.equal(h.sent.length, 0);
});

test('twice is a coincidence, not a pattern', async () => {
  const h = harness({ found: { ...GOOD, occurrences: 2 } });
  await h.watcher.look();
  assert.equal(h.sent.length, 0, 'below the occurrence floor it must stay quiet');
});

test('the same thing is never raised twice', async () => {
  const h = harness({ found: GOOD });
  await h.watcher.look();
  assert.equal(h.sent.length, 1);
  // A second look, same pattern. Being told the same observation repeatedly is
  // how an ambient companion gets muted.
  await h.watcher.look();
  assert.equal(h.sent.length, 1, 'a repeat sighting must not be raised again');
});

test('the same pattern worded differently is still the same pattern', () => {
  assert.equal(
    fingerprint('Copying admin-panel fields into the spreadsheet'),
    fingerprint('copying the spreadsheet fields from admin panel')
  );
});

test('patterns already proposed before a restart are not raised again', async () => {
  const h = harness({ found: GOOD, suggestions: [{ pattern: GOOD.pattern, message: GOOD.message }] });
  await h.watcher.look();
  assert.equal(h.sent.length, 0, 'restarting fren is not a reason to repeat itself');
});

test('nothing is noticed while fren is not watching', async () => {
  const added = [];
  const w = createPatternWatcher({
    memory: { getRecentMemories: () => memories(20), getSuggestions: () => [], addSuggestion: (s) => added.push(s) },
    gateway: { pattern: async () => { throw new Error('must not be called while paused'); } },
    state: { get: () => ({ observing: false }), beginWork() {}, endWork() {} },
    log: () => {},
  });
  await w.look();
  assert.equal(added.length, 0);
});

test('too little history means there is nothing to see yet', async () => {
  const added = [];
  const w = createPatternWatcher({
    memory: { getRecentMemories: () => memories(3), getSuggestions: () => [], addSuggestion: (s) => added.push(s) },
    gateway: { pattern: async () => { throw new Error('must not be called on thin history'); } },
    state: { get: () => ({ observing: true }), beginWork() {}, endWork() {} },
    log: () => {},
  });
  await w.look();
  assert.equal(added.length, 0);
});

test('a provider failure is survivable and silent', async () => {
  const h = harness({ found: null });
  const w = createPatternWatcher({
    memory: { getRecentMemories: () => memories(20), getSuggestions: () => [], addSuggestion: () => {} },
    gateway: { pattern: async () => { throw new Error('gateway down'); } },
    state: { get: () => ({ observing: true }), beginWork() {}, endWork() {} },
    log: () => {},
  });
  await w.look();   // must not throw
  assert.ok(true);
});
