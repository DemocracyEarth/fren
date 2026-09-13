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
 * Trade-off, plainly: a text keyword on a model this size cannot tell "hey
 * fren" from "hey friend" — both wake it. The setting that separates them
 * delays every detection by a second or two and is not robust, so it is not
 * used; "hey friend" is an alias, and the docs say so.
 *
 * The model comes from sherpa-onnx's release, pinned by size and checksum,
 * fetched once into fren's data folder. Everything is injectable — the sherpa
 * module, the fetch, the archive extraction — so the logic tests without a
 * model, a network or a microphone.
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

const FRAME = 512;                 // samples per step: 32 ms at 16 kHz
const DEFAULT_PHRASE = 'hey fren';
const DEFAULT_SENSITIVITY = 0.5;
const KEYWORDS_SCORE = 1.0;        // sherpa's boost for the keyword path; its default

/**
 * sensitivity 0..1 → the spotter's trigger threshold. 0.5 gives 0.25, sherpa's
 * own default; anything at 0.5 or above misses real hearings, so the floor of
 * sensitivity maps to 0.45 and no lower.
 */
function thresholdFor(sensitivity) {
  const s = Number(sensitivity);
  const clean = Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : DEFAULT_SENSITIVITY;
  return Math.round(Math.max(0.05, Math.min(0.45, 0.45 - 0.4 * clean)) * 1000) / 1000;
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

function tarExtract(archive, dir) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xjf', archive, '-C', dir], (err) => (err ? reject(err) : resolve()));
  });
}

function filesPresent(modelDir, spec) {
  return Object.values(spec.files).every((f) => {
    const p = path.join(modelDir, f.file);
    return fs.existsSync(p) && fs.statSync(p).size === f.size;
  });
}

/**
 * The model, present: fetched from the release when missing, checked by size
 * and checksum before it is unpacked, and by file sizes after.
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
  return modelDir;
}

/**
 * An engine the wake listener can drive: `frameLength` samples per `process`
 * call, 0 when the phrase was just heard and -1 otherwise, and `release`.
 */
async function createEngine({ sherpa, modelsDir, keyword, sensitivity, fetchImpl = fetch, extract = tarExtract, log = () => {}, spec = MODEL } = {}) {
  const lib = sherpa || require('sherpa-onnx-node');
  const modelDir = await ensureModel({ dir: modelsDir, fetchImpl, extract, log, spec });
  const vocab = parseVocab(fs.readFileSync(path.join(modelDir, spec.files.tokens.file), 'utf8'));
  const phrase = String(keyword || DEFAULT_PHRASE).trim() || DEFAULT_PHRASE;
  const line = keywordLine(phrase, vocab);        // throws before anything native exists
  const threshold = thresholdFor(sensitivity);

  const kws = new lib.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
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

  async function process(frame) {
    if (released) return -1;
    const samples = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i++) samples[i] = frame[i] / 32768;
    stream.acceptWaveform({ samples, sampleRate: 16000 });
    let heard = false;
    while (kws.isReady(stream)) {
      kws.decode(stream);
      const r = kws.getResult(stream);
      if (r && r.keyword) {
        heard = true;
        kws.reset(stream);          // PRIVACY: that it was heard, never what else was said
      }
    }
    return heard ? 0 : -1;
  }

  function release() {
    released = true;
    stream = null;                  // the binding frees its handles with the objects
  }

  return { frameLength: FRAME, process, release, label: `phrase "${phrase}" (keyword spotting)`, threshold, tokens: line.trim() };
}

module.exports = { createEngine, ensureModel, tokenize, keywordLine, parseVocab, thresholdFor, MODEL, FRAME, DEFAULT_PHRASE };
