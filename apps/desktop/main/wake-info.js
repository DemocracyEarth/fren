'use strict';
/**
 * What fren may truthfully SAY about its wake word.
 *
 * The listener (wake-word.js) knows whether it is hearing; main knows whether
 * the light is on, whether a conversation could open, and which key it
 * registered. This file turns those facts into the few things the interface
 * is allowed to claim — and every function here errs toward saying nothing:
 * a tooltip that promises "say hey fren" to a blocked microphone, or to a
 * custom model whose phrase nobody wrote down, is worse than a quiet one.
 *
 * All pure, so the claims are tested rather than eyeballed.
 */
const path = require('node:path');
const fs = require('node:fs');
const { chooseEngine, DEFAULT_PHRASE } = require('./wake-engines');

/** Past this a quoted phrase no longer fits the hover card or the input; say "my wake word". */
const PHRASE_FITS = 18;

/**
 * The keyword the listener is given, and the phrase a person can be told to
 * SAY. They differ: a trained model is a file, and only the one fren's own
 * docs have you make (hey-fren.onnx) is known to mean "hey fren". Any other
 * file gets no phrase at all rather than a guess. `alias` is the honest aside
 * that "hey friend" wakes it too — true of keyword spotting on the default
 * phrase, and never claimed for a trained model.
 */
function wakePhrase(envKeyword, ownModel, { exists = fs.existsSync } = {}) {
  const keyword = String(envKeyword || '').trim() || (ownModel && exists(ownModel) ? ownModel : DEFAULT_PHRASE);
  const choice = chooseEngine(keyword, { exists });
  let phrase;
  if (/\.onnx$/i.test(choice.keyword)) {
    phrase = path.basename(choice.keyword).toLowerCase() === 'hey-fren.onnx' ? DEFAULT_PHRASE : null;
  } else {
    phrase = choice.keyword.toLowerCase().replace(/\s+/g, ' ').trim();
  }
  return { keyword, phrase, alias: choice.kind === 'kws' && phrase === DEFAULT_PHRASE };
}

/**
 * The hotkey as a person reads it — only the default, and only if macOS let
 * fren have it. A custom FREN_TALK_KEY is an Electron accelerator string, and
 * guessing its glyphs would print the wrong keys.
 */
function hotkeyLabel({ custom, registered, platform = process.platform } = {}) {
  if (custom || !registered) return null;
  return platform === 'darwin' ? '⌘⇧Space' : 'Ctrl+Shift+Space';
}

/**
 * Should the wake word be listening right now? One story: the light is on, no
 * conversation has the microphone, and somebody is there. A Mac that sleeps or
 * is locked has nobody in front of it — and a wake word that could open a cloud
 * conversation from the lock screen is exactly what fren's privacy story rules
 * out. Asleep and locked are separate facts: a Mac that wakes is usually still
 * locked, and stays unheard until it is unlocked. `settling` is the short pause
 * after waking or unlocking, while the audio devices come back.
 */
function wantWake({ observing = false, lineOpen = false, asleep = false, locked = false, settling = false } = {}) {
  return !!observing && !lineOpen && !asleep && !locked && !settling;
}

/**
 * Is the screen locked? The lock and unlock events are only what fren happened
 * to witness: it may have been started behind a lock screen, and an event
 * posted around sleep can arrive late or never. So macOS is asked as well
 * (powerMonitor.getSystemIdleState) and its answer wins; where it cannot say —
 * 'unknown', or no answer at all — what the events said stands.
 */
function screenLocked(idleState, was = false) {
  if (idleState === 'locked') return true;
  if (idleState === 'active' || idleState === 'idle') return false;
  return !!was;
}

/**
 * The whole status, as the renderer and the hover card get it.
 *   armed       really listening right now: not loading, not hearing zeros
 *   paused      the light is off, which is the only reason it is not listening
 *   micBlocked  macOS refused the microphone, or it yields digital silence
 *   canConverse a line would actually open: the gateway is up and has an agent
 */
function wakeInfo({ status = null, observing = false, gatewayOk = false, voiceAgent = false, phrase = null, alias = false, hotkey = null } = {}) {
  const s = status || {};
  const refused = !!s.access && s.access !== 'granted' && s.access !== 'unknown';
  return {
    armed: !!(s.listening && !s.deaf),
    phrase,
    quoted: quotable(phrase),   // what a small space may print; null reads "my wake word"
    alias: !!alias,
    paused: !!status && !observing,
    micBlocked: refused || !!s.deaf,
    canConverse: !!(gatewayOk && voiceAgent),
    hotkey,
  };
}

/** The phrase if it can be quoted in a small space, else null ("my wake word"). */
function quotable(phrase) {
  return phrase && phrase.length <= PHRASE_FITS ? phrase : null;
}

/**
 * The hover card's voice row: { kind: 'say', phrase|null } | { kind: 'hold' } | null.
 *
 * A blocked microphone gets NO row — holding the orb and the hotkey need the
 * same microphone, so promising them there would be a second lie.
 */
function hintVoiceRow(info) {
  if (!info || !info.canConverse || info.micBlocked) return null;
  if (info.armed) return { kind: 'say', phrase: quotable(info.phrase) };
  if (info.paused) return { kind: 'hold' };
  return null;
}

/**
 * The one explanation, in fren's voice. Every privacy sentence is about SOUND:
 * while the light is on fren's screen notes do reach a cloud model, so "nothing
 * leaves your Mac" would be untrue. The microphone indicator is named because
 * it stays lit the whole time the wake word listens, and unexplained it reads
 * as being recorded.
 */
function voiceIntroCopy(info = {}) {
  const say = info.phrase ? `“${info.phrase}”` : 'my wake word';
  const other = info.hotkey ? `Holding me down, or ${info.hotkey}, opens the same line.` : 'Holding me down opens the same line.';
  const aside = info.alias ? ' And “hey friend” works too — I can’t tell them apart.' : '';
  return `One thing worth knowing: you can just say ${say} and I’ll start listening. No clicking.\n\n` +
    'I listen for that on your Mac only, and only while my light is on. No sound leaves your Mac ' +
    'until I hear it, and the mic dot in your menu bar stays lit while I listen.\n\n' +
    other + aside;
}

module.exports = { wakePhrase, hotkeyLabel, wantWake, screenLocked, wakeInfo, hintVoiceRow, voiceIntroCopy, quotable, PHRASE_FITS };
