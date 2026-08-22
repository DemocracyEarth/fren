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
  assert.equal(r.schema.required[0], 'value');
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
  assert.match(r.system, /Never invent/);
  assert.match(r.system, /return an empty string/);
});
