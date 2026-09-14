'use strict';
/**
 * The other way to hear a phrase: keyword spotting on a small streaming speech
 * model (sherpa-onnx, Apache-2.0 — code, binaries and model alike), where the
 * phrase is TEXT — "hey fren" — and needs no training at all.
 *
 *   16 kHz mono audio, 32 ms at a time (512 samples), scaled to -1..1
 *     → a streaming zipformer transducer (3.3M parameters, trained on 10,000 h
 *       of English) decodes, and a keyword search over its output watches for
 *       the phrase's tokens in order
 *     → "was that the phrase?" per step; nothing else is kept or transcribed.
 *
 * The phrase is given as sub-word pieces from the model's own vocabulary
 * ("▁HE Y ▁F RE N"), which this file works out from the text. That has to be
 * done here, in JavaScript, before the spotter exists: a piece the model does
 * not know makes the native side end the whole process, with no exception to
 * catch. So the text is tokenised and checked first, and an unpronounceable
 * phrase is an error in words.
 *
 * Speech onset restarts the spotter. sherpa resets its own stream after 1.5 s
 * of trailing silence, and a phrase that begins in the ~0.6 s before that reset
 * is wiped with it — about one wake attempt in four after a pause, in
 * continuous listening. So the engine watches loudness itself, and when
 * speech starts after a stretch of quiet it hands the spotter a fresh stream
 * primed with the last 0.8 s of audio: the phrase is then decoded whole, on a
 * stream that has warmed up on the silence before it. Measured on synthesized
 * voices this lifts recall from ~3 in 4 to ~9 in 10; FREN_WAKE_ONSET_RESTART=off
 * turns it off.
 *
 * Trade-off, plainly: a text keyword on a model this size cannot tell "hey
 * fren" from "hey friend" — both wake it, and depending on the voice so may
 * "hey fran" or "hey fred". The setting that rejects "hey friend" delays every
 * detection by a second or two and still passes the others, so it is not used;
 * these are aliases, and the docs say so.
 *
 * The model comes from sherpa-onnx's release, pinned by size and checksum,
 * fetched once into fren's data folder and pruned to the four files that are
 * loaded. Everything is injectable — the sherpa module, the fetch, the archive
 * extraction — so the logic tests without a model, a network or a microphone.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const MODEL = {
  name: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2',
  size: 17626723,
  sha256: 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a',
  files: {
    encoder: { file: 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', size: 4807159 },
    decoder: { file: 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', size: 277985 },
    joiner: { file: 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx', size: 163380 },
    tokens: { file: 'tokens.txt', size: 5006 },
  },
};

const SAMPLE_RATE = 16000;
const FRAME = 512;                 // samples per step: 32 ms at 16 kHz
const DEFAULT_PHRASE = 'hey fren';
const DEFAULT_SENSITIVITY = 0.5;
const KEYWORDS_SCORE = 1.0;        // sherpa's boost for the keyword path; its default

/** The onset restart: what counts as quiet, and when a restart is due. */
const ONSET = {
  lookbackMs: 800,     // audio handed to the fresh stream before the onset frame
  quietMs: 800,        // this much quiet before a loud frame makes it an onset
  minGapMs: 1000,      // never restart more often than this
  floorMin: 0.003,     // RMS below which a frame is quiet no matter what (≈ -50 dBFS)
  floorGain: 4,        // ...or below this multiple of the quietest recent frame
  floorWindowMs: 5000, // how far back "recent" reaches
};

/**
 * sensitivity 0..1 → the spotter's trigger threshold. 0.5 gives 0.25, sherpa's
 * own default. Measured: 0.35 still hears every voice, 0.45 hears one in four —
 * so the floor of sensitivity maps to 0.35 and no higher.
 */
function thresholdFor(sensitivity) {
  const s = Number(sensitivity);
  const clean = Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : DEFAULT_SENSITIVITY;
  const t = clean <= 0.5 ? 0.35 - 0.2 * clean : 0.25 - 0.4 * (clean - 0.5);
  return Math.round(t * 1000) / 1000;
}

/** The model's vocabulary: the first column of tokens.txt. */
function parseVocab(text) {
  const vocab = new Set();
  for (const line of String(text).split('\n')) {
    const piece = line.trim().split(/\s+/)[0];
    if (piece) vocab.add(piece);
  }
  return vocab;
}

/**
 * Text → the model's sub-word pieces, greedy longest match, the way
 * sentencepiece splits it for this vocabulary: each word starts with a "▁"
 * piece, the rest continues without. Throws — in words — on anything the
 * vocabulary cannot spell, so no unknown piece ever reaches the native side.
 */
function tokenize(phrase, vocab) {
  const words = String(phrase).toUpperCase().replace(/[^A-Z' ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('the phrase is empty');
  const pieces = [];
  for (const word of words) {
    let rest = word;
    let first = true;
    while (rest.length) {
      let best = null;
      for (let len = rest.length; len >= 1; len--) {
        const candidate = (first ? '▁' : '') + rest.slice(0, len);
        if (vocab.has(candidate)) { best = candidate; break; }
      }
      if (!best) throw new Error(`the model cannot spell "${rest[0]}" in "${word}" — the phrase must be plain English words`);
      pieces.push(best);
      rest = rest.slice(best.length - (first ? 1 : 0));
      first = false;
    }
  }
  return pieces;
}

/** One line of sherpa's keywords format: pieces, then the label it reports back. */
function keywordLine(phrase, vocab) {
  const label = String(phrase).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${tokenize(phrase, vocab).join(' ')} @${label}\n`;
}

/**
 * Speech onset after quiet, from per-frame loudness alone. Pure: call it once
 * per frame with the frame's RMS (of -1..1 samples) and its start time in ms
 * of audio; `true` means "restart the spotter before this frame". A frame is
 * loud above an adaptive floor — the quietest recent frame times a gain, never
 * below an absolute minimum — and an onset is a loud frame after enough quiet,
 * rate-limited so a stutter cannot restart twice.
 */
function createOnsetGate({ quietMs = ONSET.quietMs, minGapMs = ONSET.minGapMs, floorMin = ONSET.floorMin, floorGain = ONSET.floorGain, floorWindowMs = ONSET.floorWindowMs } = {}) {
  const recent = [];             // [tMs, rms] of the frames inside the floor window
  let lastLoudAt = -Infinity;    // the quiet before the very first frame counts as quiet
  let lastRestartAt = -Infinity; // the first onset always restarts, even right after arming
  return function gate(rms, tMs) {
    recent.push([tMs, rms]);
    while (recent.length && recent[0][0] < tMs - floorWindowMs) recent.shift();
    let quietest = Infinity;
    for (const [, r] of recent) if (r < quietest) quietest = r;
    const floor = Math.max(floorMin, floorGain * quietest);
    const loud = rms > floor;
    let restart = false;
    if (loud) {
      const quietBefore = tMs - lastLoudAt;
      if (quietBefore >= quietMs && tMs - lastRestartAt >= minGapMs) {
        restart = true;
        lastRestartAt = tMs;
      }
      lastLoudAt = tMs;
    }
    return restart;
  };
}

function tarExtract(archive, dir) {
  return new Promise((resolve, reject) => {
    // A Finder-launched app inherits launchd's PATH; name the system tar outright (bsdtar, bzip2 built in).
    execFile(process.platform === 'darwin' ? '/usr/bin/tar' : 'tar', ['-xjf', archive, '-C', dir], (err) => (err ? reject(err) : resolve()));
  });
}

function filesPresent(modelDir, spec) {
  return Object.values(spec.files).every((f) => {
    const p = path.join(modelDir, f.file);
    return fs.existsSync(p) && fs.statSync(p).size === f.size;
  });
}

/** Keep only what is loaded: the archive carries fp32 twins and test clips fren never reads. */
function prune(modelDir, spec) {
  const keep = new Set(Object.values(spec.files).map((f) => f.file));
  for (const entry of fs.readdirSync(modelDir)) {
    if (!keep.has(entry)) fs.rmSync(path.join(modelDir, entry), { recursive: true, force: true });
  }
}

/**
 * The model, present: fetched from the release when missing, checked by size
 * and checksum before it is unpacked, by file sizes after, then pruned.
 */
async function ensureModel({ dir, fetchImpl = fetch, extract = tarExtract, log = () => {}, spec = MODEL }) {
  const modelDir = path.join(dir, spec.name);
  if (filesPresent(modelDir, spec)) return modelDir;
  log(`[wake] fetching ${spec.name} (${(spec.size / 1e6).toFixed(1)} MB) from sherpa-onnx's release`);
  const res = await fetchImpl(spec.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${spec.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== spec.size) throw new Error(`${spec.name}: got ${buf.length} bytes, expected ${spec.size}`);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== spec.sha256) throw new Error(`${spec.name}: checksum mismatch — not unpacking it`);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, `${spec.name}.tar.bz2.part`);
  fs.writeFileSync(archive, buf);
  try { await extract(archive, dir); }
  finally { fs.rmSync(archive, { force: true }); }
  if (!filesPresent(modelDir, spec)) throw new Error(`${spec.name}: files missing or the wrong size after unpacking`);
  prune(modelDir, spec);
  return modelDir;
}

/**
 * An engine the wake listener can drive: `frameLength` samples per `process`
 * call, 0 when the phrase was just heard and -1 otherwise, and `release`.
 */
async function createEngine({ sherpa, modelsDir, keyword, sensitivity, onsetRestart = true, fetchImpl = fetch, extract = tarExtract, log = () => {}, spec = MODEL } = {}) {
  const lib = sherpa || require('sherpa-onnx-node');
  const modelDir = await ensureModel({ dir: modelsDir, fetchImpl, extract, log, spec });
  const vocab = parseVocab(fs.readFileSync(path.join(modelDir, spec.files.tokens.file), 'utf8'));
  const phrase = String(keyword || DEFAULT_PHRASE).trim() || DEFAULT_PHRASE;
  const line = keywordLine(phrase, vocab);        // throws before anything native exists
  const threshold = thresholdFor(sensitivity);

  const kws = new lib.KeywordSpotter({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, spec.files.encoder.file),
        decoder: path.join(modelDir, spec.files.decoder.file),
        joiner: path.join(modelDir, spec.files.joiner.file),
      },
      tokens: path.join(modelDir, spec.files.tokens.file),
      numThreads: 1,
      provider: 'cpu',
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: KEYWORDS_SCORE,
    keywordsThreshold: threshold,
    keywordsFile: '',
    keywordsBuf: line,
    keywordsBufSize: Buffer.byteLength(line),
  });
  let stream = kws.createStream();
  let released = false;

  // The last 0.8 s of audio, for priming a fresh stream at a speech onset.
  const ring = new Float32Array(Math.round(SAMPLE_RATE * ONSET.lookbackMs / 1000));
  let ringPos = 0;
  let ringFilled = 0;
  const gate = onsetRestart ? createOnsetGate() : null;
  let framesSeen = 0;
  let restarts = 0;

  function remember(samples) {
    for (let i = 0; i < samples.length; i++) {
      ring[ringPos] = samples[i];
      ringPos = (ringPos + 1) % ring.length;
    }
    ringFilled = Math.min(ringFilled + samples.length, ring.length);
  }
  function lookback() {
    const out = new Float32Array(ringFilled);
    if (ringFilled < ring.length) { out.set(ring.subarray(0, ringFilled)); return out; }
    out.set(ring.subarray(ringPos));
    out.set(ring.subarray(0, ringPos), ring.length - ringPos);
    return out;
  }
  function drain() {
    let heard = false;
    while (kws.isReady(stream)) {
      kws.decode(stream);
      const r = kws.getResult(stream);
      if (r && r.keyword) {
        heard = true;
        kws.reset(stream);          // PRIVACY: that it was heard, never what else was said
      }
    }
    return heard;
  }

  async function process(frame) {
    if (released) return -1;
    const samples = new Float32Array(frame.length);
    let energy = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i] / 32768;
      samples[i] = v;
      energy += v * v;
    }
    const tMs = (framesSeen * frame.length * 1000) / SAMPLE_RATE;
    framesSeen += 1;
    let heard = false;
    if (gate && gate(Math.sqrt(energy / frame.length), tMs)) {
      stream = kws.createStream();      // the old one is dropped; the binding frees it with the object
      restarts += 1;
      const back = lookback();
      if (back.length) {
        stream.acceptWaveform({ samples: back, sampleRate: SAMPLE_RATE });
        if (drain()) heard = true;
      }
    }
    remember(samples);
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    if (drain()) heard = true;
    return heard ? 0 : -1;
  }

  function release() {
    released = true;
    stream = null;
  }

  return {
    frameLength: FRAME,
    process,
    release,
    label: `phrase "${phrase}" (keyword spotting)`,
    threshold,
    tokens: line.trim(),
    onsetRestart: !!gate,
    stats: () => ({ restarts, framesSeen }),
  };
}

module.exports = { createEngine, ensureModel, tokenize, keywordLine, parseVocab, thresholdFor, createOnsetGate, MODEL, FRAME, ONSET, DEFAULT_PHRASE };
