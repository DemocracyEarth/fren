'use strict';
/**
 * Which ear for which phrase: text → keyword spotting; a pretrained name or
 * an .onnx of your own → openWakeWord; a missing .onnx → the default phrase,
 * said so. And the factory hands the chosen module the resolved phrase.
 */
const test = require('node:test');
const assert = require('node:assert');
const { chooseEngine, createEngine, DEFAULT_PHRASE } = require('../main/wake-engines.js');

const exists = (p) => p === '/models/hey-fren.onnx';

test('the default phrase is "hey fren", by keyword spotting', () => {
  assert.equal(DEFAULT_PHRASE, 'hey fren');
  assert.deepEqual(chooseEngine('', { exists }), { kind: 'kws', keyword: 'hey fren' });
  assert.deepEqual(chooseEngine(undefined, { exists }), { kind: 'kws', keyword: 'hey fren' });
});

test('any other text is a phrase for keyword spotting, as written', () => {
  assert.deepEqual(chooseEngine('hey fren', { exists }), { kind: 'kws', keyword: 'hey fren' });
  assert.deepEqual(chooseEngine('  okay computer ', { exists }), { kind: 'kws', keyword: 'okay computer' });
});

test('a pretrained openWakeWord name goes to openWakeWord, normalised', () => {
  assert.deepEqual(chooseEngine('hey jarvis', { exists }), { kind: 'oww', keyword: 'hey jarvis' });
  assert.deepEqual(chooseEngine('Hey_Mycroft', { exists }), { kind: 'oww', keyword: 'hey mycroft' });
});

test('an .onnx of your own goes to openWakeWord if it exists; if not, the default phrase, said so', () => {
  assert.deepEqual(chooseEngine('/models/hey-fren.onnx', { exists }), { kind: 'oww', keyword: '/models/hey-fren.onnx' });
  const missing = chooseEngine('/models/nope.onnx', { exists });
  assert.equal(missing.kind, 'kws');
  assert.equal(missing.keyword, 'hey fren');
  assert.match(missing.note, /nope\.onnx not found/);
});

test('the factory picks the module and passes the resolved phrase through, logging a note when there is one', async () => {
  const calls = [];
  const engines = {
    kws: { createEngine: async (cfg) => { calls.push(['kws', cfg.keyword]); return { frameLength: 512 }; } },
    oww: { createEngine: async (cfg) => { calls.push(['oww', cfg.keyword]); return { frameLength: 1280 }; } },
  };
  const lines = [];
  assert.equal((await createEngine({ keyword: 'hey jarvis', modelsDir: '/m', log: (l) => lines.push(l) }, engines)).frameLength, 1280);
  assert.equal((await createEngine({ keyword: '', modelsDir: '/m', log: (l) => lines.push(l) }, engines)).frameLength, 512);
  assert.deepEqual(calls, [['oww', 'hey jarvis'], ['kws', 'hey fren']]);
  assert.deepEqual(lines, []);
});
