'use strict';
/**
 * The wake-word detector: openWakeWord, on this machine, no account.
 *
 * openWakeWord (github.com/dscripka/openWakeWord, Apache-2.0) is three small
 * ONNX models in a row, and this file is that row in Node:
 *
 *   16 kHz mono audio, 80 ms at a time (1280 samples, handed over together
 *   with the 480 samples before them, exactly as the reference does)
 *     → melspectrogram model      : 8 frames × 32 mel bins per chunk, scaled x/10 + 2
 *     → a rolling buffer of frames; every 8 new frames, the last 76 frames
 *     → embedding model           : one 96-dim embedding
 *     → the last 16 embeddings
 *     → the keyword model         : one score, 0..1, "was that the phrase?"
 *
 * Nothing else happens to the audio: no transcription, nothing kept, nothing
 * sent. The two shared models and the pretrained phrases come from
 * openWakeWord's own release, fetched once into fren's data folder and checked
 * by size; a phrase of your own ("hey fren") is a model you trained with their
 * notebook, placed where fren looks for it. Everything is injectable — the ONNX
 * runtime, the fetch — so the buffering tests without models or a network.
 */
const fs = require('node:fs');
const path = require('node:path');

const RELEASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1';
const SHARED = {
  melspectrogram: { file: 'melspectrogram.onnx', size: 1087958 },
  embedding: { file: 'embedding_model.onnx', size: 1326578 },
};
/** openWakeWord's pretrained phrases: what fren can listen for before "hey fren" is trained. */
const BUILTIN = {
  'hey jarvis': { file: 'hey_jarvis_v0.1.onnx', size: 1271370 },
  'alexa': { file: 'alexa_v0.1.onnx' },
  'hey mycroft': { file: 'hey_mycroft_v0.1.onnx' },
  'hey rhasspy': { file: 'hey_rhasspy_v0.1.onnx' },
  'weather': { file: 'weather_v0.1.onnx' },
  'timer': { file: 'timer_v0.1.onnx' },
};

const FRAME = 1280;      // samples per step: 80 ms at 16 kHz
const LOOKBACK = 480;    // 3 × the 160-sample hop: with it, each step is exactly 8 mel frames
const MEL_BINS = 32;
const MEL_WINDOW = 76;   // mel frames per embedding
const MEL_STRIDE = 8;    // new frames between embeddings
const CONTEXT = 16;      // embeddings the keyword model sees (~2 s)
const EMB_DIM = 96;
const DEFAULT_SENSITIVITY = 0.5;

/** sensitivity 0..1 → the score a detection must reach. 0.5 is openWakeWord's own default. */
function thresholdFor(sensitivity) {
  const s = Number(sensitivity);
  const clean = Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : DEFAULT_SENSITIVITY;
  return Math.max(0.15, Math.min(0.95, 1 - clean));
}

/**
 * Which phrase to listen for: a model file of your own if the path exists,
 * else one of openWakeWord's pretrained phrases by name, else "hey jarvis" —
 * the pretrained phrase closest in shape to "hey fren".
 */
function resolveKeyword(keyword, exists = fs.existsSync) {
  const k = String(keyword || '').trim();
  if (/\.onnx$/i.test(k) && exists(k)) return { kind: 'custom', file: k, label: `custom model ${path.basename(k)}` };
  const name = k.toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (BUILTIN[name]) return { kind: 'builtin', name, file: BUILTIN[name].file, label: `built-in phrase "${name}"` };
  return { kind: 'builtin', name: 'hey jarvis', file: BUILTIN['hey jarvis'].file, label: 'built-in phrase "hey jarvis"' };
}

async function fetchTo(url, dest, { fetchImpl = fetch, expectedSize = null } = {}) {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (expectedSize && buf.length !== expectedSize) throw new Error(`${path.basename(dest)}: got ${buf.length} bytes, expected ${expectedSize}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, buf);      // whole or absent: never a half-written model
  fs.renameSync(`${dest}.part`, dest);
  return dest;
}

/**
 * The model files, present: the two shared models and the pretrained phrase
 * (if that is what is armed), fetched from openWakeWord's release when missing.
 * A custom phrase is never fetched — it is yours, already on disk.
 */
async function ensureModels({ dir, keyword, fetchImpl = fetch, log = () => {} }) {
  const resolved = resolveKeyword(keyword);
  const want = [
    { ...SHARED.melspectrogram, dest: path.join(dir, SHARED.melspectrogram.file) },
    { ...SHARED.embedding, dest: path.join(dir, SHARED.embedding.file) },
  ];
  if (resolved.kind === 'builtin') want.push({ ...BUILTIN[resolved.name], dest: path.join(dir, resolved.file) });
  for (const m of want) {
    const present = fs.existsSync(m.dest) && (!m.size || fs.statSync(m.dest).size === m.size);
    if (present) continue;
    log(`[wake] fetching ${m.file} from openWakeWord's release`);
    await fetchTo(`${RELEASE}/${m.file}`, m.dest, { fetchImpl, expectedSize: m.size || null });
  }
  return {
    melspectrogram: path.join(dir, SHARED.melspectrogram.file),
    embedding: path.join(dir, SHARED.embedding.file),
    keyword: resolved.kind === 'custom' ? resolved.file : path.join(dir, resolved.file),
    label: resolved.label,
  };
}

/**
 * An engine the wake listener can drive: `frameLength` samples per `process`
 * call, a score-based verdict (0 = the phrase, -1 = not), and `release`.
 */
async function createEngine({ ort, modelsDir, keyword, sensitivity, fetchImpl = fetch, log = () => {} } = {}) {
  const runtime = ort || require('onnxruntime-node');
  const files = await ensureModels({ dir: modelsDir, keyword, fetchImpl, log });
  // One thread each: a background listener that costs ~1% of a core should not
  // spin up three thread pools for models this small.
  const session = { intraOpNumThreads: 1, interOpNumThreads: 1 };
  const mel = await runtime.InferenceSession.create(files.melspectrogram, session);
  const emb = await runtime.InferenceSession.create(files.embedding, session);
  const kw = await runtime.InferenceSession.create(files.keyword, session);
  const threshold = thresholdFor(sensitivity);
  // How many embeddings the phrase model looks at: read from the model when the
  // runtime says (the reference does the same — 16 for the default 2 s clip,
  // but not for every model), else the default.
  const declared = kw.inputMetadata && kw.inputMetadata[0] && kw.inputMetadata[0].shape && kw.inputMetadata[0].shape[1];
  const context = Number.isInteger(declared) && declared > 0 ? declared : CONTEXT;

  const melBuf = [];          // Float32Array(32) per frame, newest last
  const embBuf = [];          // Float32Array(96), newest last
  let primed = false;         // has the window filled once (the first embedding taken)?
  let sinceEmbed = 0;         // new frames since the last embedding, once primed
  let tail = new Float32Array(LOOKBACK);   // the previous chunk's last 480 samples (zeros before the first)
  let released = false;

  async function embed() {
    const win = new Float32Array(MEL_WINDOW * MEL_BINS);
    const start = melBuf.length - MEL_WINDOW;
    for (let f = 0; f < MEL_WINDOW; f++) win.set(melBuf[start + f], f * MEL_BINS);
    const e = await emb.run({ [emb.inputNames[0]]: new runtime.Tensor('float32', win, [1, MEL_WINDOW, MEL_BINS, 1]) });
    embBuf.push(Float32Array.from(e[emb.outputNames[0]].data));
    while (embBuf.length > context) embBuf.shift();
  }

  async function process(frame) {
    if (released) return -1;
    // 1) mel frames for this chunk — fed with the 480 samples before it, so
    //    that 1280 new samples make exactly 8 frames, one embedding's stride —
    //    scaled the way openWakeWord scales them. int16 values go in as they
    //    are: the reference does not normalise, and neither does this.
    const x = new Float32Array(tail.length + frame.length);
    x.set(tail, 0);
    for (let i = 0; i < frame.length; i++) x[tail.length + i] = frame[i];
    tail = x.slice(x.length - LOOKBACK);
    const m = await mel.run({ [mel.inputNames[0]]: new runtime.Tensor('float32', x, [1, x.length]) });
    const out = m[mel.outputNames[0]];
    const frames = out.dims[out.dims.length - 2];
    for (let f = 0; f < frames; f++) {
      const row = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b++) row[b] = out.data[f * MEL_BINS + b] / 10 + 2;
      melBuf.push(row);
    }
    while (melBuf.length > MEL_WINDOW + 4 * MEL_STRIDE) melBuf.shift();

    // 2) the first embedding once the window has filled, then one for every
    //    8 new frames, each over the latest 76. Frames that arrived while the
    //    window was still filling are not "new" — counting them would make a
    //    burst of identical embeddings the moment it fills.
    let embedded = false;
    if (!primed) {
      if (melBuf.length < MEL_WINDOW) return -1;
      primed = true;
      sinceEmbed = melBuf.length - MEL_WINDOW;
      await embed();
      embedded = true;
    } else {
      sinceEmbed += frames;
    }
    while (sinceEmbed >= MEL_STRIDE) {
      sinceEmbed -= MEL_STRIDE;
      await embed();
      embedded = true;
    }
    if (!embedded || embBuf.length < context) return -1;

    // 3) the verdict, on the last `context` embeddings (16 ≈ 2 s).
    const feat = new Float32Array(context * EMB_DIM);
    for (let i = 0; i < context; i++) feat.set(embBuf[i], i * EMB_DIM);
    const s = await kw.run({ [kw.inputNames[0]]: new runtime.Tensor('float32', feat, [1, context, EMB_DIM]) });
    const score = Number(s[kw.outputNames[0]].data[0]);
    return score >= threshold ? 0 : -1;
  }

  function release() {
    released = true;
    for (const s of [mel, emb, kw]) { try { if (s.release) s.release(); } catch { /* gone */ } }
    melBuf.length = 0;
    embBuf.length = 0;
  }

  return { frameLength: FRAME, process, release, label: files.label, threshold, context };
}

module.exports = { createEngine, ensureModels, resolveKeyword, thresholdFor, BUILTIN, FRAME, MEL_WINDOW, MEL_STRIDE, CONTEXT };
