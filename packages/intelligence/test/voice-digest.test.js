'use strict';
/**
 * What fren hands its voice agent at the start of a conversation: the last few
 * hours in words a friend would use — rough recency, never a duration or a
 * clock time — the newest thing last and marked, and never a word about an
 * excluded page.
 */
const test = require('node:test');
const assert = require('node:assert');
const { voiceDigest } = require('../index.js');

const TUESDAY_10AM = new Date(2026, 8, 15, 10, 0, 0).getTime();
const min = (n) => n * 60e3;

test('an empty day is said plainly', () => {
  const { recent_context, local_time } = voiceDigest({ now: TUESDAY_10AM });
  assert.equal(recent_context, 'Nothing noted yet.');
  assert.equal(local_time, 'Tuesday, morning');
});

test('the last few hours with rough recency, the newest marked; what is in front; the page — and nothing timed', () => {
  const now = TUESDAY_10AM;
  const { recent_context } = voiceDigest({
    memories: [
      { tsStart: now - min(400), tsEnd: now - min(390), activity: 'ancient history' },
      { tsStart: now - min(200), tsEnd: now - min(190), activity: 'wrote the runtime doc' },
      { tsStart: now - min(70), tsEnd: now - min(60), activity: 'debugged the sandbox proxy' },
      { tsStart: now - min(30), tsEnd: now - min(20), activity: 'read about React suspense' },
      { tsStart: now - min(6), tsEnd: now - min(3), activity: 'drafting the wake-word piece' },
    ],
    observation: { activeApp: 'Code', windowTitle: 'narrator.js — fren' },
    browser: { tab: { domain: 'react.dev', title: 'useMemo – React', url: 'https://react.dev/x' }, page: {} },
    now,
  });
  const lines = recent_context.split('\n');
  assert.equal(lines[0], '- a while ago: ancient history');
  assert.equal(lines[1], '- a while ago: wrote the runtime doc');
  assert.equal(lines[2], '- earlier: debugged the sandbox proxy');
  assert.equal(lines[3], '- a little while ago: read about React suspense');
  assert.equal(lines[4], '- most recently (just now): drafting the wake-word piece');
  assert.equal(lines[5], '- in front of them now: Code — narrator.js — fren');
  assert.equal(lines[6], '- open in the browser: react.dev — "useMemo – React"');
  assert.doesNotMatch(recent_context, /\d{1,2}:\d{2}|minutes|hours/, 'no clock, no durations');
});

test('at most the last eight summaries; empty ones are skipped; no timestamp means "earlier"', () => {
  const memories = [];
  for (let i = 0; i < 10; i++) memories.push({ tsStart: 1, tsEnd: 2, activity: `thing ${i}` });
  memories.push({ activity: '   ' });
  memories.push({ activity: 'untimed thing' });
  const { recent_context } = voiceDigest({ memories, now: TUESDAY_10AM });
  const lines = recent_context.split('\n');
  assert.equal(lines.length, 8);
  assert.doesNotMatch(recent_context, /thing 0|thing 1\b|thing 2\b/, 'the oldest fall off');
  assert.equal(lines[7], '- most recently (earlier): untimed thing');
});

test('an excluded page contributes nothing, not even its title', () => {
  const { recent_context } = voiceDigest({
    browser: { tab: { domain: 'bank.example', title: 'My account' }, page: { excluded: true } },
    now: TUESDAY_10AM,
  });
  assert.doesNotMatch(recent_context, /bank|account/);
  assert.equal(recent_context, 'Nothing noted yet.');
});

test('local_time is a part of day, never a clock reading', () => {
  const late = new Date(2026, 8, 15, 23, 15).getTime();
  assert.equal(voiceDigest({ now: late }).local_time, 'Tuesday, late evening');
});
