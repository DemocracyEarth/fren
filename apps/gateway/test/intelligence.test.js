'use strict';
/**
 * The prompt builders.
 *
 * These assert the RULES that are load-bearing rather than the prose, because
 * the prose will be reworded and the rules must not quietly go with it. Each
 * one here exists because a real model got it wrong when the rule was absent.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  buildGreetingRequest, gapInWords, buildCuriosityRequest, buildLearnRequest,
} = require('../../../packages/intelligence');

test('a gap is described the way a person would say it', () => {
  assert.equal(gapInWords(30 * 1000), 'a moment');
  assert.equal(gapInWords(9 * 60 * 1000), '9 minutes');
  assert.equal(gapInWords(14 * 3600 * 1000), '14 hours');
  assert.equal(gapInWords(9 * 86400 * 1000), '9 days');
  assert.match(gapInWords(40 * 86400 * 1000), /weeks/);
  assert.match(gapInWords(200 * 86400 * 1000), /months/);
  // A clock that jumped backwards must not produce "-3 hours".
  assert.equal(gapInWords(-5000), 'unknown');
  assert.equal(gapInWords(NaN), 'unknown');
});

test('the greeting is told, in terms it cannot miss, that fren was closed', () => {
  // Probed against DeepSeek without this rule, the model volunteered "I kept an
  // eye on the monitor while you were gone" and "your files were waiting here
  // with me". Both are false, and false in the one direction this project
  // cannot afford — they claim surveillance that never happened.
  const { system } = buildGreetingRequest({ profile: { name: 'Sam' } });
  assert.match(system, /CLOSED/);
  assert.match(system, /not watching/i);
  assert.match(system, /never invent a detail/i);
});

test('the greeting is barred from claiming to know the screen right now', () => {
  // This one appeared only after the "vary your opening" rule went in: pushed
  // for variety, the model started filling the gap with invented state —
  // "curiosity.js is still open in your editor", "still right where you left
  // it" — in 4 of 8 samples. It cannot know that. It had just started.
  // Normalized: the rule text wraps across lines in the source, so matching it
  // raw would fail on the line break rather than on a missing rule.
  const flat = buildGreetingRequest({}).system.replace(/\s+/g, ' ');
  assert.match(flat, /still open/i);
  assert.match(flat, /right where you left it/i);
  assert.match(flat, /past tense/i);
});

test('a dropped rule leaves no hole, and blank lines survive assembly', () => {
  // filter(Boolean) cannot tell an absent rule from a deliberate blank line,
  // because both are ''. It flattened these prompts to a single wall of text.
  for (const s of [buildGreetingRequest({}).system, buildCuriosityRequest({ memories: [] }).system]) {
    assert.ok((s.match(/\n\n/g) || []).length > 2, 'paragraph breaks survive');
    assert.ok(!/\n\n\n/.test(s), 'a dropped rule leaves no double gap');
    assert.equal(s, s.trim(), 'no leading or trailing whitespace');
  }
});

test('the greeting is barred from ending in an instruction', () => {
  // The same variety pressure produced "so dive back in", "pick up where the
  // logic left off" — the assistant voice wearing a coat.
  const { system } = buildGreetingRequest({});
  assert.match(system, /dive back in/i);
  assert.match(system, /not a nudge/i);
});

test('recent greetings are named so the opener stops repeating', () => {
  const { system } = buildGreetingRequest({ avoid: ['Well, look who it is.', 'Well, nine days.'] });
  assert.match(system, /Do not reuse their shape/);
  assert.match(system, /Well, nine days\./);
  // Only the last few: an ever-growing "do not say" list crowds out the notes
  // the greeting is actually built from.
  const many = buildGreetingRequest({ avoid: Array.from({ length: 20 }, (_, i) => `greeting ${i}`) }).system;
  assert.ok(!/greeting 5\b/.test(many), 'old greetings fall off');
  assert.match(many, /greeting 19/);
});

test('with nothing to avoid, no empty rule is left dangling', () => {
  const { system } = buildGreetingRequest({ avoid: [] });
  assert.ok(!/You have said these recently/.test(system));
  assert.ok(!/\n\n\n/.test(system), 'no hole where the rule would have been');
});

test('the greeting is told not to read private activity back to anyone', () => {
  const { system } = buildGreetingRequest({});
  assert.match(system, /personal rather than work/i);
  assert.match(system, /receipt/i);
});

test('the greeting refuses the assistant voice', () => {
  const { system } = buildGreetingRequest({});
  assert.match(system, /How can I help you today/);
  assert.match(system, /Offer no help/i);
});

test('a first launch says so rather than inventing a history', () => {
  const notes = buildGreetingRequest({ lastSeenMs: null }).messages[0].content;
  assert.match(notes, /never — this is a new install/);
  assert.ok(!/Last thing you noted/.test(notes), 'nothing observed means nothing quoted');
});

test('what fren actually knows reaches the greeting', () => {
  const now = Date.parse('2026-08-24T08:12:00');
  const notes = buildGreetingRequest({
    profile: { name: 'Sam' },
    lastSeenMs: now - 14 * 3600 * 1000,
    lastActivity: 'curiosity.js in VS Code',
    facts: '- Ships the billing rewrite with Ana.',
    now,
  }).messages[0].content;
  assert.match(notes, /Name: Sam/);
  assert.match(notes, /Monday 08:12/);
  assert.match(notes, /14 hours/);
  assert.match(notes, /curiosity\.js/);
  assert.match(notes, /billing rewrite/);
});

test('an enormous activity string cannot run away with the prompt', () => {
  const notes = buildGreetingRequest({ lastActivity: 'x'.repeat(50_000), facts: 'y'.repeat(50_000) })
    .messages[0].content;
  assert.ok(notes.length < 2000, `notes were ${notes.length} characters`);
});

// --- curiosity, from the same session ---------------------------------------

test('curiosity is told that silence is the right default', () => {
  const { system } = buildCuriosityRequest({ memories: [] });
  assert.match(system, /set ask to false/i);
  assert.match(system, /Silence is the correct default/i);
  // Being a productivity nag is the specific failure this has to avoid.
  assert.match(system, /not their manager/i);
});

test('curiosity is told what it has already asked', () => {
  const { system } = buildCuriosityRequest({ memories: [], asked: ['the landing page'] });
  assert.match(system, /do not ask again/i);
  assert.match(system, /the landing page/);
});

test('learning is told to keep only what outlives the day', () => {
  const req = buildLearnRequest({ question: 'q', answer: 'a' });
  assert.match(req.system, /in the long run/i);
  assert.match(req.system, /NOT worth keeping/);
  assert.match(req.system, /worthKeeping to false/);
  // The durability bar itself lives in the schema, where the model reads it
  // while filling the field — that is the half that must not be lost.
  assert.match(req.schema.properties.worthKeeping.description, /still true and still useful in a month/i);
});
