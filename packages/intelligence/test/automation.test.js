'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildAutomationRequest, AUTOMATION_SCHEMA } = require('../index.js');

const req = (o = {}) => buildAutomationRequest({
  pattern: 'export dashboard numbers into the weekly sheet',
  message: 'seven times this week',
  ...o,
});

test('the prompt states what fren actually saw, and what follows from it', () => {
  const s = req().system;
  // fren only ever had app names and window titles. A draft that invents a URL
  // or a column name looks authoritative and wastes the reader's time.
  assert.match(s, /only which application is in front and what its window/);
  assert.match(s, /never seen the contents of any window/);
  assert.match(s, /do NOT know URLs/);
  assert.match(s, /Do not invent any of them/);
  assert.match(s, /placeholder/);
});

test('the script is for the user to run, and fren does not run it', () => {
  const s = req().system;
  assert.match(s, /THE SCRIPT IS FOR THE USER TO RUN, not for you to run/);
  assert.match(s, /they will read it first/);
});

test('destructive and credential operations are ruled out explicitly', () => {
  const s = req().system;
  // A script the user is invited to run has to be safe to read and reversible
  // in effect. Naming the specific operations beats a vague "be careful".
  assert.match(s, /Never delete, overwrite or move files/);
  assert.match(s, /Never touch credentials, keychains or password stores/);
  assert.match(s, /Prefer reading, copying and opening over writing and changing/);
});

test('"this cannot be automated" is an allowed answer', () => {
  const s = req().system;
  assert.match(s, /set feasible to false/);
  assert.match(s, /that is a useful answer, not a failure/);
  assert.ok(AUTOMATION_SCHEMA.required.includes('feasible'));
  assert.ok(AUTOMATION_SCHEMA.required.includes('caveats'));
});

test('an unsafe script has an escape hatch that is not "write it anyway"', () => {
  assert.match(req().system, /If a safe script is not possible, return an empty script/);
});

test('the target platform is stated, since the script is platform-specific', () => {
  assert.match(req({ platform: 'Windows' }).system, /Target platform: Windows/);
  assert.match(req({ platform: 'Linux' }).system, /Target platform: Linux/);
});

test('the pattern and its evidence both reach the model', () => {
  const r = req();
  assert.match(r.messages[0].content, /export dashboard numbers into the weekly sheet/);
  assert.match(r.messages[0].content, /seven times this week/);
});
