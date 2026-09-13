'use strict';
/**
 * Which ear to use for which phrase.
 *
 * Two engines hear the wake word, both on-device, both key-free:
 *   - openWakeWord (wake-engine-oww.js) for a phrase that exists as a trained
 *     model: one of its pretrained phrases by name ("hey jarvis" …), or an
 *     .onnx file of your own.
 *   - keyword spotting (wake-engine-kws.js) for any phrase given as plain
 *     text — "hey fren" — with no training at all.
 *
 * The choice is made from the phrase alone. The listener (wake-word.js) never
 * knows which it got: both answer the same question per frame.
 */
const fs = require('node:fs');
const { BUILTIN } = require('./wake-engine-oww');
const { DEFAULT_PHRASE } = require('./wake-engine-kws');

/** Pure: the phrase (or model path) → which engine, and what to hand it. */
function chooseEngine(keyword, { exists = fs.existsSync, builtins = BUILTIN } = {}) {
  const k = String(keyword || '').trim();
  if (!k) return { kind: 'kws', keyword: DEFAULT_PHRASE };
  if (/\.onnx$/i.test(k)) {
    if (exists(k)) return { kind: 'oww', keyword: k };
    return { kind: 'kws', keyword: DEFAULT_PHRASE, note: `${k} not found — listening for "${DEFAULT_PHRASE}" instead` };
  }
  const name = k.toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (builtins[name]) return { kind: 'oww', keyword: name };
  return { kind: 'kws', keyword: k };
}

/** The engine for the configured phrase. `engines` injects the two modules for tests. */
async function createEngine(cfg = {}, engines = null) {
  const choice = chooseEngine(cfg.keyword);
  if (choice.note && cfg.log) cfg.log(`[wake] ${choice.note}`);
  const mod = engines
    ? engines[choice.kind]
    : (choice.kind === 'oww' ? require('./wake-engine-oww') : require('./wake-engine-kws'));
  return mod.createEngine({ ...cfg, keyword: choice.keyword });
}

module.exports = { chooseEngine, createEngine, DEFAULT_PHRASE };
