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
    let meterCtx = null;
    let meterRaf = 0;

    function stopMeter() {
      if (meterRaf) cancelAnimationFrame(meterRaf);
      meterRaf = 0;
      if (meterCtx) { try { meterCtx.close(); } catch { /* already gone */ } }
      meterCtx = null;
    }

    /**
     * Give the microphone back to the OS. Called after EVERY recording, not
     * just on teardown.
     *
     * This matters more than the small cost of re-acquiring: an open track
     * keeps the macOS recording indicator lit, and docs/privacy.md offers that
     * indicator as the second source of truth for "fren is only listening
     * while you hold it". Holding the stream open between recordings would
     * leave the indicator on all day and make that promise false.
     */
    function releaseStream() {
      stopMeter();
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }

    return {
      /** Acquire the microphone. Held only for the duration of a recording. */
      async warmUp() {
        // A track can end underneath us — device change, sleep/wake — and a
        // dead track records silence forever without erroring.
        if (stream && stream.getTracks().some((t) => t.readyState === 'live')) return true;
        releaseStream();
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        return true;
      },

      isRecording() {
        return !!recorder && recorder.state === 'recording';
      },

      async start(onLevel = null) {
        await this.warmUp();
        if (this.isRecording()) return;
        chunks = [];
        startedAt = Date.now();
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.start();

        // Meter the live input, so the orb can show that it is hearing YOU
        // rather than merely that it entered a state. A signal that responds to
        // your own voice cannot be mistaken for a decoration.
        if (onLevel && typeof AudioContext !== 'undefined') {
          try {
            meterCtx = new AudioContext();
            const src = meterCtx.createMediaStreamSource(stream);
            const analyser = meterCtx.createAnalyser();
            analyser.fftSize = 512;
            src.connect(analyser);            // to the analyser only: never to
                                              // the speakers, or you would hear
                                              // yourself echoed back
            const buf = new Uint8Array(analyser.frequencyBinCount);
            const pump = () => {
              if (!meterCtx) return;
              analyser.getByteTimeDomainData(buf);
              let sum = 0;
              for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
              onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3.4));
              meterRaf = requestAnimationFrame(pump);
            };
            pump();
          } catch { stopMeter(); }
        }
      },

      /**
       * Stop and return WAV bytes, or null if it was too short to be speech.
       * @returns {Promise<Uint8Array|null>}
       */
      stop() {
        return new Promise((resolve, reject) => {
          if (!this.isRecording()) return resolve(null);
          // 350ms was set when a tap on the mic BUTTON started recording
          // instantly, and it existed to throw away accidental clicks. Holding
          // the orb already requires 320ms before recording begins, so the two
          // thresholds stacked: you had to hold for two thirds of a second
          // before a single word was kept. The gesture is the accident filter
          // now; this only has to reject a genuine slip.
          // The 320ms hold used to be the accident filter: a recording could
          // not begin until you had held the orb that long. Click-to-record
          // starts instantly, so this threshold is now the ONLY thing between a
          // double click and a transcription request for a quarter second of
          // room noise.
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
              releaseStream();      // indicator goes out the moment you let go
            }
          };
          recorder.stop();
        });
      },

      /**
       * Throw away a recording in progress without transcribing it. Used when
       * the button is released before the microphone finished opening: the
       * recorder would otherwise start with nobody holding it and keep
       * listening until the next press.
       */
      cancel() {
        if (recorder && recorder.state === 'recording') {
          recorder.onstop = null;
          recorder.stop();
        }
        recorder = null;
        chunks = [];
        releaseStream();
      },

      /** Release the microphone entirely — the OS indicator goes out. */
      release() {
        this.cancel();
      },
    };
  }

  return { createMic, encodeWav };
});
