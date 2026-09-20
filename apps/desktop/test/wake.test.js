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

// --- status() and onChange: what the interface is allowed to claim ---------

test('status says arming while the engine loads and listening only once it hears; armed() is true for both', async (t) => {
  const { deps } = fakes();
  const changes = [];
  const w = createWakeListener({ deps, log: () => {}, onChange: () => changes.push(w.status().listening) });
  t.after(() => w.disarm());
  assert.deepEqual(w.status(), { listening: false, arming: false, access: null, deaf: false, label: '', retryAt: null });
  const arming = w.arm();
  assert.equal(w.armed(), true);
  assert.equal(w.status().arming, true);
  assert.equal(w.status().listening, false, 'loading is not listening');
  await arming;
  assert.deepEqual(w.status(), { listening: true, arming: false, access: 'granted', deaf: false, label: 'built-in phrase "hey jarvis"', retryAt: null });
  assert.deepEqual(changes, [true], 'armed is one change');
  w.disarm();
  assert.equal(w.status().listening, false);
  assert.deepEqual(changes, [true, false], 'disarmed is one change');
  w.disarm();
  assert.deepEqual(changes, [true, false], 'disarming twice is not a change');
});

test('a refused microphone is a change, and status carries the answer', async () => {
  const { deps } = fakes();
  let n = 0;
  const w = createWakeListener({ deps, log: () => {}, micAccess: async () => 'denied', onChange: () => { n += 1; } });
  await w.arm();
  assert.equal(n, 1);
  assert.equal(w.status().access, 'denied');
  assert.equal(w.status().listening, false);
});

test('an engine that cannot load, and a microphone that cannot start, are each a change', async () => {
  let n = 0;
  const broken = createWakeListener({ deps: fakes({ engineFails: true }).deps, log: () => {}, onChange: () => { n += 1; } });
  await broken.arm();
  assert.equal(n, 1);
  const { deps } = fakes();
  deps.PvRecorder = class extends deps.PvRecorder { start() { throw new Error('no device'); } };
  let m = 0;
  const mute = createWakeListener({ deps, log: () => {}, onChange: () => { m += 1; } });
  await mute.arm();
  assert.equal(m, 1);
  assert.equal(mute.status().listening, false);
});

test('going deaf and hearing again are each one change', async (t) => {
  const { deps, feed } = fakes();
  let now = 0;
  const seen = [];
  const w = createWakeListener({ deps, log: () => {}, now: () => now, onChange: () => seen.push(w.status().deaf) });
  t.after(() => w.disarm());
  await w.arm();
  const zeros = () => new Int16Array(512);
  feed(zeros()); await settle();
  now = 11000; feed(zeros()); await settle();
  now = 12000; feed(zeros()); await settle();
  const room = new Int16Array(512); room[3] = 9;
  feed(room); await settle();
  feed(room); await settle();
  assert.deepEqual(seen, [false, true, false], 'armed, deaf, hearing again');
});

test('a microphone lost, and an engine error, are each a change to not listening', async (t) => {
  const lost = fakes();
  const a = [];
  const w = createWakeListener({ deps: lost.deps, log: () => {}, onChange: () => a.push(w.status().listening) });
  t.after(() => w.disarm());
  await w.arm();
  lost.made.recorders[0].released = true;
  await settle(15);
  assert.deepEqual(a, [true, false]);

  const bad = fakes();
  const b = [];
  const v = createWakeListener({ deps: bad.deps, log: () => {}, onChange: () => b.push(v.status().listening) });
  t.after(() => v.disarm());
  await v.arm();
  bad.made.engines[0].process = async () => { throw new Error('bad frame'); };
  bad.say(-1); await settle();
  assert.deepEqual(b, [true, false]);
});

test('an onChange that throws never stops the listening', async (t) => {
  const { deps, say } = fakes();
  const wakes = [];
  const w = createWakeListener({ deps, log: () => {}, onWake: () => wakes.push(1), onChange: () => { throw new Error('ui fell over'); } });
  t.after(() => w.disarm());
  assert.equal(await w.arm(), true);
  say(0); await settle();
  assert.deepEqual(wakes, [1]);
});

// --- an arm in flight can be cancelled -------------------------------------

/** A promise the test resolves when it chooses: an await that is still "in flight". */
function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { p, open };
}

test('disarming while the microphone is still being asked for cancels the arm: nothing is opened', async (t) => {
  const { deps, made } = fakes();
  const asked = gate();
  const changes = [];
  const lines = [];
  const w = createWakeListener({ deps, log: (l) => lines.push(l), micAccess: async () => { await asked.p; return 'granted'; }, onChange: () => changes.push({ ...w.status() }) });
  t.after(() => w.disarm());
  const arming = w.arm();
  assert.equal(w.armed(), true, 'still true while loading, for its callers');
  w.disarm();                         // the light went off, or the Mac locked
  assert.equal(w.armed(), false, 'and false at once when cancelled');
  asked.open();
  assert.equal(await arming, false);
  await settle();
  assert.equal(made.engines.length, 0, 'no engine is loaded for a cancelled arm');
  assert.equal(made.recorders.length, 0, 'and the microphone is never opened');
  assert.equal(w.status().listening, false);
  assert.equal(w.status().arming, false);
  assert.ok(changes.length >= 1, 'the interface is told');
  assert.ok(changes.every((c) => !c.listening));
  assert.ok(!lines.some((l) => /armed —/.test(l)), 'it never says it armed');
  assert.equal(w.status().retryAt, null, 'being cancelled is not a failure');
});

test('disarming while the engine is still loading cancels the arm: the engine it made is released', async (t) => {
  const { deps, made } = fakes();
  const loading = gate();
  const inner = deps.createEngine;
  deps.createEngine = async (cfg) => { await loading.p; return inner(cfg); };
  let n = 0;
  const w = createWakeListener({ deps, log: () => {}, onChange: () => { n += 1; } });
  t.after(() => w.disarm());
  const arming = w.arm();
  await settle();                     // past the microphone question, inside the engine load
  assert.equal(w.status().arming, true);
  w.disarm();
  loading.open();
  assert.equal(await arming, false);
  await settle();
  assert.equal(made.engines.length, 1);
  assert.equal(made.engines[0].released, true, 'what it made, it lets go');
  assert.equal(made.recorders.length, 0, 'the microphone is never opened');
  assert.equal(w.armed(), false);
  assert.equal(w.status().listening, false);
  assert.ok(n >= 1, 'onChange fired');
});

// On first run an engine load is a model download unpacked into one shared
// folder; two at once would write over each other. So the arm after a
// cancelled one waits for that load to finish — and then stands.
test('one engine load at a time: the arm after a cancelled one waits its turn, then stands', { timeout: 5000 }, async (t) => {
  const { deps, made } = fakes();
  const first = gate();
  let calls = 0;
  const inner = deps.createEngine;
  deps.createEngine = async (cfg) => { calls += 1; if (calls === 1) await first.p; return inner(cfg); };
  const w = createWakeListener({ deps, log: () => {} });
  t.after(() => { first.open(); w.disarm(); });
  const a = w.arm();
  await settle();
  w.disarm();                         // light off…
  const b = w.arm();                  // …and on again, before the first load came back
  await settle();
  assert.equal(calls, 1, 'the second load does not start under the first');
  assert.equal(w.armed(), true, 'and it counts as armed while it waits');
  first.open();
  assert.equal(await a, false);
  assert.equal(await b, true);
  assert.equal(calls, 2);
  assert.equal(w.status().listening, true, 'the second arm stands');
  assert.equal(made.recorders.length, 1, 'one microphone');
  assert.equal(made.engines.filter((e) => !e.released).length, 1, 'one engine; the cancelled one was let go');
});

test('an arm cancelled while it waits its turn loads nothing', { timeout: 5000 }, async (t) => {
  const { deps, made } = fakes();
  const first = gate();
  let calls = 0;
  const inner = deps.createEngine;
  deps.createEngine = async (cfg) => { calls += 1; if (calls === 1) await first.p; return inner(cfg); };
  const w = createWakeListener({ deps, log: () => {} });
  t.after(() => { first.open(); w.disarm(); });
  const a = w.arm();
  await settle();
  w.disarm();
  const b = w.arm();
  await settle();
  w.disarm();                         // …and off again, still behind the first load
  first.open();
  assert.equal(await a, false);
  assert.equal(await b, false);
  await settle();
  assert.equal(calls, 1, 'no second load for an arm nobody wants any more');
  assert.equal(made.engines[0].released, true);
  assert.equal(made.recorders.length, 0);
  assert.equal(w.armed(), false);
  assert.equal(w.status().retryAt, null, 'being cancelled is not a failure');
});

test('a frame still inside the engine when the listener is disarmed wakes nobody', async (t) => {
  const { deps, made, say } = fakes();
  const weighing = gate();
  const wakes = [];
  const lines = [];
  const w = createWakeListener({ deps, log: (l) => lines.push(l), onWake: () => wakes.push(1) });
  t.after(() => { weighing.open(); w.disarm(); });
  await w.arm();
  let inside = false;
  made.engines[0].process = async () => { inside = true; await weighing.p; return 0; };
  say(0); await settle();
  assert.equal(inside, true, 'the frame is being weighed');
  w.disarm();                         // the Mac locked, or the light went off, right then
  weighing.open(); await settle();    // …and the engine says "that was the phrase"
  assert.deepEqual(wakes, [], 'a disarmed listener opens no line');
  assert.ok(!lines.some((l) => /heard the phrase/.test(l)));
});

// --- backing off from a microphone that keeps failing ----------------------

/** A listener whose recorder cannot start while `broken.on` is true, on a clock the test moves. */
function flaky() {
  const f = fakes();
  const broken = { on: true };
  const Base = f.deps.PvRecorder;
  f.deps.PvRecorder = class extends Base { start() { if (broken.on) throw new Error('no device'); super.start(); } };
  const clock = { t: 100000 };
  const lines = [];
  const w = createWakeListener({ deps: f.deps, log: (l) => lines.push(l), now: () => clock.t });
  return { ...f, broken, clock, lines, w };
}

test('after a failed arm the next one is refused quietly — no line, no engine, no recorder — until the backoff has passed', async (t) => {
  const { w, made, clock, lines, broken } = flaky();
  t.after(() => w.disarm());
  assert.equal(await w.arm(), false);
  assert.equal(w.status().retryAt, 105000, 'five seconds');
  const said = lines.length;
  const engines = made.engines.length;
  const recorders = made.recorders.length;
  clock.t = 104999;
  assert.equal(await w.arm(), false);
  assert.equal(await w.arm(), false);
  assert.equal(lines.length, said, 'a refusal says nothing');
  assert.equal(made.engines.length, engines, 'loads no engine');
  assert.equal(made.recorders.length, recorders, 'opens no microphone');
  assert.equal(w.armed(), false);
  clock.t = 105000;
  broken.on = false;
  assert.equal(await w.arm(), true, 'allowed once the backoff has passed');
  assert.equal(w.status().retryAt, null);
});

test('the backoff doubles with every failure in a row, and stops at five minutes', async (t) => {
  const { w, clock } = flaky();
  t.after(() => w.disarm());
  const waits = [];
  for (let i = 0; i < 9; i++) {
    assert.equal(await w.arm(), false);
    const wait = w.status().retryAt - clock.t;
    waits.push(wait);
    clock.t += wait;
  }
  assert.deepEqual(waits, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
});

test('a lost microphone and an engine error each back off; disarming does not reset it', async (t) => {
  const lost = fakes();
  let now = 0;
  const w = createWakeListener({ deps: lost.deps, log: () => {}, now: () => now });
  t.after(() => w.disarm());
  await w.arm();
  lost.made.recorders[0].released = true;      // the next read() throws
  await settle(15);
  assert.equal(w.status().retryAt, 5000);
  w.disarm();
  assert.equal(w.status().retryAt, 5000, 'disarm leaves the backoff alone');
  assert.equal(await w.arm(), false, 'so arm/disarm cannot hammer a flapping device');
  assert.equal(lost.made.engines.length, 1);

  const bad = fakes();
  const v = createWakeListener({ deps: bad.deps, log: () => {}, now: () => now });
  t.after(() => v.disarm());
  await v.arm();
  bad.made.engines[0].process = async () => { throw new Error('bad frame'); };
  bad.say(-1); await settle();
  assert.equal(v.status().retryAt, 5000);
  assert.equal(await v.arm(), false);
});

test('thirty seconds of healthy listening resets the backoff; a shorter run does not', async (t) => {
  const { w, made, clock, broken, say } = flaky();
  t.after(() => w.disarm());
  assert.equal(await w.arm(), false);          // 5 s
  clock.t += 5000;
  assert.equal(await w.arm(), false);          // 10 s
  clock.t += 10000;
  broken.on = false;
  assert.equal(await w.arm(), true);
  clock.t += 29000; say(-1); await settle();   // listening, but not yet for long enough
  made.recorders[made.recorders.length - 1].released = true;
  await settle(15);
  assert.equal(w.status().retryAt - clock.t, 20000, 'a short run is the same flapping device: still doubling');
  clock.t += 20000;
  assert.equal(await w.arm(), true);
  clock.t += 30000; say(-1); await settle();   // a healthy run
  made.recorders[made.recorders.length - 1].released = true;
  await settle(15);
  assert.equal(w.status().retryAt - clock.t, 5000, 'back to the beginning');
});

test('arm({ fresh: true }) clears the backoff — the Mac was just unlocked', async (t) => {
  const { w, made, broken, clock } = flaky();
  t.after(() => w.disarm());
  assert.equal(await w.arm(), false);
  clock.t += 5000;
  assert.equal(await w.arm(), false);
  assert.equal(w.status().retryAt - clock.t, 10000);
  broken.on = false;
  const engines = made.engines.length;
  assert.equal(await w.arm(), false, 'still inside the window');
  assert.equal(made.engines.length, engines);
  assert.equal(await w.arm({ fresh: true }), true);
  assert.equal(w.status().retryAt, null);
  assert.equal(w.status().listening, true);
  // …and the count started over too: the next failure waits five seconds, not twenty.
  made.recorders[made.recorders.length - 1].released = true;
  await settle(15);
  assert.equal(w.status().retryAt - clock.t, 5000);
});

test('a microphone macOS refused is not backed off from: it is asked again every time, and said once', async () => {
  const { deps, made } = fakes();
  let asked = 0;
  const lines = [];
  const w = createWakeListener({ deps, log: (l) => lines.push(l), now: () => 0, micAccess: async () => { asked += 1; return 'denied'; } });
  assert.equal(await w.arm(), false);
  assert.equal(w.status().retryAt, null);
  assert.equal(await w.arm(), false);
  assert.equal(await w.arm(), false);
  assert.equal(asked, 3);
  assert.equal(made.engines.length, 0);
  assert.equal(lines.filter((l) => /microphone denied/.test(l)).length, 1);
});
