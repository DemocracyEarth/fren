'use strict';
/**
 * The .env loader: two files in order, real environment always winning, the
 * first file never overridden by the second, missing files a non-event — and
 * the data folder every process agrees on.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEnv, dataDir, defaultDataDir, REPO_ENV } = require('../env.js');

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-env-'));
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, content);
  return f;
}

test('KEY=VALUE lines, comments, quotes; a real environment variable wins', () => {
  const f = tmpFile('# a comment\nA_KEY=one\nB_KEY="two"\nC_KEY=\'three\'\nnot a line\nD_KEY=\n');
  const env = { A_KEY: 'already-set' };
  const read = loadEnv([f], env);
  assert.deepEqual(read, [f]);
  assert.equal(env.A_KEY, 'already-set');
  assert.equal(env.B_KEY, 'two');
  assert.equal(env.C_KEY, 'three');
  assert.equal(env.D_KEY, '');
});

test('the second file fills what the first lacks and never overrides it', () => {
  const checkout = tmpFile('DEEPSEEK_API_KEY=from-checkout\nFREN_GATEWAY_TOKEN=t1\n');
  const data = tmpFile('DEEPSEEK_API_KEY=from-data-folder\nELEVENLABS_API_KEY=from-data-folder\n');
  const env = {};
  assert.deepEqual(loadEnv([checkout, data], env), [checkout, data]);
  assert.equal(env.DEEPSEEK_API_KEY, 'from-checkout');
  assert.equal(env.FREN_GATEWAY_TOKEN, 't1');
  assert.equal(env.ELEVENLABS_API_KEY, 'from-data-folder', 'a packaged app with only the data folder file gets its keys from there');
});

test('an empty value in the first file is filled by the second (empty counts as unset)', () => {
  const first = tmpFile('DEEPSEEK_API_KEY=\n');
  const second = tmpFile('DEEPSEEK_API_KEY=real\n');
  const env = {};
  loadEnv([first, second], env);
  assert.equal(env.DEEPSEEK_API_KEY, 'real');
});

test('missing files are a non-event', () => {
  const env = { KEEP: 'x' };
  assert.deepEqual(loadEnv(['/nonexistent/.env', '/also/nonexistent/.env'], env), []);
  assert.deepEqual(env, { KEEP: 'x' });
});

test('the data folder: the app data folder for this platform, FREN_DATA_DIR overriding', () => {
  assert.equal(dataDir({ FREN_DATA_DIR: '/elsewhere/fren' }), '/elsewhere/fren');
  assert.equal(dataDir({}), defaultDataDir());
  if (process.platform === 'darwin') assert.equal(defaultDataDir(), path.join(os.homedir(), 'Library', 'Application Support', 'fren'));
  assert.equal(path.basename(REPO_ENV), '.env');
});
