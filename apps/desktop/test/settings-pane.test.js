'use strict';
// The models pane is plain HTML and a script that looks elements up by id. A
// missing id there throws before the first read and the pane opens blank —
// something neither lint nor a unit test of main would ever see. So the two
// files are checked against each other.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(dir, 'settings.html'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'settings-ui.js'), 'utf8');
const hasId = (id) => html.includes(`id="${id}"`);

test('every element the settings script reaches for exists in the pane', () => {
  const fields = /const FIELDS = \[([^\]]+)\]/.exec(js)[1].match(/[A-Za-z]+/g);
  assert.deepEqual(fields, ['chatModel', 'voiceId', 'voiceModel', 'whisperModel', 'whisperLang']);
  for (const f of fields) {
    for (const id of [f, `s-${f}`, `r-${f}`]) assert.ok(hasId(id), `settings.html has no #${id}`);
  }
  const literal = [...js.matchAll(/(?:el|suggest|hint)\('([A-Za-z-]+)'[,)]/g)].map((m) => m[1]);
  assert.ok(literal.length >= 5);
  for (const id of literal) assert.ok(hasId(id), `settings.html has no #${id}`);
});

test('the pane is about models: no key field, no door to the .env file', () => {
  assert.doesNotMatch(html, /type="password"|id="reveal"/);
  assert.doesNotMatch(js, /revealEnv|reveal/);
  assert.match(html, /\.env<\/code> file, never here/);
});
