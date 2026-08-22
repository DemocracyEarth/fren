'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildExtractRequest } = require('../index.js');

test('a name is extracted as a value, not stored as a sentence', () => {
  // The reported bug: asked for a name, the user said "yeah hi, my name is
  // Santi" and the whole sentence became their identity.
  const r = buildExtractRequest({
    field: 'name',
    question: 'What should I call you?',
    answer: 'yeah hi, my name is Santi',
  });
  assert.match(r.system, /Return ONLY what they want to be called/);
  assert.match(r.system, /Strip greetings and framing/);
  assert.match(r.messages[0].content, /yeah hi, my name is Santi/);
  assert.ok(r.schema.required.includes('value'));
  assert.ok(r.schema.required.includes('kind'));
});

test("instructions about behaviour are tidied, never reworded", () => {
  // tone and initiative become standing instructions in SOUL.md. Paraphrasing
  // them would mean fren following words the user never chose.
  for (const field of ['tone', 'initiative']) {
    const r = buildExtractRequest({ field, question: 'q', answer: 'a' });
    assert.match(r.system, /THEIR OWN WORDS/, `${field} must preserve their words`);
    assert.match(r.system, /Do not paraphrase/, `${field} must not be reworded`);
  }
});

test('the spoken context is stated, since answers arrive with filler', () => {
  const r = buildExtractRequest({ field: 'work', question: 'q', answer: 'a' });
  assert.match(r.system, /spoken aloud/);
  assert.match(r.system, /filler, false starts/);
});

test('an unknown field still gets a sane rule rather than nothing', () => {
  const r = buildExtractRequest({ field: 'nope', question: 'q', answer: 'a' });
  assert.match(r.system, /substance of their answer/);
});

test('nothing may be invented when the answer holds no value', () => {
  const r = buildExtractRequest({ field: 'name', question: 'q', answer: 'um' });
  assert.match(r.system, /Never invent anything/);
});

// --- people do not only answer questions ------------------------------------
// Live evidence from a real interview: asked what they were working on, the
// user instead said "I said that my name was Santi, not that my name was this
// entire sentence" — a CORRECTION — and it was recorded as their job. Asked
// when fren should speak up, they asked a QUESTION back, and that was recorded
// as a standing instruction.

test('a reply is classified before it is extracted', () => {
  const r = buildExtractRequest({ field: 'work', question: 'q', answer: 'a' });
  assert.match(r.system, /"answer"/);
  assert.match(r.system, /"question"/);
  assert.match(r.system, /"correction"/);
  assert.deepEqual(r.schema.properties.kind.enum, ['answer', 'question', 'correction']);
});

test('a question gets an honest reply drawn only from stated facts', () => {
  const r = buildExtractRequest({ field: 'initiative', question: 'q', answer: 'can you do that on your own?' });
  assert.match(r.system, /Do not invent an answer for/);
  // Without these the model invents capabilities when asked directly, which is
  // both a bad first impression and a lie.
  assert.match(r.system, /Facts you may use to answer a question, and nothing beyond them/);
  assert.match(r.system, /CAN raise something it noticed on its own/);
  assert.match(r.system, /never captures keystrokes/);
  assert.match(r.system, /does not act on your behalf/);
});

test('a correction names the field it fixes', () => {
  const r = buildExtractRequest({ field: 'work', question: 'q', answer: 'no, I said my name was Santi' });
  assert.match(r.system, /which earlier field it fixes|the field it fixes/);
  assert.ok(r.schema.required.includes('corrects'));
});

test('what is already recorded is shown, so a correction has something to correct', () => {
  const r = buildExtractRequest({
    field: 'work', question: 'q', answer: 'no, Santi',
    asked: { name: 'Hi, you can call me Santi.' },
  });
  assert.match(r.messages[0].content, /Recorded so far/);
  assert.match(r.messages[0].content, /Hi, you can call me Santi\./);
});

// --- the one answer that changes behaviour rather than notes ----------------
// "You can interrupt me" is permission, and contains none of the words a
// keyword test would look for. A regex got four of seven real answers wrong,
// including that one, which would have left fren mute at someone who had just
// invited it to speak.

test('deciding whether fren may interrupt is a classification, not a keyword match', () => {
  const r = buildExtractRequest({
    field: 'initiativeMode',
    question: 'Should fren raise things on its own, or wait to be asked?',
    answer: 'You can interrupt me',
  });
  assert.match(r.system, /EXACTLY one word/);
  assert.match(r.system, /"volunteer"/);
  assert.match(r.system, /"wait"/);
  // The phrasings that broke the keyword version are named explicitly.
  assert.match(r.system, /you can interrupt me/i);
  assert.match(r.system, /feel free/i);
  assert.match(r.system, /whenever you think it matters/i);
});

test('an undecidable answer defaults to staying quiet', () => {
  const r = buildExtractRequest({ field: 'initiativeMode', question: 'q', answer: 'dunno' });
  assert.match(r.system, /genuinely unclear, answer "wait"/);
  // Stated outright, because the asymmetry is the whole point: nagging someone
  // who asked for quiet is worse than missing one observation.
  assert.match(r.system, /interrupting someone who did not ask for it is the worse mistake/);
});
