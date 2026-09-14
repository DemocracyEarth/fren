'use strict';
/**
 * The wake word's clockwork, without a microphone, models or a network: a fake
 * engine that says "the phrase" when told to, a fake recorder that hands over
 * frames on demand. What matters is arming only when asked, waking exactly
 * once per detection, and letting the microphone go — every time, on every
 * path. Every test that arms disarms in `t.after`, so a failed assertion can
 * never leave the fake recorder polling and keep the runner alive.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createWakeListener } = require('../main/wake-word.js');

function fakes({ engineFails = false } = {}) {
  const made = { engines: [], recorders: [] };
  const pending = [];                 // frames the recorder will hand over, in order
  const say = (idx) => pending.push({ idx });
  const feed = (frame) => pending.push(frame);
  const createEngine = async (cfg) => {
    if (engineFails) throw new Error('models missing');
    const e = { cfg, frameLength: 1280, released: false, label: `built-in phrase "${cfg.keyword || 'hey jarvis'}"`,
      process: async (frame) => frame.idx, release() { this.released = true; } };
    made.engines.push(e);
    return e;
  };
  class PvRecorder {
    constructor(frameLength) { this.frameLength = frameLength; this.isRecording = false; this.released = false; made.recorders.push(this); }
    start() { this.isRecording = true; }
    stop() { this.isRecording = false; }
    release() { this.released = true; }
    async read() {
      for (;;) {
        if (this.released) throw new Error('released');
        if (pending.length) return pending.shift();
        await new Promise((r) => setTimeout(r, 1));
      }
    }
  }
  return { deps: { createEngine, PvRecorder }, made, say, feed };
}

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('arms with the phrase and sensitivity, loads the engine, and starts the microphone', async (t) => {
  const { deps, made } = fakes();
  const w = createWakeListener({ keyword: 'hey jarvis', sensitivity: 0.7, modelsDir: '/tmp/x', engineOptions: { onsetRestart: false }, deps, log: () => {} });
  t.after(() => w.disarm());
  assert.equal(await w.arm(), true);
  assert.equal(w.armed(), true);
  assert.equal(made.engines[0].cfg.keyword, 'hey jarvis');
  assert.equal(made.engines[0].cfg.sensitivity, 0.7);
  assert.equal(made.engines[0].cfg.modelsDir, '/tmp/x');
  assert.equal(made.engines[0].cfg.onsetRestart, false, 'engine settings pass through');
  assert.equal(made.recorders[0].frameLength, 1280);
  assert.equal(made.recorders[0].isRecording, true);
  assert.match(w.label(), /built-in phrase "hey jarvis"/);
});

test('hearing the phrase wakes once, and a second hearing inside the debounce does not', async (t) => {
  const { deps, say } = fakes();
  let now = 1000;
  const wakes = [];
  const w = createWakeListener({ deps, log: () => {}, now: () => now, onWake: () => wakes.push(now) });
  t.after(() => w.disarm());
  await w.arm();
  say(0); await settle();
  assert.deepEqual(wakes, [1000], 'the first hearing counts');
  say(0); await settle();
  assert.deepEqual(wakes, [1000]);
  now = 4000;
  say(0); await settle();
  assert.deepEqual(wakes, [1000, 4000]);
});

test('silence is silence: frames without the phrase never wake', async (t) => {
  const { deps, say } = fakes();
  const wakes = [];
  const w = createWakeListener({ deps, log: () => {}, onWake: () => wakes.push(1) });
  t.after(() => w.disarm());
  await w.arm();
  say(-1); say(-1); say(-1); await settle();
  assert.deepEqual(wakes, []);
});

test('disarming lets the microphone and the engine go', async (t) => {
  const { deps, made } = fakes();
  const w = createWakeListener({ deps, log: () => {} });
  t.after(() => w.disarm());
  await w.arm();
  w.disarm();
  assert.equal(w.armed(), false);
  assert.equal(made.recorders[0].isRecording, false);
  assert.equal(made.recorders[0].released, true);
  assert.equal(made.engines[0].released, true);
});

test('arming twice is one microphone (even while still arming); disarming twice is fine', async (t) => {
  const { deps, made } = fakes();
  const w = createWakeListener({ deps, log: () => {} });
  t.after(() => w.disarm());
  const a = w.arm();
  assert.equal(w.armed(), true, 'counts as armed while the engine loads');
  await Promise.all([a, w.arm()]);
  assert.equal(made.recorders.length, 1);
  w.disarm(); w.disarm();
  assert.equal(w.armed(), false);
});

test('an engine that cannot load leaves the listener disarmed, in words', async () => {
  const { deps, made } = fakes({ engineFails: true });
  const lines = [];
  const w = createWakeListener({ deps, log: (l) => lines.push(l) });
  assert.equal(await w.arm(), false);
  assert.equal(w.armed(), false);
  assert.equal(made.recorders.length, 0);
  assert.ok(lines.some((l) => /could not arm: models missing/.test(l)));
});

test('a microphone that fails to start is released, and the listener stays disarmed', async () => {
  const { deps, made } = fakes();
  deps.PvRecorder = class extends deps.PvRecorder { start() { throw new Error('no device'); } };
  const lines = [];
  const w = createWakeListener({ deps, log: (l) => lines.push(l) });
  assert.equal(await w.arm(), false);
  assert.equal(w.armed(), false);
  assert.equal(made.engines[0].released, true);
  assert.ok(lines.some((l) => /could not arm: no device/.test(l)));
});

test('the microphone is asked for before anything else; a refusal is no engine, no recorder, and one line', async () => {
  const { deps, made } = fakes();
  const lines = [];
  let asked = 0;
  const w = createWakeListener({ deps, log: (l) => lines.push(l), micAccess: async () => { asked += 1; return 'denied'; } });
  assert.equal(await w.arm(), false);
  assert.equal(w.armed(), false);
  assert.equal(made.engines.length, 0, 'no model is fetched for a microphone we may not use');
  assert.equal(made.recorders.length, 0, 'the recorder is never constructed');
  assert.equal(lines.filter((l) => /microphone denied/.test(l)).length, 1);
  assert.equal(await w.arm(), false);
  assert.equal(asked, 2, 'asked again on the next attempt (the answer may have changed)');
  assert.equal(lines.filter((l) => /microphone denied/.test(l)).length, 1, 'but said once');
});

test('granted arms; "unknown" (no such API on this platform) arms too; an asker that throws is a refusal in words', async (t) => {
  const { deps } = fakes();
  const ok = createWakeListener({ deps, log: () => {}, micAccess: async () => 'unknown' });
  t.after(() => ok.disarm());
  assert.equal(await ok.arm(), true);
  const lines = [];
  const broken = createWakeListener({ deps: fakes().deps, log: (l) => lines.push(l), micAccess: async () => { throw new Error('no tccd'); } });
  assert.equal(await broken.arm(), false);
  assert.ok(lines.some((l) => /microphone unavailable \(no tccd\)/.test(l)));
});

test('ten seconds of digital silence from the microphone is said once; hearing again is said once', async (t) => {
  const { deps, feed } = fakes();
  const lines = [];
  let now = 0;
  const w = createWakeListener({ deps, log: (l) => lines.push(l), now: () => now });
  t.after(() => w.disarm());
  await w.arm();
  const zeros = () => new Int16Array(512);
  feed(zeros()); await settle();
  now = 5000; feed(zeros()); await settle();
  assert.equal(lines.filter((l) => /hearing nothing/.test(l)).length, 0, 'five seconds is not yet a verdict');
  now = 11000; feed(zeros()); await settle();
  now = 12000; feed(zeros()); await settle();
  assert.equal(lines.filter((l) => /hearing nothing from the microphone/.test(l)).length, 1);
  const room = new Int16Array(512); room[7] = 3;
  feed(room); await settle();
  feed(room); await settle();
  assert.equal(lines.filter((l) => /hearing the microphone again/.test(l)).length, 1);
});

test('a microphone lost mid-listen disarms and releases', async (t) => {
  const { deps, made } = fakes();
  const lines = [];
  const w = createWakeListener({ deps, log: (l) => lines.push(l) });
  t.after(() => w.disarm());
  await w.arm();
  made.recorders[0].released = true;     // the next read() throws
  await settle(15);
  assert.equal(w.armed(), false);
  assert.equal(made.engines[0].released, true);
  assert.ok(lines.some((l) => /microphone lost/.test(l)));
});
