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
  buildGreetingRequest, gapTone, buildCuriosityRequest, buildLearnRequest,
} = require('../../../packages/intelligence');

test('the gap is a tone, with no number in it to recite', () => {
  // This used to return "14 hours" and the greeting handed it straight back:
  // "it's been fourteen hours since I saw you". Being told how long you were
  // away from your own computer is a meter reading, not a hello.
  const H = 3600 * 1000;
  assert.equal(gapTone(0.3 * H), 'barely away');
  assert.equal(gapTone(5 * H), 'the same day');
  assert.equal(gapTone(20 * H), 'a night in between');
  assert.equal(gapTone(72 * H), 'several days');
  assert.equal(gapTone(400 * H), 'a long absence');
  // A clock that jumped backwards must not produce anything quotable either.
  assert.equal(gapTone(-5000), 'unknown');
  assert.equal(gapTone(NaN), 'unknown');
  // The point of the whole exercise: no digits anywhere in any answer.
  for (const ms of [0.1 * H, 3 * H, 30 * H, 200 * H, 5000 * H]) {
    assert.ok(!/\d/.test(gapTone(ms)), `gapTone(${ms}) handed back a number`);
  }
});

test('the greeting is forbidden from measuring anything', () => {
  const flat = buildGreetingRequest({}).system.replace(/\s+/g, ' ');
  assert.match(flat, /NEVER MENTION HOW LONG THEY WERE AWAY/);
  assert.match(flat, /no clock times/i);
  assert.match(flat, /Cut straight to it/i);
  // And it must not pass judgement on work it only saw the title of.
  assert.match(flat, /Do not judge the work/i);
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

test('the greeting may offer one thing to pick up, from the notes only, and never as an order', () => {
  // Its owner asked for a hello that prompts what to do next. The suggestion
  // is allowed, grounded in the notes, and the assistant voice ("dive back in")
  // is still out.
  const { system, messages } = buildGreetingRequest({ automations: ['morning AI news (every day at 09:00)'], routines: ['evening review'] });
  assert.match(system, /ONE more short sentence/);
  assert.match(system, /only from the notes/i);
  assert.match(system, /dive back in/i);
  assert.match(system, /Never invent a task/);
  assert.match(messages[0].content, /morning AI news/);
  assert.match(messages[0].content, /evening review/);
  assert.ok(!/Things they have you do/.test(buildGreetingRequest({}).messages[0].content), 'nothing listed when there is nothing');
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
  assert.match(system, /No generic offers of help/i);
});

test('a first launch says so rather than inventing a history', () => {
  const notes = buildGreetingRequest({ lastSeenMs: null }).messages[0].content;
  assert.match(notes, /never run before/);
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
  assert.match(notes, /Monday morning/, 'a part of the day, not a clock reading');
  assert.match(notes, /curiosity\.js/);
  assert.match(notes, /billing rewrite/);
  // The gap is present as a tone and labelled as unusable, with no figure in it.
  assert.match(notes, /FOR YOUR TONE ONLY, never to be said: a night in between/);
  assert.ok(!/08:12|14 hours|\b14\b/.test(notes), 'nothing quotable about the clock or the gap');
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

test('chat is told to answer, not to report', () => {
  // The timeline handed to the model is full of clock ranges and durations, and
  // left to itself it hands them straight back — "you spent 47 minutes in
  // Figma" — which reads as a meter reading rather than an answer.
  const { buildChatRequest } = require('../../../packages/intelligence');
  const flat = buildChatRequest({ question: 'what have I been doing?' }).system.replace(/\s+/g, ' ');
  assert.match(flat, /Cut straight to the answer/i);
  assert.match(flat, /Do not restate the question/i);
  assert.match(flat, /No durations, no clock times, no counts/i);
  assert.match(flat, /unless they actually asked/i);
});
