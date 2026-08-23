'use strict';
/**
 * What may and may not be configured.
 *
 * These are mostly refusals, and the refusals are the feature. fren's whole
 * security posture rests on the capture process never holding a credential and
 * never choosing where a credential gets sent, so the settings surface has to
 * be narrow on purpose rather than narrow by accident.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settings = require('../main/settings.js');

function store() {
  const m = new Map();
  return { getSetting: (k) => m.get(k) ?? null, setSetting: (k, v) => m.set(k, v) };
}

test('nothing configured means nothing overridden', () => {
  // Every empty field is "use whatever the gateway was started with", which is
  // what makes a fresh install work with no settings at all.
  const s = settings.read(store());
  assert.deepEqual(s, settings.EMPTY);
});

test('a real model id is kept', () => {
  const m = store();
  assert.equal(settings.write(m, { chatModel: 'deepseek-reasoner' }).chatModel, 'deepseek-reasoner');
  assert.equal(settings.write(m, { chatModel: 'claude-opus-5' }).chatModel, 'claude-opus-5');
  assert.equal(settings.read(m).chatModel, 'claude-opus-5', 'and it survives a reload');
});

test('anything that is not an id becomes the default rather than an error', () => {
  // A model id reaches a URL path and a JSON body. A bad preference must
  // degrade to the default — never to an error, and never to a request going
  // somewhere it was not meant to.
  const m = store();
  for (const bad of [
    '../../etc/passwd',
    'model with spaces',
    'https://evil.example.com/v1',
    'a'.repeat(200),
    '<script>',
    'model\nInjected: header',
    42, null, {}, [],
  ]) {
    assert.equal(settings.write(m, { chatModel: bad }).chatModel, '',
      `must refuse: ${JSON.stringify(bad)}`);
  }
});

test('a voice id is held to the same shape as a model id', () => {
  // It is interpolated into an ElevenLabs URL path.
  const m = store();
  assert.equal(settings.write(m, { voiceId: '21m00Tcm4TlvDq8ikWAM' }).voiceId, '21m00Tcm4TlvDq8ikWAM');
  assert.equal(settings.write(m, { voiceId: '../../../v1/history' }).voiceId, '');
});

test('a whisper model path is only kept if the file is really there', () => {
  const m = store();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-w-'));
  const real = path.join(dir, 'ggml-base.en.bin');
  fs.writeFileSync(real, 'not really a model, but it exists');

  assert.equal(settings.write(m, { whisperModel: real }).whisperModel, real);
  // A path that is not there turns every transcription into a confusing
  // failure, so it is refused now rather than discovered later.
  assert.equal(settings.write(m, { whisperModel: path.join(dir, 'missing.bin') }).whisperModel, '');
  assert.equal(settings.write(m, { whisperModel: dir }).whisperModel, '', 'a directory is not a model');
  assert.equal(settings.write(m, { whisperModel: '/etc/passwd' }).whisperModel, '', 'and neither is that');
});

test('a language is two letters or it is nothing', () => {
  const m = store();
  assert.equal(settings.write(m, { whisperLang: 'es' }).whisperLang, 'es');
  assert.equal(settings.write(m, { whisperLang: 'ES' }).whisperLang, 'es');
  for (const bad of ['spanish', '', 'e', 'esp', '--flag', 'es;rm -rf /']) {
    assert.equal(settings.write(m, { whisperLang: bad }).whisperLang, '', `must refuse: ${bad}`);
  }
});

test('there is no way to configure a key, an address, or which binary runs', () => {
  // The three refusals that matter. A key would put a secret in the process
  // that watches the screen; a base URL is where the key gets SENT, which makes
  // it an exfiltration primitive rather than a preference; and the whisper
  // binary is which executable gets launched, which is not a checkbox.
  const m = store();
  const saved = settings.write(m, {
    apiKey: 'sk-secret',
    ELEVENLABS_API_KEY: 'sk-secret',
    baseUrl: 'https://evil.example.com',
    elevenLabsBaseUrl: 'https://evil.example.com',
    whisperBin: '/tmp/evil',
  });
  assert.deepEqual(saved, settings.EMPTY, 'none of those are fields');
  for (const k of Object.keys(saved)) {
    assert.ok(!/key|token|secret|url|bin$/i.test(k), `${k} must not be settable`);
  }
  // And nothing unrecognised is carried through to storage.
  const raw = m.getSetting('providers');
  assert.deepEqual(Object.keys(raw).sort(), Object.keys(settings.EMPTY).sort());
});

test('one setting cannot clobber the others', () => {
  const m = store();
  settings.write(m, { chatModel: 'deepseek-chat' });
  settings.write(m, { whisperLang: 'es' });
  const s = settings.read(m);
  assert.equal(s.chatModel, 'deepseek-chat', 'still there after a later, unrelated write');
  assert.equal(s.whisperLang, 'es');
});

test('a corrupt stored value degrades to the defaults instead of throwing', () => {
  const broken = { getSetting: () => 'not an object', setSetting: () => {} };
  assert.deepEqual(settings.read(broken), settings.EMPTY);
  const throws = { getSetting: () => { throw new Error('db gone'); }, setSetting: () => {} };
  assert.deepEqual(settings.read(throws), settings.EMPTY);
});
