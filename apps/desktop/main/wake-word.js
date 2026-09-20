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
 * A microphone that keeps failing is not hammered. Every arm loads the engine
 * (three ONNX sessions, on Electron's main thread) and opens the device, so
 * after a failed arm, a lost microphone or an engine error the next arm() is
 * refused — quietly: no line, no engine, no recorder — until a backoff has
 * passed: 5 s, doubling to 5 min. Thirty seconds of healthy listening resets
 * it. disarm() does not (a flapping device cannot be hammered through
 * arm/disarm); arm({ fresh: true }) does — for the one caller that knows the
 * world changed: the Mac just woke or was unlocked. A microphone macOS REFUSED
 * is not a failure to back off from; that path already says it once.
 *
 * And an arm in flight can be cancelled: disarm() while the microphone is still
 * being asked for, or the engine is still loading, means that arm lets go of
 * whatever it made and ends disarmed — it never completes after the light went
 * off or the Mac locked.
 *
 * Everything is injected — the engine factory, the recorder, the clock — so
 * the clockwork tests without a microphone, models or a network.
 */
const DEFAULTS = {
  debounceMs: 2000,          // one detection is one wake, not three
  deafAfterMs: 10000,        // this long of exact zeros from the microphone is worth a line
  backoffMs: 5000,           // after a failure, the first wait before arming is tried again
  backoffMaxMs: 300000,      // …doubling up to this
  healthyAfterMs: 30000,     // a run that listens this long was not a flapping device: start over
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
  onChange = () => {},       // whether it is really listening just changed; ask status()
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
  let generation = 0;           // disarm() moves it; an arm() that sees it moved was cancelled
  let failures = 0;             // in a row, without a healthy run between them
  let retryAt = null;           // until then arm() is refused, quietly
  let armedAt = null;

  // What the interface says about the wake word follows from this, so every
  // path that starts or stops the hearing ends here. Never allowed to throw
  // into the listening loop.
  function changed() { try { onChange(); } catch { /* the listener's problem */ } }

  function letGo(r, e) {
    try { if (r) { if (r.isRecording) r.stop(); r.release(); } } catch { /* already gone */ }
    try { if (e) e.release(); } catch { /* already gone */ }
  }

  function release() {
    const was = running;
    running = false;
    armedAt = null;
    const r = recorder; recorder = null;
    const e = engine; engine = null;
    letGo(r, e);
    if (was) changed();        // disarmed, microphone lost, engine error: all come through here
  }

  // It failed: the next arm waits — 5 s, then 10, 20 … 5 min. Says nothing; the
  // failure itself was already one line.
  function failed() {
    failures += 1;
    retryAt = now() + Math.min(opts.backoffMs * 2 ** (failures - 1), opts.backoffMaxMs);
  }

  async function loop() {
    const r = recorder;
    const e = engine;
    while (running && recorder === r) {
      let frame;
      try { frame = await r.read(); }
      catch (err) {
        if (running && recorder === r) { log(`[wake] microphone lost: ${err.message}`); failed(); release(); }
        return;
      }
      if (!running || recorder !== r) return;
      if (failures && now() - armedAt >= opts.healthyAfterMs) failures = 0;   // listening fine: not a flapping device
      if (isSilent(frame)) {
        if (silentSince === null) silentSince = now();
        else if (!deaf && now() - silentSince >= opts.deafAfterMs) {
          deaf = true;
          log('[wake] hearing nothing from the microphone — check the input device, or System Settings › Privacy & Security › Microphone');
          changed();
        }
      } else {
        silentSince = null;
        if (deaf) { deaf = false; log('[wake] hearing the microphone again'); changed(); }
      }
      let idx = -1;
      try { idx = await e.process(frame); }
      catch (err) {
        if (running && recorder === r) { log(`[wake] engine error: ${err.message}`); failed(); release(); }
        return;
      }
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
    /**
     * Start listening: load the engine (fetching models once), open the mic.
     * Idempotent. Refused quietly while backing off from a failure, unless
     * `fresh` — the Mac just woke or was unlocked — says to start over.
     */
    async arm({ fresh = false } = {}) {
      if (fresh) { failures = 0; retryAt = null; }
      if (running || arming) return true;
      if (retryAt !== null) {
        if (now() < retryAt) return false;   // no line, no engine, no recorder
        retryAt = null;
      }
      arming = true;
      const mine = generation;
      const cancelled = () => mine !== generation;   // disarm() already cleared `arming` and said so
      let access = 'granted';
      try { access = await micAccess(); } catch (err) { access = `unavailable (${err.message})`; }
      if (cancelled()) return false;
      if (access !== 'granted' && access !== 'unknown') {
        if (access !== lastAccess) log(`[wake] microphone ${access} — wake word off until it is allowed (System Settings › Privacy & Security › Microphone)`);
        lastAccess = access;
        arming = false;
        changed();
        return false;
      }
      lastAccess = access;
      let d = deps;
      try { d = d || loadDeps(); } catch (err) { log(`[wake] unavailable: ${err.message}`); failed(); arming = false; changed(); return false; }
      let e = null;
      let r = null;
      try {
        e = await d.createEngine({ modelsDir, keyword, sensitivity, log, ...engineOptions });
        if (cancelled()) { letGo(null, e); return false; }
        r = new d.PvRecorder(e.frameLength);
        r.start();
      } catch (err) {
        letGo(r, e);
        if (cancelled()) return false;
        log(`[wake] could not arm: ${err.message}`);
        failed();
        arming = false;
        changed();
        return false;
      }
      engine = e;
      recorder = r;
      running = true;
      arming = false;
      armedAt = now();
      retryAt = null;
      label = engine.label;
      log(`[wake] armed — ${label}`);
      changed();
      loop().catch((err) => { log(`[wake] stopped: ${err.message}`); if (recorder === r) { failed(); release(); } });
      return true;
    },
    /**
     * Stop listening and let the microphone go. Idempotent. An arm() still in
     * flight is cancelled: it releases what it made and resolves false. The
     * backoff is NOT reset here.
     */
    disarm() {
      generation += 1;
      if (arming) { arming = false; log('[wake] disarmed (before it had armed)'); changed(); return; }
      if (!running && !recorder && !engine) return;
      release();
      log('[wake] disarmed');
    },
    // True while still loading, on purpose: it is what stops a second arm().
    // "Is it hearing me?" is status().listening — never this.
    armed: () => running || arming,
    label: () => label,
    /** The truth for the interface: hearing or not, and why not. `label` is a log string, not a phrase. */
    /** `retryAt`: when a failing microphone will next be tried (ms), or null. */
    status: () => ({ listening: running, arming, access: lastAccess, deaf, label, retryAt }),
  };
}

module.exports = { createWakeListener, isSilent, DEFAULTS };
