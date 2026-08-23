'use strict';
/**
 * What the user chose about models, voice and hearing.
 *
 * fren works with none of this set — every field empty means "use whatever the
 * gateway was started with", which is what the defaults in .env already give
 * you. This exists so that WANTING something different does not mean editing a
 * dotfile and restarting.
 *
 * WHAT IS NOT HERE, deliberately:
 *
 *   API keys. The desktop process deletes every provider key from its own
 *   environment at startup, because it is the process that watches your screen
 *   and it has no business holding a credential. A settings field that accepted
 *   one would put it back — in this process, and in the SQLite file next to
 *   your screenshots. Keys live in .env, which only the gateway reads.
 *
 *   Base URLs. The base URL is where the API key gets sent. Somewhere to send a
 *   credential is not a preference, it is an exfiltration primitive, and it is
 *   the one field a compromised renderer would most like to set.
 *
 *   The whisper BINARY. The model file is data that whisper.cpp loads; the
 *   binary is the program that runs. Choosing which executable to launch is not
 *   a checkbox. It stays an environment variable, where setting it is a
 *   deliberate act by someone at a shell.
 */
const fs = require('node:fs');

const KEY = 'providers';

/** Model and voice ids reach a URL path and a JSON body, so shape is checked. */
const ID = /^[A-Za-z0-9._:-]{1,64}$/;
const clean = (v) => (typeof v === 'string' && ID.test(v.trim()) ? v.trim() : '');

/**
 * A whisper model path, if it is one.
 *
 * It is passed to execFile as an argument, never through a shell, so there is
 * no injection here — but a path that does not exist turns every transcription
 * into a failure with a confusing message, so it is checked now rather than
 * discovered later. `.bin` because that is what a ggml model is.
 */
function cleanPath(v) {
  const p = typeof v === 'string' ? v.trim() : '';
  if (!p || !p.endsWith('.bin')) return '';
  try { return fs.statSync(p).isFile() ? p : ''; } catch { return ''; }
}

/** Two letters, or empty for whisper's own detection. */
const cleanLang = (v) =>
  (typeof v === 'string' && /^[a-z]{2}$/i.test(v.trim()) ? v.trim().toLowerCase() : '');

const EMPTY = {
  chatModel: '', voiceId: '', voiceModel: '', whisperModel: '', whisperLang: '',
};

function read(memory) {
  try {
    const raw = memory.getSetting(KEY);
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      chatModel: clean(s.chatModel),
      voiceId: clean(s.voiceId),
      voiceModel: clean(s.voiceModel),
      whisperModel: cleanPath(s.whisperModel),
      whisperLang: cleanLang(s.whisperLang),
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Save, after cleaning. Anything unrecognised becomes empty rather than an
 * error: the result is that fren falls back to its default, which is always a
 * working state.
 */
function write(memory, patch) {
  const next = read(memory);
  const p = patch && typeof patch === 'object' ? patch : {};
  if ('chatModel' in p) next.chatModel = clean(p.chatModel);
  if ('voiceId' in p) next.voiceId = clean(p.voiceId);
  if ('voiceModel' in p) next.voiceModel = clean(p.voiceModel);
  if ('whisperLang' in p) next.whisperLang = cleanLang(p.whisperLang);
  if ('whisperModel' in p) {
    // Report back what was actually accepted, so a bad path shows as rejected
    // in the UI instead of silently doing nothing.
    next.whisperModel = cleanPath(p.whisperModel);
  }
  memory.setSetting(KEY, next);
  return next;
}

module.exports = { read, write, KEY, EMPTY, clean, cleanPath, cleanLang };
