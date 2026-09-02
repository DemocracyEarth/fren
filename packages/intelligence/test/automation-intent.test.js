'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { heuristicIntent, buildAutomationIntentRequest, AUTOMATION_INTENT_SCHEMA } = require('..');

test('the milestone sentence reads as a daily automation at nine', () => {
  const r = heuristicIntent('Every morning at 9, check Hacker News and give me the five most interesting AI stories.');
  assert.equal(r.isAutomation, true);
  assert.equal(r.cron, '0 9 * * *');
  assert.match(r.instruction, /^Check Hacker News and give me the five most interesting AI stories\.$/);
  assert.ok(r.name.length > 0);
  assert.equal(r.confident, true);
});

test('weekdays, weekends, a named day, pm, and words for hours', () => {
  assert.equal(heuristicIntent('every weekday at 8:30 summarise my calendar').cron, '30 8 * * 1-5');
  assert.equal(heuristicIntent('at weekends at 10am check the garden cam').cron, '0 10 * * 0,6');
  assert.equal(heuristicIntent('every friday at 6pm summarise the week').cron, '0 18 * * 5');
  assert.equal(heuristicIntent('each evening at six list open pull requests').cron, '0 18 * * *');
  assert.equal(heuristicIntent('every day at noon fetch the weather').cron, '0 12 * * *');
  assert.equal(heuristicIntent('every night check the backups').cron, '0 21 * * *');
});

test('questions and one-offs are refused', () => {
  assert.equal(heuristicIntent('what did I do yesterday?').isAutomation, false);
  assert.equal(heuristicIntent('check hacker news for me').isAutomation, false);
  assert.equal(heuristicIntent('every day').isAutomation, false, 'a time but nothing to do');
  assert.equal(heuristicIntent('').isAutomation, false);
});

test('the model request carries the schema and the example', () => {
  const req = buildAutomationIntentRequest({ text: 'every morning at 9 check HN', now: new Date(2026, 8, 2, 8, 0).getTime() });
  assert.equal(req.schema, AUTOMATION_INTENT_SCHEMA);
  assert.match(req.system, /0 9 \* \* \*/);
  assert.match(req.system, /isAutomation is false/);
  assert.deepEqual(req.messages, [{ role: 'user', content: 'every morning at 9 check HN' }]);
  assert.deepEqual(AUTOMATION_INTENT_SCHEMA.required, ['isAutomation', 'name', 'cron', 'instruction', 'reason']);
});
