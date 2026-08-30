'use strict';
/**
 * The moments engine's clockwork: when fren decides to speak first, and —
 * mostly — when it decides not to. Every dependency is injected, so the away
 * edge, the reading trail and the budget all run on a fake clock against a
 * fake gateway.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createProactiveWatcher, DEFAULTS } = require('../main/proactive.js');

function harness({ worth = true, options = {}, observing = true } = {}) {
  // A believable epoch: measured-from-zero cooldowns must already be ancient.
  const clock = { t: 1_700_000_000_000, idle: 0 };
  const settings = new Map();
  const suggestions = [];
  const asked = [];
  const watcher = createProactiveWatcher({
    memory: {
      getSetting: (k) => settings.get(k),
      setSetting: (k, v) => settings.set(k, v),
      getRecentMemories: () => [{ ts: clock.t, summary: 'worked on things' }],
      getRecentObservations: () => [{ ts: clock.t, activeApp: 'Code', windowTitle: 'x' }],
    },
    gateway: {
      suggest: async (payload) => {
        asked.push(payload);
        // Distinct topics that survive fingerprinting — digits alone do not.
        const topics = ['migrating the database', 'planning the trip', 'tuning the shader',
                        'reading about orbits', 'sorting the inbox', 'drafting the talk',
                        'fixing the roof', 'learning the flute', 'mapping the garden',
                        'counting the stars'];
        return { worth, message: worth ? 'You could pick that thread back up.' : '',
                 about: topics[(asked.length - 1) % topics.length] };
      },
    },
    state: { get: () => ({ observing }), beginWork() {}, endWork() {} },
    idleSeconds: () => clock.idle,
    getBrowser: () => null,
    onSuggestion: (s) => suggestions.push(s),
    log: () => {},
    random: () => 0,                     // check-in chance always passes
    now: () => clock.t,
    options: { warmupMs: 0, ...options },
  });
  return { watcher, clock, suggestions, asked, settings };
}

const MIN = 60 * 1000;

test('coming back after being away is a moment', async () => {
  const { watcher, clock, suggestions, asked } = harness();
  clock.idle = 10 * 60;                  // 10 minutes idle: away
  await watcher.tick();
  assert.equal(suggestions.length, 0, 'nothing while nobody is there');
  clock.t += 10 * MIN;
  clock.idle = 5;                        // they are back
  await watcher.tick();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].moment, 'welcome-back');
  assert.ok(asked[0].awayMinutes >= 10, 'the moment knows how long they were gone');
});

test('short breaks are not absences', async () => {
  const { watcher, clock, suggestions } = harness();
  clock.idle = 3 * 60;                   // three minutes: coffee, not gone
  await watcher.tick();
  clock.idle = 5;
  await watcher.tick();
  assert.equal(suggestions.length, 0);
});

test('a sustained reading thread is a moment; scattered browsing is not', async () => {
  const { watcher, clock, suggestions, asked } = harness();
  const page = (domain) => watcher.noteBrowser({
    tab: { url: `https://${domain}/x`, domain }, page: { contentType: 'article' },
  });
  // Scattered: five domains in five minutes.
  for (const d of ['a.com', 'b.com', 'c.com', 'd.com', 'e.com']) {
    page(d); clock.t += 1 * MIN;
  }
  await watcher.tick();
  assert.equal(suggestions.length, 0, 'no thread, no moment');

  // The scattered pages age out of the window, then a real thread forms:
  // the same place over twenty minutes.
  clock.t += 46 * MIN;
  for (let i = 0; i < 5; i++) { page('arxiv.org'); clock.t += 5 * MIN; }
  await watcher.tick();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].moment, 'deep-reading');
  const r = asked[asked.length - 1].reading;
  assert.equal(r.domain, 'arxiv.org');
  assert.ok(r.pages >= 3 && r.minutes >= 18);
});

test('an excluded page never enters the trail', async () => {
  // The check-in moment is silenced so only the reading trail can speak here.
  const { watcher, clock, suggestions } = harness({ options: { checkInMs: 1e12 } });
  for (let i = 0; i < 6; i++) {
    watcher.noteBrowser({ tab: { url: 'https://chase.com/x', domain: 'chase.com' },
                          page: { excluded: true } });
    clock.t += 5 * MIN;
  }
  await watcher.tick();
  assert.equal(suggestions.length, 0, 'reading you are not watching is not a thread');
});

test('the budget: a global cooldown and a daily ceiling, failing to silence', async () => {
  const { watcher, clock, suggestions } = harness({ options: { checkInMs: 1, checkInChance: 1 } });
  clock.t += MIN;                        // a moment of life before the first look
  await watcher.tick();                  // check-in fires
  assert.equal(suggestions.length, 1);
  clock.t += 10 * MIN;
  await watcher.tick();                  // inside the 45min cooldown
  assert.equal(suggestions.length, 1, 'spoke recently: silent');
  // Past BOTH cooldowns — the global one and check-in's own, which is longer.
  clock.t += DEFAULTS.momentCooldownMs['check-in'] + MIN;
  await watcher.tick();
  assert.equal(suggestions.length, 2, 'cooldowns over: allowed again');
});

test('the daily ceiling holds across moments', async () => {
  const { watcher, clock, suggestions } = harness({
    options: { checkInMs: 1, checkInChance: 1, cooldownMs: 0, momentCooldownMs: { 'check-in': 0 } },
  });
  for (let i = 0; i < 10; i++) { await watcher.tick(); clock.t += MIN; }
  assert.equal(suggestions.length, DEFAULTS.maxPerDay, 'five a day, however eager the clock');
});

test('worth:false is silence, and costs no budget', async () => {
  const { watcher, suggestions, settings } = harness({
    worth: false, options: { checkInMs: 1, checkInChance: 1 } });
  await watcher.tick();
  assert.equal(suggestions.length, 0);
  assert.equal(settings.get('proactive'), undefined, 'nothing was spent on nothing');
});

test('the same topic does not come up twice', async () => {
  const clock = { t: 1_700_000_000_000, idle: 0 };
  const settings = new Map();
  const suggestions = [];
  const watcher = createProactiveWatcher({
    memory: {
      getSetting: (k) => settings.get(k),
      setSetting: (k, v) => settings.set(k, v),
      getRecentMemories: () => [{ ts: clock.t, summary: 's' }],
      getRecentObservations: () => [],
    },
    // Every call returns the SAME topic — the second must be swallowed.
    gateway: { suggest: async () => ({ worth: true, message: 'Fancy a summary of that thread?', about: 'the arxiv thread' }) },
    state: { get: () => ({ observing: true }), beginWork() {}, endWork() {} },
    idleSeconds: () => clock.idle,
    onSuggestion: (s) => suggestions.push(s),
    log: () => {},
    random: () => 0,
    now: () => clock.t,
    options: { warmupMs: 0, cooldownMs: 0, momentCooldownMs: { 'check-in': 0 } },
  });
  await watcher.consider('check-in');
  clock.t += 60 * 1000;
  await watcher.consider('check-in');
  assert.equal(suggestions.length, 1, 'the repeat was recognized and dropped');
});

test('the light off means no moments at all', async () => {
  const { watcher, clock, suggestions } = harness({
    observing: false, options: { checkInMs: 1, checkInChance: 1 } });
  clock.idle = 10 * 60; await watcher.tick();
  clock.t += 10 * MIN; clock.idle = 5; await watcher.tick();
  assert.equal(suggestions.length, 0, 'a paused fren initiates nothing');
});

test('leaving breaks the reading thread', async () => {
  const { watcher, clock, suggestions } = harness();
  const page = () => watcher.noteBrowser({
    tab: { url: 'https://arxiv.org/x', domain: 'arxiv.org' }, page: { contentType: 'article' } });
  for (let i = 0; i < 4; i++) { page(); clock.t += 6 * MIN; }
  clock.idle = 10 * 60;                  // they left mid-thread
  await watcher.tick();
  clock.t += 12 * MIN; clock.idle = 5;
  await watcher.tick();                  // welcome-back fires (one per tick)
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].moment, 'welcome-back');
  clock.t += DEFAULTS.cooldownMs + MIN;
  await watcher.tick();
  const deepReads = suggestions.filter((s) => s.moment === 'deep-reading');
  assert.equal(deepReads.length, 0, 'the old trail did not survive the absence');
});
