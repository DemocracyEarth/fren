'use strict';
/**
 * The wake word's clockwork, without a microphone or a key: a fake engine that
 * says "the word" when told to, a fake recorder that hands over frames on
 * demand. What matters is arming only when asked, waking exactly once per
 * detection, and letting the microphone go — every time, on every path.
 *
 * Every test that arms disarms in `t.after`, so a failed assertion can never
 * leave the fake recorder polling and keep the runner alive.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createWakeListener, resolveKeyword } = require('../main/wake-word.js');

function fakes() {
  const made = { porcupines: [], recorders: [] };
  const pending = [];                 // frames the recorder will hand over, in order
  const say = (idx) => pending.push(idx);
  class Porcupine {
    constructor(key, keywords, sensitivities) {
      this.key = key; this.keywords = keywords; this.sensitivities = sensitivities;
      this.frameLength = 512; this.released = false;
      made.porcupines.push(this);
    }
    process(frame) { return frame.idx; }
    release() { this.released = true; }
  }
  class PvRecorder {
    constructor(frameLength) { this.frameLength = frameLength; this.isRecording = false; this.released = false; made.recorders.push(this); }
    start() { this.isRecording = true; }
    stop() { this.isRecording = false; }
    release() { this.released = true; }
    async read() {
      // Yield until there is a frame to give, or until released.
      for (;;) {
        if (this.released) throw new Error('released');
        if (pending.length) { const idx = pending.shift(); return { idx }; }
        await new Promise((r) => setTimeout(r, 1));
      }
    }
  }
  const BuiltinKeyword = { PORCUPINE: 'porcupine', COMPUTER: 'computer', JARVIS: 'jarvis' };
  return { deps: { Porcupine, PvRecorder, BuiltinKeyword }, made, say };
}

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('arms with the key, the word and the sensitivity, and starts the microphone', (t) => {
  const { deps, made } = fakes();
  const w = createWakeListener({ accessKey: 'k', keyword: 'jarvis', sensitivity: 0.7, deps, log: () => {} });
  t.after(() => w.disarm());
  assert.equal(w.arm(), true);
  assert.equal(w.armed(), true);
  assert.deepEqual(made.porcupines[0].keywords, ['jarvis']);
  assert.deepEqual(made.porcupines[0].sensitivities, [0.7]);
  assert.equal(made.recorders[0].isRecording, true);
  assert.match(w.label(), /built-in word "jarvis"/);
});

test('hearing the word wakes once, and a second hearing inside the debounce does not', async (t) => {
  const { deps, say } = fakes();
  let now = 1000;
  const wakes = [];
  const w = createWakeListener({ accessKey: 'k', deps, log: () => {}, now: () => now, onWake: () => wakes.push(now) });
  t.after(() => w.disarm());
  w.arm();
  say(0); await settle();
  assert.deepEqual(wakes, [1000], 'the first hearing counts');
  say(0); await settle();            // same instant: debounced
  assert.deepEqual(wakes, [1000]);
  now = 4000;
  say(0); await settle();            // later: a new wake
  assert.deepEqual(wakes, [1000, 4000]);
});

test('silence is silence: frames without the word never wake', async (t) => {
  const { deps, say } = fakes();
  const wakes = [];
  const w = createWakeListener({ accessKey: 'k', deps, log: () => {}, onWake: () => wakes.push(1) });
  t.after(() => w.disarm());
  w.arm();
  say(-1); say(-1); say(-1); await settle();
  assert.deepEqual(wakes, []);
});

test('disarming lets the microphone and the engine go', (t) => {
  const { deps, made } = fakes();
  const w = createWakeListener({ accessKey: 'k', deps, log: () => {} });
  t.after(() => w.disarm());
  w.arm();
  w.disarm();
  assert.equal(w.armed(), false);
  assert.equal(made.recorders[0].isRecording, false);
  assert.equal(made.recorders[0].released, true);
  assert.equal(made.porcupines[0].released, true);
});

test('arming twice is one microphone; disarming twice is fine', (t) => {
  const { deps, made } = fakes();
  const w = createWakeListener({ accessKey: 'k', deps, log: () => {} });
  t.after(() => w.disarm());
  w.arm(); w.arm();
  assert.equal(made.recorders.length, 1);
  w.disarm(); w.disarm();
  assert.equal(w.armed(), false);
});

test('no key, no listening', () => {
  const { deps, made } = fakes();
  const lines = [];
  const w = createWakeListener({ accessKey: '', deps, log: (l) => lines.push(l) });
  assert.equal(w.arm(), false);
  assert.equal(made.recorders.length, 0);
  assert.ok(lines.some((l) => /no access key/.test(l)));
});

test('a microphone that fails to start is released, and the listener stays disarmed', () => {
  const { deps, made } = fakes();
  deps.PvRecorder = class extends deps.PvRecorder { start() { throw new Error('no device'); } };
  const lines = [];
  const w = createWakeListener({ accessKey: 'k', deps, log: (l) => lines.push(l) });
  assert.equal(w.arm(), false);
  assert.equal(w.armed(), false);
  assert.equal(made.porcupines[0].released, true);
  assert.ok(lines.some((l) => /could not arm: no device/.test(l)));
});

test('a microphone lost mid-listen disarms and releases', async (t) => {
  const { deps, made } = fakes();
  const lines = [];
  const w = createWakeListener({ accessKey: 'k', deps, log: (l) => lines.push(l) });
  t.after(() => w.disarm());
  w.arm();
  made.recorders[0].released = true;     // the next read() throws
  await settle(15);
  assert.equal(w.armed(), false);
  assert.equal(made.porcupines[0].released, true);
  assert.ok(lines.some((l) => /microphone lost/.test(l)));
});

test('the keyword: a .ppn that exists, a built-in by name, else porcupine', () => {
  const B = { PORCUPINE: 'porcupine', COMPUTER: 'computer', HEY_SIRI: 'hey siri' };
  const exists = (p) => p === '/models/hey-fren.ppn';
  assert.deepEqual(resolveKeyword('/models/hey-fren.ppn', B, exists), { keyword: '/models/hey-fren.ppn', label: 'custom model hey-fren.ppn' });
  assert.equal(resolveKeyword('/models/missing.ppn', B, exists).keyword, 'porcupine');
  assert.equal(resolveKeyword('computer', B, exists).keyword, 'computer');
  assert.equal(resolveKeyword('hey siri', B, exists).keyword, 'hey siri');
  assert.equal(resolveKeyword('', B, exists).keyword, 'porcupine');
  assert.equal(resolveKeyword('nonsense', B, exists).keyword, 'porcupine');
});
