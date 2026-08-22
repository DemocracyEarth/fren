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

// ---------------------------------------------------------------------------
// The microphone lifecycle.
//
// docs/privacy.md offers the macOS recording indicator as a second source of
// truth for "fren only listens while you are holding it". That promise is only
// true if the stream is genuinely handed back after every recording, so these
// assert the handing back rather than the recording.

const { createMic } = require('../renderer/mic.js');

/** Minimal getUserMedia + MediaRecorder so the lifecycle can be driven. */
function installFakes({ tracks } = {}) {
  const saved = {
    navigator: globalThis.navigator,
    MediaRecorder: globalThis.MediaRecorder,
  };
  const handed = [];
  const nextTracks = tracks || (() => [{ readyState: 'live', stop() { this.readyState = 'ended'; } }]);

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        async getUserMedia() {
          const t = nextTracks();
          const stream = { getTracks: () => t };
          handed.push(stream);
          return stream;
        },
      },
    },
    configurable: true,
    writable: true,
  });

  let recorder = null;
  globalThis.MediaRecorder = class {
    constructor(stream) {
      this.stream = stream;
      this.state = 'inactive';
      recorder = this;
    }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      if (this.onstop) this.onstop();
    }
  };

  return {
    handed,
    get recorder() { return recorder; },
    liveCount: () => handed.filter((s) => s.getTracks().some((t) => t.readyState === 'live')).length,
    restore() {
      Object.defineProperty(globalThis, 'navigator', {
        value: saved.navigator, configurable: true, writable: true,
      });
      globalThis.MediaRecorder = saved.MediaRecorder;
    },
  };
}

test('the microphone is handed back when a recording ends, not held for the session', async () => {
  const g = installFakes();
  try {
    const mic = createMic();
    await mic.start();
    assert.equal(g.liveCount(), 1, 'held while recording');
    // Under the 350ms floor, so it resolves null without needing to decode.
    const wav = await mic.stop();
    assert.equal(wav, null, 'too short to be speech');
    assert.equal(g.liveCount(), 0, 'released the moment the recording ended');
  } finally {
    g.restore();
  }
});

test('cancel() discards the recording and hands the microphone back', async () => {
  const g = installFakes();
  try {
    const mic = createMic();
    await mic.start();
    mic.cancel();
    assert.equal(mic.isRecording(), false);
    assert.equal(g.liveCount(), 0, 'a cancelled recording must not leave the mic open');
  } finally {
    g.restore();
  }
});

test('a track that died is replaced rather than reused', async () => {
  let n = 0;
  const g = installFakes({
    // The first stream comes back already dead — a device change or a
    // sleep/wake. Reusing it would record silence forever without erroring.
    tracks: () => [n++ === 0
      ? { readyState: 'ended', stop() {} }
      : { readyState: 'live', stop() { this.readyState = 'ended'; } }],
  });
  try {
    const mic = createMic();
    await mic.warmUp();
    await mic.warmUp();
    assert.equal(g.handed.length, 2, 'must re-acquire rather than reuse a dead track');
  } finally {
    g.restore();
  }
});

test('two recordings in a row both work', async () => {
  const g = installFakes();
  try {
    const mic = createMic();
    await mic.start();
    await mic.stop();
    // The reported bug was that voice worked exactly once. Whatever the cause,
    // a second round trip must still acquire, record and release.
    await mic.start();
    assert.equal(mic.isRecording(), true, 'second recording must start');
    assert.equal(g.liveCount(), 1, 'and must hold a live microphone');
    await mic.stop();
    assert.equal(g.liveCount(), 0);
    assert.equal(g.handed.length, 2, 'one acquisition per recording');
  } finally {
    g.restore();
  }
});
