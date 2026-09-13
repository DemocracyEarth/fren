'use strict';
/**
 * Keyword spotting for a text phrase, against a fake sherpa module: the
 * tokeniser (which must refuse anything the model cannot spell BEFORE the
 * native side sees it), the keywords line, the threshold mapping, the model
 * fetch with its size and checksum checks and the pruning after, the onset
 * gate, and the per-frame verdict. A live run against the real model and
 * binding is at the bottom, and only runs where the model is
 * (FREN_KWS_MODELS_DIR: the folder that holds the sherpa-onnx-kws-… directory).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const kws = require('../main/wake-engine-kws.js');

/** A slice of the real vocabulary, enough to spell a few phrases. */
const VOCAB_TEXT = ['<blk> 0', '<sos/eos> 1', '<unk> 2', 'S 3', 'N 9', 'E 10', 'Y 17', 'R 24', 'RE 29', '▁HE 49', '▁F 55', 'EN 63', '▁ 90', '▁HELLO 200', 'LO 120', '▁SHE 121', 'CK 122', '▁WORLD 300', "'S 310"].join('\n');
const VOCAB = kws.parseVocab(VOCAB_TEXT);

test('"hey fren" → the pieces sentencepiece gives for this vocabulary', () => {
  assert.deepEqual(kws.tokenize('hey fren', VOCAB), ['▁HE', 'Y', '▁F', 'RE', 'N']);
  assert.equal(kws.keywordLine('hey fren', VOCAB), '▁HE Y ▁F RE N @HEY_FREN\n');
  assert.deepEqual(kws.tokenize('Hello, World!', VOCAB), ['▁HELLO', '▁WORLD'], 'punctuation and case do not matter');
});

test('a phrase the model cannot spell is refused in words, before anything native exists', () => {
  assert.throws(() => kws.tokenize('hey ñandú', VOCAB), /cannot spell/);
  assert.throws(() => kws.tokenize('hey zzz', VOCAB), /cannot spell "Z" in "ZZZ"/);
  assert.throws(() => kws.tokenize('   ', VOCAB), /empty/);
});

test('sensitivity → threshold: 0.5 is sherpa\'s default 0.25; the floor is 0.35 (0.45 misses real voices); the ceiling 0.05', () => {
  assert.equal(kws.thresholdFor(0.5), 0.25);
  assert.equal(kws.thresholdFor(0), 0.35);
  assert.equal(kws.thresholdFor(0.25), 0.3);
  assert.equal(kws.thresholdFor(0.75), 0.15);
  assert.equal(kws.thresholdFor(1), 0.05);
  assert.equal(kws.thresholdFor('nope'), 0.25);
});

test('the onset gate: loud after at least 0.8 s of quiet, at most once a second, above an adaptive floor', () => {
  const gate = kws.createOnsetGate();
  let t = 0;
  const feed = (rms, frames) => { let fired = 0; for (let i = 0; i < frames; i++, t += 32) if (gate(rms, t)) fired += 1; return fired; };
  assert.equal(feed(0.0005, 35), 0, 'quiet alone never fires');                 // 1.12 s
  assert.equal(feed(0.05, 1), 1, 'the first loud frame after quiet is an onset');
  assert.equal(feed(0.05, 10), 0, 'speech going on is not another onset');
  assert.equal(feed(0.0005, 20), 0);                                             // 0.64 s of quiet
  assert.equal(feed(0.05, 1), 0, 'less than 0.8 s of quiet does not count');
  assert.equal(feed(0.0005, 30), 0);                                             // 0.96 s
  assert.equal(feed(0.05, 1), 1, 'enough quiet again: an onset');
  // Adaptive floor: after seconds of steady noise, the floor sits above it.
  assert.equal(feed(0.01, 200), 0, 'steady noise: loud until the floor adapts (5 s), quiet after — never an onset');  // 6.4 s at rms 0.01 → floor 0.04
  assert.equal(feed(0.03, 1), 0, 'a frame under the adapted floor is not loud');
  assert.equal(feed(0.05, 1), 1, 'a frame over it, after that much quiet, is an onset');
  const strict = kws.createOnsetGate({ floorMin: 0.1 });
  assert.equal(strict(0.05, 2000), false, 'never below the absolute minimum');
});

/** A spec for a fake model: the archive is any bytes; extraction writes the files (plus clutter). */
function fakeSpec(dir) {
  const bytes = Buffer.from('not really a tarball');
  return {
    spec: {
      name: 'fake-kws-model', url: 'https://example.test/fake.tar.bz2', size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      files: { encoder: { file: 'enc.onnx', size: 3 }, decoder: { file: 'dec.onnx', size: 2 }, joiner: { file: 'join.onnx', size: 1 }, tokens: { file: 'tokens.txt', size: Buffer.byteLength(VOCAB_TEXT) } },
    },
    bytes,
    extract: async (archive, into) => {
      assert.ok(fs.existsSync(archive));
      const d = path.join(into, 'fake-kws-model'); fs.mkdirSync(path.join(d, 'test_wavs'), { recursive: true });
      fs.writeFileSync(path.join(d, 'enc.onnx'), 'abc'); fs.writeFileSync(path.join(d, 'dec.onnx'), 'ab'); fs.writeFileSync(path.join(d, 'join.onnx'), 'a');
      fs.writeFileSync(path.join(d, 'tokens.txt'), VOCAB_TEXT);
      fs.writeFileSync(path.join(d, 'enc.fp32.onnx'), 'x'.repeat(50)); fs.writeFileSync(path.join(d, 'README.md'), 'clutter'); fs.writeFileSync(path.join(d, 'test_wavs', '0.wav'), 'clutter');
    },
    dir,
  };
}

test('ensureModel fetches once, checks size and checksum, unpacks, verifies, prunes to what is loaded, and never fetches again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-kws-'));
  const { spec, bytes, extract } = fakeSpec(dir);
  const fetched = [];
  const fetchImpl = async (url) => { fetched.push(url); return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }; };
  const modelDir = await kws.ensureModel({ dir, fetchImpl, extract, spec, log: () => {} });
  assert.equal(modelDir, path.join(dir, 'fake-kws-model'));
  assert.deepEqual(fetched, [spec.url]);
  assert.ok(!fs.existsSync(path.join(dir, 'fake-kws-model.tar.bz2.part')), 'the archive is not left behind');
  assert.deepEqual(fs.readdirSync(modelDir).sort(), ['dec.onnx', 'enc.onnx', 'join.onnx', 'tokens.txt'], 'only the loaded files stay');
  await kws.ensureModel({ dir, fetchImpl, extract, spec, log: () => {} });
  assert.equal(fetched.length, 1);
});

test('a download of the wrong size or the wrong checksum is refused and nothing is unpacked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-kws-bad-'));
  const { spec, extract } = fakeSpec(dir);
  let extracted = 0;
  const ex = async (...a) => { extracted++; return extract(...a); };
  const wrongSize = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(3).buffer });
  await assert.rejects(kws.ensureModel({ dir, fetchImpl: wrongSize, extract: ex, spec, log: () => {} }), /expected 20/);
  const tampered = Buffer.from('not really a tarbalL');     // same size, one byte off
  const wrongSha = async () => ({ ok: true, status: 200, arrayBuffer: async () => tampered.buffer.slice(tampered.byteOffset, tampered.byteOffset + tampered.length) });
  await assert.rejects(kws.ensureModel({ dir, fetchImpl: wrongSha, extract: ex, spec, log: () => {} }), /checksum mismatch/);
  assert.equal(extracted, 0);
});

/** A fake sherpa module: records the config and every stream, answers from a script of results. */
function fakeSherpa(script = []) {
  const seen = { config: null, accepted: [], resets: 0, decodes: 0, streams: 0 };
  class KeywordSpotter {
    constructor(config) { seen.config = config; }
    createStream() { seen.streams += 1; return { acceptWaveform: (w) => { seen.accepted.push(w); this.pending = 1; } }; }
    isReady() { return this.pending-- > 0; }
    decode() { seen.decodes++; }
    getResult() { const r = script.length ? script.shift() : null; return r ? { keyword: r, tokens: '', timestamps: [] } : { keyword: '' }; }
    reset() { seen.resets++; }
  }
  return { sherpa: { KeywordSpotter }, seen };
}

async function readyModelDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-kws-ready-'));
  const { spec, bytes, extract } = fakeSpec(dir);
  await kws.ensureModel({ dir, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }), extract, spec, log: () => {} });
  return { dir, spec };
}
const offline = async () => { throw new Error('no network'); };

test('the spotter is built with the phrase\'s pieces, one thread, the mapped threshold — and the audio scaled to -1..1', async () => {
  const { dir, spec } = await readyModelDir();
  const { sherpa, seen } = fakeSherpa();
  const engine = await kws.createEngine({ sherpa, modelsDir: dir, keyword: 'hey fren', sensitivity: 0.5, spec, fetchImpl: offline });
  assert.equal(engine.frameLength, 512);
  assert.equal(seen.config.keywordsBuf, '▁HE Y ▁F RE N @HEY_FREN\n');
  assert.equal(seen.config.keywordsBufSize, Buffer.byteLength('▁HE Y ▁F RE N @HEY_FREN\n'));
  assert.equal(seen.config.keywordsFile, '');
  assert.equal(seen.config.keywordsThreshold, 0.25);
  assert.equal(seen.config.modelConfig.numThreads, 1);
  assert.match(seen.config.modelConfig.transducer.encoder, /enc\.onnx$/);
  assert.match(engine.label, /phrase "hey fren"/);
  const frame = new Int16Array(512); frame[0] = 32767; frame[1] = -32768;
  assert.equal(await engine.process(frame), -1);
  assert.equal(seen.accepted[0].sampleRate, 16000);
  assert.ok(Math.abs(seen.accepted[0].samples[0] - 32767 / 32768) < 1e-6);
  assert.equal(seen.accepted[0].samples[1], -1);
  engine.release();
});

test('hearing the phrase is 0 once, with the stream reset; silence is -1; released is always -1', async () => {
  const { dir, spec } = await readyModelDir();
  const { sherpa, seen } = fakeSherpa([null, 'HEY_FREN', null]);
  const engine = await kws.createEngine({ sherpa, modelsDir: dir, keyword: 'hey fren', spec, fetchImpl: offline });
  assert.equal(await engine.process(new Int16Array(512)), -1);
  assert.equal(await engine.process(new Int16Array(512)), 0);
  assert.equal(seen.resets, 1, 'reset after a hearing: nothing of what follows is kept');
  assert.equal(await engine.process(new Int16Array(512)), -1);
  engine.release();
  assert.equal(await engine.process(new Int16Array(512)), -1);
});

test('a speech onset after quiet restarts the spotter on a fresh stream, primed with the last 0.8 s, then fed the frame', async () => {
  const { dir, spec } = await readyModelDir();
  const { sherpa, seen } = fakeSherpa();
  const engine = await kws.createEngine({ sherpa, modelsDir: dir, keyword: 'hey fren', spec, fetchImpl: offline });
  assert.equal(engine.onsetRestart, true, 'on by default');
  assert.equal(seen.streams, 1);
  const quiet = new Int16Array(512);
  const loud = new Int16Array(512).fill(3000);
  for (let i = 0; i < 40; i++) await engine.process(quiet);          // 1.28 s of quiet
  assert.equal(seen.streams, 1, 'quiet alone never restarts');
  await engine.process(loud);
  assert.equal(seen.streams, 2, 'the onset frame opens a fresh stream');
  const fed = seen.accepted.slice(-2);
  assert.equal(fed[0].samples.length, 12800, 'primed with 0.8 s of look-back first');
  assert.equal(fed[1].samples.length, 512, 'then the onset frame itself');
  assert.equal(fed[1].samples[0], 3000 / 32768);
  assert.deepEqual(engine.stats(), { restarts: 1, framesSeen: 41 });
  await engine.process(loud);
  assert.equal(seen.streams, 2, 'speech going on does not restart again');
  for (let i = 0; i < 20; i++) await engine.process(quiet);          // 0.64 s — not enough quiet
  await engine.process(loud);
  assert.equal(seen.streams, 2);
  for (let i = 0; i < 30; i++) await engine.process(quiet);          // 0.96 s
  await engine.process(loud);
  assert.equal(seen.streams, 3, 'enough quiet again: another fresh stream');
  engine.release();
});

test('FREN_WAKE_ONSET_RESTART=off: one stream for the whole life of the engine', async () => {
  const { dir, spec } = await readyModelDir();
  const { sherpa, seen } = fakeSherpa();
  const engine = await kws.createEngine({ sherpa, modelsDir: dir, keyword: 'hey fren', spec, fetchImpl: offline, onsetRestart: false });
  assert.equal(engine.onsetRestart, false);
  for (let i = 0; i < 40; i++) await engine.process(new Int16Array(512));
  await engine.process(new Int16Array(512).fill(3000));
  assert.equal(seen.streams, 1);
  assert.deepEqual(engine.stats(), { restarts: 0, framesSeen: 41 });
  engine.release();
});

test('a phrase the model cannot spell never constructs the spotter', async () => {
  const { dir, spec } = await readyModelDir();
  const { sherpa, seen } = fakeSherpa();
  await assert.rejects(kws.createEngine({ sherpa, modelsDir: dir, keyword: 'hey ñandú', spec, fetchImpl: offline }), /cannot spell/);
  assert.equal(seen.config, null);
});

// --- live, with the real binding and model, only where they are -----------------
const LIVE = process.env.FREN_KWS_MODELS_DIR;
test('live: the real spotter builds for "hey fren", scores silence as not-the-phrase, and hears a clip if one is given', { skip: !LIVE ? 'set FREN_KWS_MODELS_DIR to run' : false }, async () => {
  const engine = await kws.createEngine({ modelsDir: LIVE, keyword: 'hey fren', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(engine.tokens, '▁HE Y ▁F RE N @HEY_FREN');
  let verdict = -1;
  for (let i = 0; i < 100; i++) verdict = Math.max(verdict, await engine.process(new Int16Array(512)));
  assert.equal(verdict, -1);
  const clip = process.env.FREN_KWS_CLIP;
  if (clip) {
    const b = fs.readFileSync(clip); const off = b.indexOf(Buffer.from('data')) + 8;
    const pcm = new Int16Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + b.length - ((b.length - off) % 2)));
    const padded = new Int16Array(pcm.length + 16000 * 3); padded.set(pcm, 16000);
    let hits = 0;
    for (let o = 0; o + 512 <= padded.length; o += 512) if (await engine.process(padded.subarray(o, o + 512)) === 0) hits++;
    assert.ok(hits >= 1, 'the clip should be heard');
  }
  engine.release();
});
