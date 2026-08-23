'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isSilenced, outputState, readers } = require('../main/audio-output.js');

test('every desktop platform can be asked', () => {
  for (const p of ['darwin', 'win32', 'linux']) {
    assert.equal(typeof readers[p], 'function', `${p} needs a reader`);
  }
});

test('an unaskable platform is treated as audible, not as muted', async () => {
  // The asymmetry is deliberate. Guessing "muted" would pop the chat panel
  // over someone's work every single time fren spoke, which is far worse than
  // the problem it is trying to solve.
  assert.equal(await outputState('sunos'), null);
  assert.equal(await isSilenced('sunos'), false);
});

test('a reader that throws is treated as audible', async () => {
  const saved = readers.darwin;
  readers.darwin = async () => { throw new Error('osascript is missing'); };
  try {
    assert.equal(await isSilenced('darwin'), false);
  } finally {
    readers.darwin = saved;
  }
});

test('muted, or zero volume, both count as silenced', async () => {
  const saved = readers.linux;
  try {
    readers.linux = async () => ({ muted: true, volume: 80 });
    assert.equal(await isSilenced('linux'), true, 'muted at any volume');
    readers.linux = async () => ({ muted: false, volume: 0 });
    assert.equal(await isSilenced('linux'), true, 'volume zero is silence too');
    readers.linux = async () => ({ muted: false, volume: 35 });
    assert.equal(await isSilenced('linux'), false);
  } finally {
    readers.linux = saved;
  }
});

test('a reader returning nonsense is treated as unknown', async () => {
  const saved = readers.linux;
  readers.linux = async () => ({ muted: 'maybe', volume: NaN });
  try {
    assert.equal(await outputState('linux'), null);
    assert.equal(await isSilenced('linux'), false);
  } finally {
    readers.linux = saved;
  }
});
