'use strict';
/**
 * The openWakeWord row in Node, driven against a fake ONNX runtime: the exact
 * buffering — 76 frames per embedding, one embedding per 8 new frames, 16
 * embeddings before a verdict, openWakeWord's mel scaling — and the verdict
 * itself. A live run against the real models is at the bottom, and only runs
 * where the models are (FREN_WAKE_MODELS_DIR).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const oww = require('../main/wake-engine-oww.js');

/** A fake ONNX runtime whose keyword model answers from a queue of scores. */
function fakeOrt({ framesPerChunk = 5, scores = [], context = 16, declareContext = false, livekit = false } = {}) {
  const inName = livekit ? 'embeddings' : 'x.1';
  const outName = livekit ? 'score' : '53';
  const runs = { mel: 0, emb: 0, kw: 0 };
  const seen = { melInputs: [], embInputs: [] };
  class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
  const InferenceSession = {
    async create(file) {
      const name = path.basename(file);
      if (name.startsWith('melspectrogram')) return {
        inputNames: ['input'], outputNames: ['output'],
        async run(feeds) { runs.mel += 1; seen.melInputs.push(feeds.input); const d = new Float32Array(framesPerChunk * 32).fill(10); return { output: new Tensor('float32', d, [1, 1, framesPerChunk, 32]) }; },
        release() {},
      };
      if (name.startsWith('embedding')) return {
        inputNames: ['input_1'], outputNames: ['conv2d_19'],
        async run(feeds) { runs.emb += 1; seen.embInputs.push(feeds.input_1); return { conv2d_19: new Tensor('float32', new Float32Array(96).fill(0.5), [1, 1, 1, 96]) }; },
        release() {},
      };
      return {
        inputNames: [inName], outputNames: [outName],
        ...(declareContext ? { inputMetadata: [{ name: inName, isTensor: true, type: 'float32', shape: [1, context, 96] }] } : {}),
        async run(feeds) { runs.kw += 1; assert.deepEqual(feeds[inName].dims, [1, context, 96]); const s = scores.length ? scores.shift() : 0; return { [outName]: new Tensor('float32', new Float32Array([s]), [1, 1]) }; },
        release() {},
      };
    },
  };
  return { ort: { InferenceSession, Tensor }, runs, seen };
}

/** Stand-in model files of the release's exact sizes, so nothing is fetched. */
const SIZES = { 'melspectrogram.onnx': 1087958, 'embedding_model.onnx': 1326578, 'hey_jarvis_v0.1.onnx': 1271370 };
function modelsDirWithFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-oww-'));
  for (const [f, size] of Object.entries(SIZES)) fs.writeFileSync(path.join(dir, f), Buffer.alloc(size));
  return dir;
}

const chunk = () => new Int16Array(1280);

test('no verdict until there is enough audio: 76 frames, then 16 embeddings 8 frames apart', async () => {
  const { ort, runs } = fakeOrt({ framesPerChunk: 5 });
  const engine = await oww.createEngine({ ort, modelsDir: modelsDirWithFiles(), keyword: 'hey jarvis', fetchImpl: async () => { throw new Error('no network in tests'); } });
  let firstVerdictAt = null;
  for (let i = 1; i <= 60; i++) {
    const before = runs.kw;
    await engine.process(chunk());
    if (runs.kw > before && firstVerdictAt === null) firstVerdictAt = i;
  }
  // 76 frames for the first embedding (16 chunks of 5), then 15 more embeddings
  // at 8 frames each = 120 frames (24 chunks): ~40 chunks, ~3.2 s of audio.
  assert.ok(firstVerdictAt >= 38 && firstVerdictAt <= 42, `first verdict after ${firstVerdictAt} chunks`);
  assert.ok(runs.emb >= 16);
  engine.release();
});

test('each chunk is fed with the 480 samples before it (the reference cadence: 8 frames per 80 ms)', async () => {
  const { ort, seen } = fakeOrt({ framesPerChunk: 8 });
  const engine = await oww.createEngine({ ort, modelsDir: modelsDirWithFiles(), keyword: 'hey jarvis', fetchImpl: async () => { throw new Error('no network'); } });
  const a = new Int16Array(1280).fill(7);
  const b = new Int16Array(1280).fill(9);
  await engine.process(a);
  await engine.process(b);
  assert.deepEqual(seen.melInputs[0].dims, [1, 1760]);
  assert.equal(seen.melInputs[0].data[0], 0, 'zeros before the first chunk');
  assert.equal(seen.melInputs[0].data[480], 7);
  assert.equal(seen.melInputs[1].data[0], 7, 'the second chunk carries the tail of the first');
  assert.equal(seen.melInputs[1].data[479], 7);
  assert.equal(seen.melInputs[1].data[480], 9);
  engine.release();
});

test('the mel frames are scaled the way openWakeWord scales them (x/10 + 2)', async () => {
  const { ort, seen } = fakeOrt({ framesPerChunk: 5 });
  const engine = await oww.createEngine({ ort, modelsDir: modelsDirWithFiles(), keyword: 'hey jarvis', fetchImpl: async () => { throw new Error('no network'); } });
  for (let i = 0; i < 20; i++) await engine.process(chunk());
  assert.ok(seen.embInputs.length >= 1);
  const win = seen.embInputs[0];
  assert.deepEqual(win.dims, [1, 76, 32, 1]);
  assert.equal(win.data[0], 10 / 10 + 2);       // every fake mel value is 10 → 3
  engine.release();
});

test('at the reference cadence (8 frames per chunk) it is one embedding per chunk once primed — no burst when the window fills', async () => {
  const { ort, runs } = fakeOrt({ framesPerChunk: 8 });
  const engine = await oww.createEngine({ ort, modelsDir: modelsDirWithFiles(), keyword: 'hey jarvis', fetchImpl: async () => { throw new Error('no network'); } });
  const embAfter = [];
  for (let i = 1; i <= 30; i++) { await engine.process(chunk()); embAfter.push(runs.emb); }
  assert.equal(embAfter[8], 0, 'nine chunks = 72 frames: window not yet full');
  assert.equal(embAfter[9], 1, 'the tenth chunk fills the window (80 frames): the first embedding, and only one');
  for (let i = 10; i < 30; i++) assert.equal(embAfter[i], embAfter[i - 1] + 1, `chunk ${i + 1}: exactly one more embedding`);
  // 16 embeddings → the first verdict on the 25th chunk = 2.0 s of audio.
  assert.equal(runs.kw, 30 - 25 + 1);
  engine.release();
});

test('a score at or above the threshold is the phrase; below it is not', async () => {
  const { ort, runs } = fakeOrt({ framesPerChunk: 8, scores: [0.2, 0.9, 0.5, 0.49] });
  const engine = await oww.createEngine({ ort, modelsDir: modelsDirWithFiles(), keyword: 'hey jarvis', sensitivity: 0.5, fetchImpl: async () => { throw new Error('no network'); } });
  const verdicts = [];      // only from chunks that reached the keyword model
  for (let i = 0; i < 40; i++) { const before = runs.kw; const v = await engine.process(chunk()); if (runs.kw > before) verdicts.push(v); }
  // scores arrive in order: 0.2 → -1, 0.9 → 0, 0.5 → 0 (threshold 0.5), 0.49 → -1
  assert.deepEqual(verdicts.slice(0, 4), [-1, 0, 0, -1]);
  assert.equal(engine.threshold, 0.5);
  engine.release();
});

test('the number of embeddings the phrase model wants is read from the model (22 here), 16 when it says nothing', async () => {
  const declared = fakeOrt({ framesPerChunk: 8, context: 22, declareContext: true });
  const e22 = await oww.createEngine({ ort: declared.ort, modelsDir: modelsDirWithFiles(), keyword: 'hey jarvis', fetchImpl: async () => { throw new Error('no network'); } });
  assert.equal(e22.context, 22);
  for (let i = 0; i < 40; i++) await e22.process(chunk());   // the fake asserts every keyword input is [1, 22, 96]
  assert.equal(declared.runs.kw, 40 - 31 + 1, 'the first verdict once 22 embeddings exist: chunk 10 + 21 more');
  e22.release();
  const silent = fakeOrt({ framesPerChunk: 8 });
  const e16 = await oww.createEngine({ ort: silent.ort, modelsDir: modelsDirWithFiles(), keyword: 'hey jarvis', fetchImpl: async () => { throw new Error('no network'); } });
  assert.equal(e16.context, 16);
  e16.release();
});

test('sensitivity maps to a threshold around a base, clamped', () => {
  assert.equal(oww.thresholdFor(0.5), 0.5);
  assert.equal(oww.thresholdFor(0.9), 0.15);   // very sensitive, but never below 0.15
  assert.equal(oww.thresholdFor(0), 0.95);
  assert.equal(oww.thresholdFor('nope'), 0.5);
  assert.equal(oww.thresholdFor(0.5, 0.68), 0.68, 'a sidecar threshold is the base');
  assert.equal(oww.thresholdFor(0.75, 0.68), 0.34);
  assert.equal(oww.thresholdFor(0.25, 0.68), 0.95, 'clamped');
  assert.equal(oww.thresholdFor(0.5, 'junk'), 0.5);
});

test('a livekit-wakeword head is recognised by its tensor names and fed audio in -1..1; the sidecar carries its threshold', async () => {
  const dir = modelsDirWithFiles();
  const custom = path.join(dir, 'hey-fren.onnx');
  fs.writeFileSync(custom, 'lk');
  fs.writeFileSync(path.join(dir, 'hey-fren.json'), JSON.stringify({ threshold: 0.68, source: 'livekit-wakeword' }));
  const { ort, seen } = fakeOrt({ framesPerChunk: 8, livekit: true });
  const engine = await oww.createEngine({ ort, modelsDir: dir, keyword: custom, sensitivity: 0.5, fetchImpl: async () => { throw new Error('no network'); } });
  assert.equal(engine.family, 'livekit-wakeword');
  assert.equal(engine.audio, 'unit');
  assert.equal(engine.threshold, 0.68);
  assert.equal(engine.sidecar, path.join(dir, 'hey-fren.json'));
  assert.match(engine.label, /custom model hey-fren\.onnx \(livekit-wakeword head\)/);
  await engine.process(new Int16Array(1280).fill(7));
  assert.ok(Math.abs(seen.melInputs[0].data[480] - 7 / 32768) < 1e-9, 'scaled to -1..1 for this family');
  engine.release();
  // openWakeWord's own heads keep raw int16 values, as before.
  const { ort: ort2, seen: seen2 } = fakeOrt({ framesPerChunk: 8 });
  const plain = await oww.createEngine({ ort: ort2, modelsDir: dir, keyword: 'hey jarvis', fetchImpl: async () => { throw new Error('no network'); } });
  assert.equal(plain.family, 'openWakeWord');
  assert.equal(plain.audio, 'int16');
  assert.equal(plain.threshold, 0.5);
  assert.equal(plain.sidecar, null);
  await plain.process(new Int16Array(1280).fill(7));
  assert.equal(seen2.melInputs[0].data[480], 7);
  plain.release();
});

test('the sidecar: absent, unreadable, or nonsense is simply no sidecar; "audio" may override the family guess', () => {
  assert.deepEqual(oww.readSidecar('/m/x.onnx', () => '', () => false), {});
  assert.deepEqual(oww.readSidecar('/m/x.onnx', () => 'not json', () => true), {});
  assert.deepEqual(oww.readSidecar('/m/x.onnx', () => '{"threshold": "no", "audio": "float"}', () => true), { path: '/m/x.json', threshold: undefined, audio: undefined });
  assert.deepEqual(oww.readSidecar('/m/x.onnx', () => '{"threshold": 0.42, "audio": "int16"}', () => true), { path: '/m/x.json', threshold: 0.42, audio: 'int16' });
  assert.deepEqual(oww.readSidecar('/m/x.bin', () => '{}', () => true), {}, 'only beside an .onnx');
});

test('the phrase: a .onnx of your own if it exists, a pretrained phrase by name, else "hey jarvis"', () => {
  const exists = (p) => p === '/models/hey-fren.onnx';
  assert.deepEqual(oww.resolveKeyword('/models/hey-fren.onnx', exists), { kind: 'custom', file: '/models/hey-fren.onnx', label: 'custom model hey-fren.onnx' });
  assert.equal(oww.resolveKeyword('/models/missing.onnx', exists).name, 'hey jarvis');
  assert.equal(oww.resolveKeyword('hey_mycroft', exists).file, 'hey_mycroft_v0.1.onnx');
  assert.equal(oww.resolveKeyword('Alexa', exists).name, 'alexa');
  assert.equal(oww.resolveKeyword('', exists).name, 'hey jarvis');
});

test('ensureModels fetches what is missing from the release, checks sizes, and never fetches a custom model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-oww-fetch-'));
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const name = url.split('/').pop();
    const size = name === 'melspectrogram.onnx' ? 1087958 : name === 'embedding_model.onnx' ? 1326578 : 1271370;
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(size).buffer };
  };
  const files = await oww.ensureModels({ dir, keyword: 'hey jarvis', fetchImpl, log: () => {} });
  assert.equal(fetched.length, 3);
  assert.ok(fetched.every((u) => u.startsWith('https://github.com/dscripka/openWakeWord/releases/download/')));
  assert.equal(fs.statSync(files.melspectrogram).size, 1087958);
  // Present and the right size: nothing fetched the second time.
  const again = [];
  await oww.ensureModels({ dir, keyword: 'hey jarvis', fetchImpl: async (u) => { again.push(u); return fetchImpl(u); }, log: () => {} });
  assert.equal(again.length, 0);
  // A custom model is yours: only the two shared models are fetched.
  const custom = path.join(dir, 'hey-fren.onnx'); fs.writeFileSync(custom, 'mine');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-oww-fetch2-'));
  const f2 = [];
  const out = await oww.ensureModels({ dir: dir2, keyword: custom, fetchImpl: async (u) => { f2.push(u); return fetchImpl(u); }, log: () => {} });
  assert.equal(f2.length, 2);
  assert.equal(out.keyword, custom);
  assert.match(out.label, /custom model hey-fren\.onnx/);
});

test('a wrong-sized download is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-oww-bad-'));
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(10).buffer });
  await assert.rejects(oww.ensureModels({ dir, keyword: 'hey jarvis', fetchImpl, log: () => {} }), /expected 1087958/);
});

// --- live, with the real models and runtime, only where they are ---------------
const LIVE = process.env.FREN_WAKE_MODELS_DIR;
test('live: the real models score silence as not-the-phrase, without throwing', { skip: !LIVE ? 'set FREN_WAKE_MODELS_DIR to run' : false }, async () => {
  const engine = await oww.createEngine({ modelsDir: LIVE, keyword: 'hey jarvis', fetchImpl: async () => { throw new Error('offline'); } });
  let verdict = -1;
  for (let i = 0; i < 60; i++) verdict = await engine.process(new Int16Array(1280));
  assert.equal(verdict, -1);
  engine.release();
});
