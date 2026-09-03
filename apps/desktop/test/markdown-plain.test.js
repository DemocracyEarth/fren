'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plain } = require('../renderer/markdown');

test('the plain reading keeps the words and the shape, and drops the marks', () => {
  assert.equal(plain('**Top** story: _AI wins_ `again`'), 'Top story: AI wins again');
  assert.equal(plain('## Morning\n- one\n- two\n> said so'), 'Morning\n• one\n• two\nsaid so');
  assert.equal(plain('see [HN](https://news.ycombinator.com/) now'), 'see HN now');
  assert.equal(plain('```js\nx()\n```'), 'x()');
  assert.equal(plain('snake_case_name stays'), 'snake_case_name stays');
  assert.equal(plain(''), '');
});
