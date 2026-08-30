'use strict';
/**
 * The browser meta-prompt: what fren is told about the page, and how the
 * telling changes with the kind of page.
 */
const test = require('node:test');
const assert = require('node:assert');
const I = require('../index.js');

const browser = (over = {}) => ({
  browser: 'chrome',
  active: true,
  tab: { url: 'https://example.com/story', domain: 'example.com', title: 'A story' },
  page: { content: 'The readable words of the page.', contentType: 'article',
          description: 'a tale', excluded: false, truncated: false },
  selection: null,
  ...over,
});

test('pages are classified by their well-known homes', () => {
  const c = (url, domain, contentType = '') => I.classifyPage({ url, domain, contentType });
  assert.equal(c('https://news.ycombinator.com/item?id=1', 'news.ycombinator.com'), 'discussion');
  assert.equal(c('https://www.reddit.com/r/x/comments/1', 'reddit.com'), 'discussion');
  assert.equal(c('https://youtube.com/watch?v=1', 'youtube.com'), 'video');
  assert.equal(c('https://github.com/o/r/pull/1', 'github.com'), 'code');
  assert.equal(c('https://x.com/someone/status/1', 'x.com'), 'social');
  assert.equal(c('https://google.com/search?q=ducks', 'google.com'), 'search');
  assert.equal(c('https://en.wikipedia.org/wiki/Duck', 'en.wikipedia.org'), 'reference');
  assert.equal(c('https://docs.stripe.com/api', 'docs.stripe.com'), 'docs');
  assert.equal(c('https://blog.example.com/post', 'blog.example.com', 'article'), 'article');
  assert.equal(c('https://example.com/', 'example.com'), 'page');
});

test('a lookalike domain does not inherit a classification', () => {
  assert.equal(I.classifyPage({ url: 'https://notgithub.com/x', domain: 'notgithub.com' }), 'page');
  assert.equal(I.classifyPage({ url: 'https://github.com.evil.io/x', domain: 'github.com.evil.io' }), 'page');
});

test('the system prompt gains the browser sense only when a page is present', () => {
  const withPage = I.buildChatRequest({ question: 'q', browser: browser() });
  assert.ok(withPage.system.includes('You can also see the page open in their browser'),
    'the sense is declared');
  assert.ok(withPage.system.includes('The page is an article'), 'with type guidance');

  const without = I.buildChatRequest({ question: 'q' });
  assert.ok(!without.system.includes('You can also see the page'), 'no page, no claimed sense');
});

test('each kind brings its own guidance', () => {
  const hn = browser({ tab: { url: 'https://news.ycombinator.com/item?id=1',
                              domain: 'news.ycombinator.com', title: 'Thread' } });
  const req = I.buildChatRequest({ question: 'q', browser: hn });
  assert.ok(req.system.includes('discussion thread'), 'HN reads as a discussion');

  const yt = browser({ tab: { url: 'https://youtube.com/watch?v=1', domain: 'youtube.com', title: 'Clip' } });
  const req2 = I.buildChatRequest({ question: 'q', browser: yt });
  assert.ok(req2.system.includes('never the video itself'), 'video honesty is explicit');
});

test('the message carries the page, the selection, and the kind', () => {
  const b = browser({ selection: { text: 'the interesting bit' } });
  const req = I.buildChatRequest({ question: 'q', browser: b });
  const msg = req.messages[0].content;
  assert.ok(msg.includes('In the browser (chrome, focused)'), 'labeled block');
  assert.ok(msg.includes('"A story" — https://example.com/story'));
  assert.ok(msg.includes('SELECTED this text: "the interesting bit"'));
  assert.ok(msg.includes('The readable words of the page.'));
});

test('an excluded page contributes nothing anywhere', () => {
  const b = browser({ page: { excluded: true } });
  const req = I.buildChatRequest({ question: 'q', browser: b });
  assert.ok(!req.system.includes('You can also see'), 'no sense declared');
  assert.ok(!req.messages[0].content.includes('In the browser'), 'no block in the message');
});

test('a long excerpt is capped and the cap is declared', () => {
  const b = browser({ page: { content: 'y'.repeat(10_000), contentType: 'article', excluded: false } });
  const msg = I.buildChatRequest({ question: 'q', browser: b }).messages[0].content;
  const excerpt = msg.split('Readable page excerpt:')[1];
  assert.ok(excerpt.length < 3200, 'capped');
  assert.ok(excerpt.includes('[…]'), 'and honest about it');
});
