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
  const { text, actions } = parseReply('Nothing to change here — just chatting.');
  assert.equal(text, 'Nothing to change here — just chatting.');
  assert.equal(actions.length, 0);
});

test('a well-formed action is parsed off and the text stays clean', () => {
  const { text, actions } = parseReply(fenced('Done — I will stay asleep at launch.',
    '{"do":"wakeOnLaunch","on":false}'));
  assert.equal(text, 'Done — I will stay asleep at launch.');
  assert.deepEqual(actions[0], { do: 'wakeOnLaunch', on: false });
});

test('malformed JSON keeps the words and drops the deed', () => {
  const { text, actions } = parseReply(fenced('Changing it now!', '{"do": nope'));
  assert.equal(text, 'Changing it now!');
  assert.equal(actions.length, 0, 'a broken fence must never half-apply');
});

test('unknown verbs are refused, whatever they claim', () => {
  for (const body of ['{"do":"deleteEverything"}', '{"do":"exec","cmd":"rm -rf"}',
                      '{"not":"even close"}', '"just a string"', '[]']) {
    assert.equal(parseReply(fenced('ok', body)).actions.length, 0, body);
  }
});

test('colours resolve by word, preset name, and hex — and clamp', () => {
  assert.equal(resolveColour('teal'), 0x11a8a8, 'the word finds Lagoon');
  assert.equal(resolveColour('Mulberry'), 0xa259d9, 'the preset name works');
  assert.equal(resolveColour('#11a8a8'), 0x11a8a8, 'plain hex passes');
  assert.equal(resolveColour('222222'), P.usable(0x222222),
    'a too-dark hex is clamped by the same rule the dashboard used');
  assert.equal(resolveColour('taupe-ish'), null, 'a non-colour is refused');
  assert.equal(parseReply(fenced('ok', '{"do":"colour","value":"nonsense"}')).actions.length, 0,
    'and a refused colour kills the whole action');
});

test('a fence anywhere is parsed, and never reaches the words', () => {
  // Models confirm after acting: "done ```fence``` anything else?" — an
  // end-anchored parser let that block leak into the transcript and the
  // VOICE, which read the JSON aloud.
  const chatty = 'Resetting now.\n```fren-action\n{"do":"lookReset"}\n```\nDone — anything else?';
  const { text, actions } = parseReply(chatty);
  assert.deepEqual(actions, [{ do: 'lookReset' }]);
  assert.equal(text, 'Resetting now. Done — anything else?');
  assert.ok(!/fren-action/.test(text), 'the fence never reaches the words');
});

test('two fences is not a conversation: all refused, all stripped', () => {
  const twice = 'a\n```fren-action\n{"do":"lookReset"}\n```\nb\n```fren-action\n{"do":"debugLog"}\n```';
  const { text, actions } = parseReply(twice);
  assert.equal(actions.length, 0);
  assert.ok(!/fren-action/.test(text), 'even refused fences never reach the voice');
});

test('booleans are coerced, never trusted', () => {
  assert.deepEqual(parseReply(fenced('ok', '{"do":"watch","on":"true"}')).actions[0],
    { do: 'watch', on: true });
  assert.deepEqual(parseReply(fenced('ok', '{"do":"interrupt","on":1}')).actions[0],
    { do: 'interrupt', on: false }, 'only true and "true" mean yes');
});

test('the debug log is a verb too', () => {
  assert.deepEqual(
    parseReply(fenced('Opening my train of thought.', '{"do":"debugLog"}')).actions,
    [{ do: 'debugLog' }]);
});

test('face colours are freer than the body, and still not free', () => {
  const { resolveFaceColour } = require('../main/actions.js');
  assert.equal(resolveFaceColour('white'), 0xffffff, 'eyes may be white; the body may not');
  assert.equal(resolveFaceColour('#000000'), 0x000000, 'any hex passes verbatim');
  assert.equal(resolveFaceColour('default'), 0, 'zero means back to the classic glow');
  assert.equal(resolveFaceColour('sparkly'), null, 'a non-colour is still refused');
  assert.deepEqual(
    parseReply(fenced('Eyes going white!', '{"do":"faceColour","part":"eyes","value":"white"}')).actions,
    [{ do: 'faceColour', part: 'eyes', hex: 0xffffff }]);
  const both = parseReply(fenced('ok', '{"do":"faceColour","value":"teal"}')).actions[0];
  assert.equal(both.part, 'both', 'no part named means both features');
  assert.equal(parseReply(fenced('ok', '{"do":"faceColour","part":"eyes","value":"???"}')).actions.length, 0,
    'and a refused colour dies alone');
});

test('an array in the fence is several deeds; each vetted alone', () => {
  const { actions } = parseReply(fenced('Teal eyes, pink mouth — done.',
    '[{"do":"faceColour","part":"eyes","value":"teal"},'
    + '{"do":"faceColour","part":"mouth","value":"pink"},'
    + '{"do":"nonsense"}]'));
  assert.equal(actions.length, 2, 'the bad one died alone');
  assert.deepEqual(actions[0], { do: 'faceColour', part: 'eyes', hex: 0x11a8a8 });
  assert.deepEqual(actions[1], { do: 'faceColour', part: 'mouth', hex: 0xff6fa5 });
});
