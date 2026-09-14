'use strict';
/**
 * The wake word — "hey fren", spoken, opens the line.
 *
 * On-device, and nothing else: an engine (wake-engines.js picks one — keyword
 * spotting for a phrase given as text, openWakeWord for a trained model)
 * listens to the microphone in this process and answers one question per
 * frame, "was that the phrase?". No audio leaves the machine, nothing is
 * transcribed, nothing is kept. When the phrase is heard, `onWake` fires and
 * the renderer opens conversation mode — and THAT is when audio starts to
 * travel, deliberately, with the orb aglow.
 *
 * It is armed only while fren's light is on (one story: light off, senses off,
 * including this one) and it is disarmed for the length of a conversation
 * (the agent has the microphone then). No account, no key: the engines' models
 * are fetched once from their projects' own releases.
 *
 * The microphone is asked for BEFORE the recorder exists. On macOS, opening
 * the microphone from native code while the permission prompt is still
 * unanswered blocks the whole main thread inside CoreAudio — the app freezes
 * behind the prompt. So arming first asks through `micAccess` (Electron's own
 * asynchronous permission API, injected), and a refusal is one line in the log
 * and no recorder. And once armed, ten seconds of digital silence is said once:
 * a denied or muted input yields zeros, not an error.
 *
 * Everything is injected — the engine factory, the recorder, the clock — so
 * the clockwork tests without a microphone, models or a network.
 */
const DEFAULTS = {
  debounceMs: 2000,          // one detection is one wake, not three
  deafAfterMs: 10000,        // this long of exact zeros from the microphone is worth a line
};

/** Exact digital silence: what a denied or muted input hands over. Never a real room. */
function isSilent(frame) {
  if (!frame || typeof frame.length !== 'number') return false;
  for (let i = 0; i < frame.length; i++) if (frame[i] !== 0) return false;
  return frame.length > 0;
}

/** Load the native pieces lazily, so a missing or broken binary never breaks boot. */
function loadDeps() {
  const { createEngine } = require('./wake-engines');
  const { PvRecorder } = require('@picovoice/pvrecorder-node');   // Apache-2.0, no key
  return { createEngine, PvRecorder };
}

function createWakeListener({
  keyword,
  sensitivity,
  modelsDir,
  engineOptions = {},        // engine settings passed through (e.g. onsetRestart)
  micAccess = async () => 'granted',   // → 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
  deps = null,               // { createEngine, PvRecorder } — loaded on first arm if absent
  onWake = () => {},
  log = console.log,
  now = () => Date.now(),
  options = {},
} = {}) {
  const opts = { ...DEFAULTS, ...options };
  let engine = null;
  let recorder = null;
  let running = false;
  let arming = false;
  let lastWakeAt = -Infinity;   // the first hearing always counts, whatever the clock says
  let lastAccess = null;        // the last microphone answer, so a refusal is said once
  let silentSince = null;
  let deaf = false;
  let label = '';

  function release() {
    running = false;
    const r = recorder; recorder = null;
    const e = engine; engine = null;
    try { if (r) { if (r.isRecording) r.stop(); r.release(); } } catch { /* already gone */ }
    try { if (e) e.release(); } catch { /* already gone */ }
  }

  async function loop() {
    const r = recorder;
    const e = engine;
    while (running && recorder === r) {
      let frame;
      try { frame = await r.read(); }
      catch (err) {
        if (running && recorder === r) { log(`[wake] microphone lost: ${err.message}`); release(); }
        return;
      }
      if (!running || recorder !== r) return;
      if (isSilent(frame)) {
        if (silentSince === null) silentSince = now();
        else if (!deaf && now() - silentSince >= opts.deafAfterMs) {
          deaf = true;
          log('[wake] hearing nothing from the microphone — check the input device, or System Settings › Privacy & Security › Microphone');
        }
      } else {
        silentSince = null;
        if (deaf) { deaf = false; log('[wake] hearing the microphone again'); }
      }
      let idx = -1;
      try { idx = await e.process(frame); }
      catch (err) { log(`[wake] engine error: ${err.message}`); release(); return; }
      if (idx >= 0) {
        const t = now();
        if (t - lastWakeAt >= opts.debounceMs) {
          lastWakeAt = t;
          log('[wake] heard the phrase');   // PRIVACY: that it was heard, never the audio
          try { onWake(); } catch { /* the renderer's problem */ }
        }
      }
    }
  }

  return {
    /** Start listening: load the engine (fetching models once), open the mic. Idempotent. */
    async arm() {
      if (running || arming) return true;
      arming = true;
      let access = 'granted';
      try { access = await micAccess(); } catch (err) { access = `unavailable (${err.message})`; }
      if (access !== 'granted' && access !== 'unknown') {
        if (access !== lastAccess) log(`[wake] microphone ${access} — wake word off until it is allowed (System Settings › Privacy & Security › Microphone)`);
        lastAccess = access;
        arming = false;
        return false;
      }
      lastAccess = access;
      let d = deps;
      try { d = d || loadDeps(); } catch (err) { log(`[wake] unavailable: ${err.message}`); arming = false; return false; }
      try {
        engine = await d.createEngine({ modelsDir, keyword, sensitivity, log, ...engineOptions });
        recorder = new d.PvRecorder(engine.frameLength);
        recorder.start();
      } catch (err) {
        log(`[wake] could not arm: ${err.message}`);
        release();
        arming = false;
        return false;
      }
      running = true;
      arming = false;
      label = engine.label;
      log(`[wake] armed — ${label}`);
      loop().catch((err) => { log(`[wake] stopped: ${err.message}`); release(); });
      return true;
    },
    /** Stop listening and let the microphone go. Idempotent. */
    disarm() {
      if (!running && !recorder && !engine) return;
      release();
      log('[wake] disarmed');
    },
    armed: () => running || arming,
    label: () => label,
  };
}

module.exports = { createWakeListener, isSilent, DEFAULTS };
