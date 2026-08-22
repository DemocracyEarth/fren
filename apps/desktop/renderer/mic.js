'use strict';
/**
 * Push-to-talk capture.
 *
 * Records while you hold the button, then hands back 16kHz mono WAV bytes for
 * whisper to transcribe locally. Nothing is captured unless you are holding
 * the button down, and the audio never leaves this machine.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FrenMic = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const TARGET_RATE = 16000;   // what whisper.cpp expects

  /** Encode mono Float32 samples as a 16-bit PCM WAV. */
  function encodeWav(samples, sampleRate) {
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);
    const ascii = (off, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);        // PCM chunk size
    view.setUint16(20, 1, true);         // format: PCM
    view.setUint16(22, 1, true);         // channels: mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);         // block align
    view.setUint16(34, 16, true);        // bits per sample
    ascii(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Uint8Array(bytes);
  }

  /** Decode the recording and resample it to 16kHz mono. */
  async function toWav(blob) {
    const raw = await blob.arrayBuffer();
    const ctx = new AudioContext();
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(raw);
    } finally {
      ctx.close();
    }
    const frames = Math.max(1, Math.round(decoded.duration * TARGET_RATE));
    const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const out = await offline.startRendering();
    return encodeWav(out.getChannelData(0), TARGET_RATE);
  }

  function createMic() {
    let stream = null;
    let recorder = null;
    let chunks = [];
    let startedAt = 0;

    return {
      /** Ask for the microphone once, so the OS prompt isn't mid-gesture. */
      async warmUp() {
        if (stream) return true;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        return true;
      },

      isRecording() {
        return !!recorder && recorder.state === 'recording';
      },

      async start() {
        await this.warmUp();
        if (this.isRecording()) return;
        chunks = [];
        startedAt = Date.now();
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.start();
      },

      /**
       * Stop and return WAV bytes, or null if it was too short to be speech.
       * @returns {Promise<Uint8Array|null>}
       */
      stop() {
        return new Promise((resolve, reject) => {
          if (!this.isRecording()) return resolve(null);
          const tooShort = Date.now() - startedAt < 350;
          recorder.onstop = async () => {
            try {
              if (tooShort || !chunks.length) return resolve(null);
              resolve(await toWav(new Blob(chunks, { type: chunks[0].type })));
            } catch (err) {
              reject(err);
            } finally {
              chunks = [];
              recorder = null;
            }
          };
          recorder.stop();
        });
      },

      /** Release the microphone entirely — the OS indicator goes out. */
      release() {
        if (recorder && recorder.state === 'recording') recorder.stop();
        recorder = null;
        if (stream) stream.getTracks().forEach((t) => t.stop());
        stream = null;
      },
    };
  }

  return { createMic, encodeWav };
});
