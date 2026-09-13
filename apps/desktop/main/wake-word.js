'use strict';
/**
 * The wake word — "hey fren", spoken, opens the line.
 *
 * On-device, and nothing else: Porcupine (Picovoice) listens to the microphone
 * in this process and answers one question per frame, "was that the word?".
 * No audio leaves the machine, nothing is transcribed, nothing is kept. When
 * the word is heard, `onWake` fires and the renderer opens conversation mode —
 * and THAT is when audio starts to travel, deliberately, with the orb aglow.
 *
 * It is armed only while fren's light is on (one story: light off, senses off,
 * including this one), it is disarmed for the length of a conversation (the
 * agent has the microphone then), and it needs a Picovoice access key, so it
 * exists at all only for someone who set one up on purpose.
 *
 * Everything is injected — the engine, the recorder, the clock — so the
 * clockwork tests without a microphone or a key.
 */
const fs = require('node:fs');

const DEFAULTS = {
  keyword: 'porcupine',      // Porcupine's own built-in word: the stand-in until a "hey fren" model exists
  sensitivity: 0.55,         // 0..1; higher hears more (and mishears more)
  debounceMs: 2000,          // one detection is one wake, not three
};

/** Load the native SDKs lazily, so a missing or broken binary never breaks boot. */
function loadDeps() {
  const { Porcupine, BuiltinKeyword } = require('@picovoice/porcupine-node');
  const { PvRecorder } = require('@picovoice/pvrecorder-node');
  return { Porcupine, BuiltinKeyword, PvRecorder };
}

/**
 * The keyword to arm: a `.ppn` file if the path exists, else a built-in name.
 * Returns what Porcupine wants (a path or a built-in value) and a label for
 * the log that never includes the path's contents.
 */
function resolveKeyword(keyword, BuiltinKeyword, exists = fs.existsSync) {
  const k = String(keyword || DEFAULTS.keyword).trim();
  if (/\.ppn$/i.test(k) && exists(k)) return { keyword: k, label: `custom model ${k.split('/').pop()}` };
  const name = k.toUpperCase().replace(/[\s-]+/g, '_');
  if (BuiltinKeyword && Object.prototype.hasOwnProperty.call(BuiltinKeyword, name)) {
    return { keyword: BuiltinKeyword[name], label: `built-in word "${k.toLowerCase()}"` };
  }
  return { keyword: BuiltinKeyword ? BuiltinKeyword.PORCUPINE : DEFAULTS.keyword, label: 'built-in word "porcupine"' };
}

function createWakeListener({
  accessKey,
  keyword = DEFAULTS.keyword,
  sensitivity = DEFAULTS.sensitivity,
  deps = null,               // { Porcupine, BuiltinKeyword, PvRecorder } — loaded on first arm if absent
  onWake = () => {},
  log = console.log,
  now = () => Date.now(),
  options = {},
} = {}) {
  const opts = { ...DEFAULTS, ...options };
  let porcupine = null;
  let recorder = null;
  let running = false;
  let lastWakeAt = -Infinity;   // the first hearing always counts, whatever the clock says
  let label = '';

  function release() {
    running = false;
    const r = recorder; recorder = null;
    const p = porcupine; porcupine = null;
    try { if (r) { if (r.isRecording) r.stop(); r.release(); } } catch { /* already gone */ }
    try { if (p) p.release(); } catch { /* already gone */ }
  }

  async function loop() {
    const r = recorder;
    const p = porcupine;
    while (running && recorder === r) {
      let frame;
      try { frame = await r.read(); }
      catch (err) {
        if (running && recorder === r) { log(`[wake] microphone lost: ${err.message}`); release(); }
        return;
      }
      if (!running || recorder !== r) return;
      let idx = -1;
      try { idx = p.process(frame); } catch (err) { log(`[wake] engine error: ${err.message}`); release(); return; }
      if (idx >= 0) {
        const t = now();
        if (t - lastWakeAt >= opts.debounceMs) {
          lastWakeAt = t;
          log('[wake] heard the word');   // PRIVACY: the word, never the audio
          try { onWake(); } catch { /* the renderer's problem */ }
        }
      }
    }
  }

  return {
    /** Start listening. Idempotent; false (and a log line) if it cannot. */
    arm() {
      if (running) return true;
      if (!accessKey) { log('[wake] no access key'); return false; }
      let d = deps;
      try { d = d || loadDeps(); } catch (err) { log(`[wake] unavailable: ${err.message}`); return false; }
      const resolved = resolveKeyword(keyword, d.BuiltinKeyword);
      try {
        porcupine = new d.Porcupine(accessKey, [resolved.keyword], [Math.max(0, Math.min(1, Number(sensitivity) || DEFAULTS.sensitivity))]);
        recorder = new d.PvRecorder(porcupine.frameLength);
        recorder.start();
      } catch (err) {
        log(`[wake] could not arm: ${err.message}`);
        release();
        return false;
      }
      running = true;
      label = resolved.label;
      log(`[wake] armed — ${label}`);
      loop().catch((err) => { log(`[wake] stopped: ${err.message}`); release(); });
      return true;
    },
    /** Stop listening and let the microphone go. Idempotent. */
    disarm() {
      if (!running && !recorder && !porcupine) return;
      release();
      log('[wake] disarmed');
    },
    armed: () => running,
    label: () => label,
  };
}

module.exports = { createWakeListener, resolveKeyword, DEFAULTS };
