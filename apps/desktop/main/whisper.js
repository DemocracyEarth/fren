'use strict';
/**
 * Speech-to-text, entirely on this machine.
 *
 * fren shells out to whisper.cpp rather than a cloud API on purpose: the
 * microphone audio never leaves the laptop. Only the resulting text is ever
 * sent anywhere, and only when you actually addressed fren.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Homebrew installs `whisper-cli`; older builds call it `main`. Windows adds
// the .exe forms, since PATH lookup there is extension-driven.
const BASE_BINS = ['whisper-cli', 'whisper-cpp', 'whisper', 'main'];
const BIN_CANDIDATES = process.platform === 'win32'
  ? BASE_BINS.flatMap((b) => [`${b}.exe`, b])
  : BASE_BINS;

const MODEL_CANDIDATES = [
  '~/.cache/whisper.cpp/ggml-base.en.bin',
  '~/.cache/whisper/ggml-base.en.bin',
  '~/whisper.cpp/models/ggml-base.en.bin',
  // macOS / Linux package layouts
  '/opt/homebrew/share/whisper-cpp/ggml-base.en.bin',
  '/usr/local/share/whisper-cpp/ggml-base.en.bin',
  '/usr/share/whisper.cpp/ggml-base.en.bin',
  // Windows
  '~/AppData/Local/whisper.cpp/ggml-base.en.bin',
  '~/scoop/apps/whisper-cpp/current/models/ggml-base.en.bin',
];

/** How to get whisper, in the words of whoever is actually reading this. */
const INSTALL_HINT = {
  darwin: 'brew install whisper-cpp',
  win32: 'install whisper.cpp and put it on PATH, or set FREN_WHISPER_BIN',
  linux: 'build whisper.cpp, or install it from your package manager, then set FREN_WHISPER_BIN if needed',
}[process.platform] || 'set FREN_WHISPER_BIN to a whisper.cpp binary';

const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

function which(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * What the user chose, if anything. Set from the settings pane.
 *
 * The MODEL is settable: it is a data file whisper.cpp loads, passed to
 * execFile as an argument and never through a shell. The BINARY is not, and
 * stays an environment variable — choosing which executable gets launched is
 * not a checkbox, and it is the field a compromised renderer would want most.
 */
let chosen = { model: '', lang: '' };
function setPreferences(next) {
  chosen = {
    model: (next && next.whisperModel) || '',
    lang: (next && next.whisperLang) || '',
  };
}

/** Locate the binary and a model, or explain what is missing. */
function detect() {
  const bin = process.env.FREN_WHISPER_BIN
    ? expand(process.env.FREN_WHISPER_BIN)
    : BIN_CANDIDATES.map(which).find(Boolean);

  let model = chosen.model
    || (process.env.FREN_WHISPER_MODEL ? expand(process.env.FREN_WHISPER_MODEL) : null);
  if (!model) {
    model = MODEL_CANDIDATES.map(expand).find((p) => {
      try { return fs.statSync(p).isFile(); } catch { return false; }
    });
  }

  if (!bin) return { ready: false, reason: `whisper.cpp is not installed (${INSTALL_HINT})` };
  if (!model || !fs.existsSync(model)) {
    return { ready: false, bin, reason: 'no whisper model found — set FREN_WHISPER_MODEL to a ggml-*.bin file' };
  }
  return { ready: true, bin, model };
}

/**
 * Transcribe 16kHz mono WAV bytes. Resolves to trimmed text ('' if silence).
 */
function transcribe(wavBytes, { timeoutMs = 30_000 } = {}) {
  const found = detect();
  if (!found.ready) return Promise.reject(new Error(found.reason));

  const file = path.join(os.tmpdir(), `fren-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(file, wavBytes);

  return new Promise((resolve, reject) => {
    execFile(
      found.bin,
      [
        '-m', found.model,
        '-f', file,
        '--no-timestamps',
        '--no-prints',
        // Naming the language beats 'auto' when you know it: auto-detect on a
        // short clip is where names come back wrong.
        '--language', chosen.lang || process.env.FREN_WHISPER_LANG || 'auto',
        '--threads', String(Math.max(2, Math.min(8, os.cpus().length - 2))),
      ],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        fs.rm(file, { force: true }, () => {});
        if (err) {
          // Message only — never the audio, never the transcript.
          return reject(new Error(`whisper failed: ${(stderr || err.message).slice(0, 200)}`));
        }
        // whisper.cpp brackets non-speech as [BLANK_AUDIO], [MUSIC] etc.
        const text = String(stdout)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !/^\[[A-Z_ ]+\]$/.test(l))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        resolve(text);
      }
    );
  });
}

module.exports = { detect, transcribe, setPreferences };
