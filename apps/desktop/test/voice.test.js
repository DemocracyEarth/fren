'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { encodeWav } = require('../renderer/mic.js');
const whisper = require('../main/whisper.js');

test('encodes 16kHz mono 16-bit WAV that whisper can read', () => {
  const samples = new Float32Array(1600);            // 100ms
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 6) * 0.6;
  const wav = encodeWav(samples, 16000);
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (off) => String.fromCharCode(...wav.slice(off, off + 4));

  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(tag(36), 'data');
  assert.equal(dv.getUint16(20, true), 1, 'PCM format');
  assert.equal(dv.getUint16(22, true), 1, 'mono');
  assert.equal(dv.getUint32(24, true), 16000, 'sample rate');
  assert.equal(dv.getUint16(34, true), 16, 'bit depth');
  assert.equal(dv.getUint32(40, true), samples.length * 2, 'data length');
  assert.equal(wav.length, 44 + samples.length * 2);
});

test('clamps samples instead of wrapping them', () => {
  const wav = encodeWav(Float32Array.from([2, -2]), 16000);
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(dv.getInt16(44, true), 32767);
  assert.equal(dv.getInt16(46, true), -32768);
});

test('whisper reports what is missing rather than throwing', () => {
  const saved = { ...process.env };
  process.env.PATH = path.join(os.tmpdir(), 'definitely-not-a-real-bin-dir');
  delete process.env.FREN_WHISPER_BIN;
  delete process.env.FREN_WHISPER_MODEL;
  try {
    const d = whisper.detect();
    assert.equal(d.ready, false);
    assert.match(d.reason, /whisper\.cpp is not installed/);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('whisper reports a missing model separately from a missing binary', () => {
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-whisper-'));
  const bin = path.join(dir, 'whisper-cli');
  fs.writeFileSync(bin, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  try {
    process.env.FREN_WHISPER_BIN = bin;
    process.env.FREN_WHISPER_MODEL = path.join(dir, 'nope.bin');
    const d = whisper.detect();
    assert.equal(d.ready, false);
    assert.match(d.reason, /model/i);

    fs.writeFileSync(path.join(dir, 'ggml.bin'), 'x');
    process.env.FREN_WHISPER_MODEL = path.join(dir, 'ggml.bin');
    const ok = whisper.detect();
    assert.equal(ok.ready, true);
    assert.equal(ok.bin, bin);
  } finally {
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transcription rejects with the reason when whisper is absent', async () => {
  const saved = { ...process.env };
  process.env.PATH = path.join(os.tmpdir(), 'definitely-not-a-real-bin-dir');
  delete process.env.FREN_WHISPER_BIN;
  delete process.env.FREN_WHISPER_MODEL;
  try {
    await assert.rejects(() => whisper.transcribe(Buffer.alloc(64)), /whisper\.cpp is not installed/);
  } finally {
    Object.assign(process.env, saved);
  }
});
