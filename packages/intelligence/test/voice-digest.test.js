'use strict';
/**
 * What fren hands its voice agent at the start of a conversation: a digest of
 * recent context that never carries a duration or a clock time, and never a
 * word about an excluded page.
 */
const test = require('node:test');
const assert = require('node:assert');
const { voiceDigest } = require('../index.js');

const TUESDAY_10AM = new Date(2026, 8, 15, 10, 0, 0).getTime();

test('an empty day is said plainly', () => {
  const { recent_context, local_time } = voiceDigest({ now: TUESDAY_10AM });
  assert.equal(recent_context, 'Nothing noted yet.');
  assert.equal(local_time, 'Tuesday, morning');
});

test('the last few summaries, what is in front, the page — and nothing timed', () => {
  const { recent_context } = voiceDigest({
    memories: [
      { tsStart: 1, tsEnd: 2, activity: 'ancient history' },
      { tsStart: 3, tsEnd: 4, activity: 'wrote the runtime doc' },
      { tsStart: 5, tsEnd: 6, activity: 'debugged the sandbox proxy' },
      { tsStart: 7, tsEnd: 8, activity: 'read about React suspense' },
    ],
    observation: { activeApp: 'Code', windowTitle: 'narrator.js — fren' },
    browser: { tab: { domain: 'react.dev', title: 'useMemo – React', url: 'https://react.dev/x' }, page: {} },
    now: TUESDAY_10AM,
  });
  assert.match(recent_context, /read about React suspense/);
  assert.match(recent_context, /debugged the sandbox proxy/);
  assert.doesNotMatch(recent_context, /ancient history/, 'only the last three');
  assert.match(recent_context, /in front of them now: Code — narrator\.js/);
  assert.match(recent_context, /open in the browser: react\.dev — "useMemo – React"/);
  assert.doesNotMatch(recent_context, /\d{1,2}:\d{2}|minutes|hours/, 'no clock, no durations');
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
