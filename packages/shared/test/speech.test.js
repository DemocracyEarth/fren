'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { forSpeech } = require('../speech');

test('marks for the eye are dropped; the words stay, with pauses where the marks were', () => {
  assert.equal(forSpeech('**Hello** there — here is _a link_: [HN](https://news.ycombinator.com/item?id=1) 🚀'), 'Hello there, here is a link: HN.');
  assert.equal(forSpeech('Top stories:\n- One thing\n- Another *big* thing\n\n1. First\n2. Second'), 'Top stories: One thing. Another big thing. First. Second.');
  assert.equal(forSpeech('## Morning\nAll clear ✅'), 'Morning. All clear.');
});

test('quotation marks go; the apostrophe in a word stays', () => {
  assert.equal(forSpeech('He said "don\'t worry" and ‘fine’.'), "He said don't worry and fine.");
  assert.equal(forSpeech('“Quoted,” she said'), 'Quoted, she said.');
});

test('code is not read aloud; an address is its host; symbols become words', () => {
  assert.equal(forSpeech('Run `npm start` now.\n```js\nx()\n```\nDone'), 'Run npm start now. code omitted. Done.');
  assert.equal(forSpeech('See https://www.example.com/path?q=1 today'), 'See example.com today.');
  assert.equal(forSpeech('#3 is 50% & more, ~5 of them'), 'number 3 is 50% and more, about 5 of them.');
  assert.equal(forSpeech('| a | b |\n|---|---|\n| one | two |'), 'a, b. one, two.');
});

test('nothing to say is nothing', () => {
  assert.equal(forSpeech(''), '');
  assert.equal(forSpeech('🚀🎉'), '');
  assert.equal(forSpeech('   '), '');
});
