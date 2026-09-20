'use strict';
/**
 * What fren is allowed to say about its wake word. Each of these is a claim a
 * person will read on the hover card, in the input, or in fren's one
 * explanation — so each is pinned: the phrase is only ever the real one, the
 * alias only for keyword spotting, the hotkey only when it is really bound,
 * and a blocked microphone is promised nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const { wakePhrase, hotkeyLabel, wakeInfo, hintVoiceRow, voiceIntroCopy, PHRASE_FITS } = require('../main/wake-info.js');

const OWN = '/data/wake/hey-fren.onnx';
const none = () => false;
const all = () => true;

test('the phrase: "hey fren" by default, with the honest aside that "hey friend" wakes it too', () => {
  assert.deepEqual(wakePhrase(undefined, OWN, { exists: none }), { keyword: 'hey fren', phrase: 'hey fren', alias: true });
  assert.deepEqual(wakePhrase('', OWN, { exists: none }), { keyword: 'hey fren', phrase: 'hey fren', alias: true });
});

test('your own trained hey-fren.onnx is still "hey fren" — but a trained model is never said to take "hey friend"', () => {
  assert.deepEqual(wakePhrase(undefined, OWN, { exists: all }), { keyword: OWN, phrase: 'hey fren', alias: false });
  assert.deepEqual(wakePhrase('/x/Hey-Fren.onnx', OWN, { exists: all }), { keyword: '/x/Hey-Fren.onnx', phrase: 'hey fren', alias: false });
});

test('a custom text phrase is quoted as configured, lower-cased; a pretrained name is its phrase', () => {
  assert.deepEqual(wakePhrase('  Okay   Fren ', OWN, { exists: none }), { keyword: 'Okay   Fren', phrase: 'okay fren', alias: false });
  const jarvis = wakePhrase('hey_jarvis', OWN, { exists: none });
  assert.equal(jarvis.phrase, 'hey jarvis');
  assert.equal(jarvis.alias, false);
  assert.equal(wakePhrase('Hey Fren', OWN, { exists: none }).alias, true, 'the default, however it is typed');
});

test('any other model file has no phrase at all — "my wake word", never a guess', () => {
  assert.deepEqual(wakePhrase('/x/computer.onnx', OWN, { exists: all }), { keyword: '/x/computer.onnx', phrase: null, alias: false });
});

test('a model file that is not there falls back to "hey fren", as the engine does', () => {
  assert.deepEqual(wakePhrase('/x/gone.onnx', OWN, { exists: none }), { keyword: '/x/gone.onnx', phrase: 'hey fren', alias: true });
});

test('the hotkey is named only when it is the default AND it registered', () => {
  assert.equal(hotkeyLabel({ custom: '', registered: true, platform: 'darwin' }), '⌘⇧Space');
  assert.equal(hotkeyLabel({ custom: '', registered: false, platform: 'darwin' }), null, 'taken by another app');
  assert.equal(hotkeyLabel({ custom: 'Alt+F', registered: true, platform: 'darwin' }), null, 'a custom key is not guessed at');
  assert.equal(hotkeyLabel(), null);
});

const listening = { listening: true, arming: false, access: 'granted', deaf: false, label: 'x' };
const base = { observing: true, gatewayOk: true, voiceAgent: true, phrase: 'hey fren', alias: true, hotkey: '⌘⇧Space' };

test('armed means really hearing: not loading, not deaf', () => {
  assert.deepEqual(wakeInfo({ ...base, status: listening }), {
    armed: true, phrase: 'hey fren', alias: true, paused: false, micBlocked: false, canConverse: true, hotkey: '⌘⇧Space',
  });
  assert.equal(wakeInfo({ ...base, status: { ...listening, listening: false, arming: true } }).armed, false, 'loading');
  const deaf = wakeInfo({ ...base, status: { ...listening, deaf: true } });
  assert.equal(deaf.armed, false);
  assert.equal(deaf.micBlocked, true);
});

test('a refused microphone is blocked; "unknown" and not-yet-asked are not', () => {
  for (const access of ['denied', 'restricted', 'unavailable (no tccd)']) {
    assert.equal(wakeInfo({ ...base, status: { ...listening, listening: false, access } }).micBlocked, true, access);
  }
  for (const access of ['granted', 'unknown', null]) {
    assert.equal(wakeInfo({ ...base, status: { ...listening, access } }).micBlocked, false, String(access));
  }
});

test('paused is the light being off — and only when there is a wake word to pause', () => {
  assert.equal(wakeInfo({ ...base, observing: false, status: { ...listening, listening: false } }).paused, true);
  assert.equal(wakeInfo({ ...base, observing: false, status: null }).paused, false, 'FREN_WAKE_WORD=off');
});

test('a conversation can open only with the gateway up AND an agent behind it', () => {
  assert.equal(wakeInfo({ ...base, status: listening, gatewayOk: false }).canConverse, false);
  assert.equal(wakeInfo({ ...base, status: listening, voiceAgent: false }).canConverse, false);
  assert.deepEqual(wakeInfo(), { armed: false, phrase: null, alias: false, paused: false, micBlocked: false, canConverse: false, hotkey: null });
});

test('the hover card: the phrase when armed, holding when paused, and nothing at all for a blocked microphone', () => {
  const armed = wakeInfo({ ...base, status: listening });
  assert.deepEqual(hintVoiceRow(armed), { kind: 'say', phrase: 'hey fren' });
  assert.deepEqual(hintVoiceRow({ ...armed, phrase: null }), { kind: 'say', phrase: null });
  assert.deepEqual(hintVoiceRow({ ...armed, phrase: 'x'.repeat(PHRASE_FITS + 1) }), { kind: 'say', phrase: null }, 'too long to quote: "my wake word"');
  assert.deepEqual(hintVoiceRow({ ...armed, phrase: 'x'.repeat(PHRASE_FITS) }), { kind: 'say', phrase: 'x'.repeat(PHRASE_FITS) });
  const paused = wakeInfo({ ...base, observing: false, status: { ...listening, listening: false } });
  assert.deepEqual(hintVoiceRow(paused), { kind: 'hold' });
  assert.equal(hintVoiceRow({ ...paused, micBlocked: true }), null, 'holding needs the same microphone');
  assert.equal(hintVoiceRow({ ...armed, armed: false, micBlocked: true }), null);
  assert.equal(hintVoiceRow({ ...armed, canConverse: false }), null, 'no agent: no promise');
  assert.equal(hintVoiceRow({ ...paused, canConverse: false }), null);
  assert.equal(hintVoiceRow({ ...armed, armed: false }), null, 'still loading: say nothing yet');
  assert.equal(hintVoiceRow(null), null);
});

test('the one explanation: truthful about sound, and only ever about sound', () => {
  const text = voiceIntroCopy(wakeInfo({ ...base, status: listening }));
  assert.match(text, /say “hey fren”/);
  assert.match(text, /No sound leaves your Mac until I hear it/);
  assert.match(text, /only while my light is on/);
  assert.match(text, /mic dot in your menu bar stays lit/);
  assert.match(text, /Holding me down, or ⌘⇧Space, opens the same line\./);
  assert.match(text, /“hey friend” works too/);
  assert.doesNotMatch(text, /nothing leaves/i, 'the screen notes DO reach a cloud model');
});

test('the explanation drops what is not true here: no hotkey, no alias, no guessed phrase', () => {
  const custom = voiceIntroCopy({ phrase: 'okay fren', alias: false, hotkey: null });
  assert.match(custom, /say “okay fren”/);
  assert.match(custom, /Holding me down opens the same line\.$/);
  assert.doesNotMatch(custom, /⌘|hey friend/i);
  assert.match(voiceIntroCopy({ phrase: null }), /just say my wake word and/);
});
