'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Where fren keeps its files: the desktop's app data folder (productName
 * "fren"), which the gateway process cannot ask Electron for — so every
 * process derives it the same way, and FREN_DATA_DIR overrides all of them.
 */
function defaultDataDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'fren');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'fren');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fren');
}
function dataDir(env = process.env) {
  return env.FREN_DATA_DIR || defaultDataDir();
}

const REPO_ENV = path.resolve(__dirname, '..', '..', '.env');

/** One file's KEY=VALUE lines (# comments, optional quotes) into `env`, never overriding a set value. Returns whether it was read. */
function readInto(file, env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (env[key] === undefined || env[key] === '') env[key] = raw.replace(/^["']|["']$/g, '');
  }
  return true;
}

let loaded = false;

/**
 * Minimal .env loading, from two places in order: this checkout's .env
 * (development), then the data folder's .env — the one a packaged app reads,
 * since the bundle carries none. A real environment variable always wins over
 * both, and a key set by the first file is not overridden by the second. The
 * data folder is resolved after the first file, so a checkout .env may point
 * FREN_DATA_DIR elsewhere and the second file follows it.
 *
 * Called with no arguments it runs once per process; with explicit `files`
 * (and optionally a target `env`) it always runs — for tests. Returns the
 * files it actually read.
 */
function loadEnv(files = null, env = process.env) {
  if (files === null) {
    if (loaded) return [];
    loaded = true;
    const read = [];
    if (readInto(REPO_ENV, env)) read.push(REPO_ENV);
    const dataEnv = path.join(dataDir(env), '.env');
    if (readInto(dataEnv, env)) read.push(dataEnv);
    return read;
  }
  const read = [];
  for (const f of files) if (readInto(f, env)) read.push(f);
  return read;
}

module.exports = { loadEnv, dataDir, defaultDataDir, REPO_ENV };
