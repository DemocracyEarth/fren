'use strict';
/**
 * Settings by conversation: the customs post.
 *
 * The model is offered five verbs and trusted with none of them. Everything
 * here is a way a reply could try to smuggle something else through — or a
 * way an honest reply could be mangled on arrival.
 */
const test = require('node:test');
const assert = require('node:assert');
const { parseReply, resolveColour } = require('../main/actions.js');
const P = require('../renderer/face/palette.js');

const fenced = (text, body) => `${text}\n\`\`\`fren-action\n${body}\n\`\`\``;

test('a plain reply passes through untouched, with no action', () => {
  const { text, action } = parseReply('Nothing to change here — just chatting.');
  assert.equal(text, 'Nothing to change here — just chatting.');
  assert.equal(action, null);
});

test('a well-formed action is parsed off and the text stays clean', () => {
  const { text, action } = parseReply(fenced('Done — I will stay asleep at launch.',
    '{"do":"wakeOnLaunch","on":false}'));
  assert.equal(text, 'Done — I will stay asleep at launch.');
  assert.deepEqual(action, { do: 'wakeOnLaunch', on: false });
});

test('malformed JSON keeps the words and drops the deed', () => {
  const { text, action } = parseReply(fenced('Changing it now!', '{"do": nope'));
  assert.equal(text, 'Changing it now!');
  assert.equal(action, null, 'a broken fence must never half-apply');
});

test('unknown verbs are refused, whatever they claim', () => {
  for (const body of ['{"do":"deleteEverything"}', '{"do":"exec","cmd":"rm -rf"}',
                      '{"not":"even close"}', '"just a string"', '[]']) {
    assert.equal(parseReply(fenced('ok', body)).action, null, body);
  }
});

test('colours resolve by word, preset name, and hex — and clamp', () => {
  assert.equal(resolveColour('teal'), 0x11a8a8, 'the word finds Lagoon');
  assert.equal(resolveColour('Mulberry'), 0xa259d9, 'the preset name works');
  assert.equal(resolveColour('#11a8a8'), 0x11a8a8, 'plain hex passes');
  assert.equal(resolveColour('222222'), P.usable(0x222222),
    'a too-dark hex is clamped by the same rule the dashboard used');
  assert.equal(resolveColour('taupe-ish'), null, 'a non-colour is refused');
  assert.equal(parseReply(fenced('ok', '{"do":"colour","value":"nonsense"}')).action, null,
    'and a refused colour kills the whole action');
});

test('the fence only counts at the END of the reply', () => {
  const sneaky = '```fren-action\n{"do":"watch","on":false}\n```\nBy the way, hello!';
  const { action } = parseReply(sneaky);
  assert.equal(action, null, 'a fence mid-reply is conversation, not command');
});

test('booleans are coerced, never trusted', () => {
  assert.deepEqual(parseReply(fenced('ok', '{"do":"watch","on":"true"}')).action,
    { do: 'watch', on: true });
  assert.deepEqual(parseReply(fenced('ok', '{"do":"interrupt","on":1}')).action,
    { do: 'interrupt', on: false }, 'only true and "true" mean yes');
});

test('the debug log is a verb too', () => {
  const { action } = parseReply(fenced('Opening my train of thought.', '{"do":"debugLog"}'));
  assert.deepEqual(action, { do: 'debugLog' });
});
