'use strict';
/**
 * The Markdown renderer.
 *
 * The interesting tests are the ones about what it REFUSES. fren writes
 * MEMORY.md itself from model output, so this renderer reads text that a
 * language model composed — and it is displayed in a window with access to the
 * preload bridge. Anything that assembled an HTML string would turn "the model
 * wrote something strange" into "the model wrote markup into the dashboard".
 */
const test = require('node:test');
const assert = require('node:assert');

// A DOM small enough to reason about. Node construction is the security
// property under test, so the stub deliberately has NO innerHTML: if the
// renderer ever reached for one, these tests would crash rather than pass.
function stubDom() {
  const make = (tag) => ({
    tag,
    className: '',
    title: '',
    children: [],
    _text: null,
    set textContent(v) { this._text = String(v); this.children.length = 0; },
    get textContent() {
      if (this._text !== null) return this._text;
      return this.children.map((c) => c.textContent).join('');
    },
    appendChild(c) { this.children.push(c); return c; },
    get lastChild() { return this.children[this.children.length - 1]; },
  });
  global.document = {
    createElement: make,
    createTextNode: (t) => ({ tag: '#text', textContent: String(t), children: [] }),
  };
}
stubDom();
const { render } = require('../renderer/markdown.js');

/** Every node of a given tag, depth first. */
function all(node, tag, out = []) {
  if (node.tag === tag) out.push(node);
  for (const c of node.children || []) all(c, tag, out);
  return out;
}
const textOf = (node) => node.textContent;

test('headings, at every level', () => {
  const d = render('# One\n\n## Two\n\n###### Six');
  assert.equal(all(d, 'h1').length, 1);
  assert.equal(textOf(all(d, 'h1')[0]), 'One');
  assert.equal(textOf(all(d, 'h2')[0]), 'Two');
  assert.equal(textOf(all(d, 'h6')[0]), 'Six');
});

test('consecutive lines join into one paragraph, blank lines split them', () => {
  // soul.js hard-wraps its prose, so without this every wrapped line would
  // become its own paragraph and the files would read as a list of fragments.
  const d = render('one line\nand its continuation\n\na second paragraph');
  const ps = all(d, 'p');
  assert.equal(ps.length, 2);
  assert.equal(textOf(ps[0]), 'one line and its continuation');
  assert.equal(textOf(ps[1]), 'a second paragraph');
});

test('emphasis, strong and code', () => {
  const d = render('a **bold** and _quiet_ and `literal` walk in');
  assert.equal(textOf(all(d, 'strong')[0]), 'bold');
  assert.equal(textOf(all(d, 'em')[0]), 'quiet');
  assert.equal(textOf(all(d, 'code')[0]), 'literal');
});

test('underscores inside a word are left alone', () => {
  // snake_case_names appear in these files constantly.
  const d = render('the wake_on_launch setting');
  assert.equal(all(d, 'em').length, 0);
  assert.match(textOf(d), /wake_on_launch/);
});

test('blockquotes, joined across lines', () => {
  // SOUL.md quotes the user's own words back, wrapped.
  const d = render('> warmer and\n> conversational\n\nafter');
  const q = all(d, 'blockquote');
  assert.equal(q.length, 1);
  assert.equal(textOf(q[0]), 'warmer and conversational');
});

test('bulleted and numbered lists', () => {
  const d = render('- one\n- two\n\n1. first\n2. second');
  assert.equal(all(d, 'ul').length, 1);
  assert.equal(all(d, 'ol').length, 1);
  assert.equal(all(d, 'li').length, 4);
});

test('a wrapped list item stays one item', () => {
  // soul.js writes exactly this shape in SOUL.md's Boundaries section.
  const d = render('- Do not give generic advice. If there is nothing worth\n  saying, say nothing.\n- Second point.');
  const items = all(d, 'li');
  assert.equal(items.length, 2);
  assert.match(textOf(items[0]), /nothing worth saying, say nothing/);
});

test('fenced code is literal, including things that look like markdown', () => {
  const d = render('```\n# not a heading\n**not bold**\n```');
  const pre = all(d, 'pre');
  assert.equal(pre.length, 1);
  assert.equal(textOf(pre[0]), '# not a heading\n**not bold**');
  assert.equal(all(d, 'h1').length, 0);
  assert.equal(all(d, 'strong').length, 0);
});

test('horizontal rules', () => {
  assert.equal(all(render('a\n\n---\n\nb'), 'hr').length, 1);
});

// --- what it refuses -------------------------------------------------------

test('raw HTML is shown, never built', () => {
  // The whole reason this renderer constructs nodes instead of strings.
  const nasty = '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<b>bold?</b>';
  const d = render(nasty);
  assert.equal(all(d, 'script').length, 0, 'no script element may exist');
  assert.equal(all(d, 'img').length, 0, 'no image element may exist');
  assert.equal(all(d, 'b').length, 0, 'not even a harmless one');
  // It survives as readable text, so the user can see what is in their file.
  assert.match(textOf(d), /<script>alert\(1\)<\/script>/);
  assert.match(textOf(d), /onerror=alert\(2\)/);
});

test('links are inert: text and a visible destination, never an anchor', () => {
  // A file fren wrote must not be able to put a clickable target in front of
  // anyone, and a remote destination would be a phone-home either way.
  const d = render('see [the docs](https://example.com/x) for more');
  assert.equal(all(d, 'a').length, 0, 'no anchor is created');
  const span = all(d, 'span').find((s) => s.className === 'md-link');
  assert.ok(span, 'the link renders as an inert span');
  assert.equal(textOf(span), 'the docs');
  assert.equal(span.title, 'https://example.com/x', 'the destination is shown, not followed');
});

test('a javascript: destination is no different — still inert', () => {
  const d = render('[click](javascript:alert(1))');
  assert.equal(all(d, 'a').length, 0);
  assert.equal(all(d, 'script').length, 0);
});

test('wiki links render as their own thing', () => {
  const d = render('related: [[fren-project-status]]');
  const w = all(d, 'span').find((s) => s.className === 'md-wiki');
  assert.ok(w);
  assert.equal(textOf(w), 'fren-project-status');
});

test('empty and absent input do not throw', () => {
  for (const input of ['', null, undefined, '\n\n\n']) {
    const d = render(input);
    assert.equal(d.tag, 'div');
  }
});

test('a pathological line cannot spin the inline scanner forever', () => {
  // Unbalanced delimiters are exactly what a hand-edited file contains.
  const d = render('*'.repeat(400) + '\n' + '_'.repeat(400) + '\n`' + 'x'.repeat(400));
  assert.ok(textOf(d).length > 0);
});

test('a real SOUL.md renders as its parts', () => {
  const soul = [
    '# SOUL', '',
    'Who fren is. Written from the first conversation with Santi on 2026-08-22.',
    'Edit this file freely.', '',
    '## How to talk to Santi', '',
    '> warmer and conversational', '',
    '_Their words. Follow them._', '',
    '## Boundaries', '',
    '- Never claim to have seen something that is not in the observed context.',
    '- Never imply the light was on when it was off.',
  ].join('\n');
  const d = render(soul);
  assert.equal(all(d, 'h1').length, 1);
  assert.equal(all(d, 'h2').length, 2);
  assert.equal(all(d, 'blockquote').length, 1);
  assert.equal(all(d, 'li').length, 2);
  assert.equal(all(d, 'em').length, 1);
});
