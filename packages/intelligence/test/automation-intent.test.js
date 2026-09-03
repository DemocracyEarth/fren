'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { heuristicIntent, buildAutomationIntentRequest, AUTOMATION_INTENT_SCHEMA, fromIsoLocal } = require('..');

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
  assert.deepEqual(AUTOMATION_INTENT_SCHEMA.required, ['isAutomation', 'when', 'name', 'cron', 'at', 'app', 'site', 'instruction', 'reason']);
});

test('a single later moment is read: relative, tomorrow, tonight, a clock time', () => {
  const now = new Date(2026, 8, 3, 10, 0).getTime(); // Thu 3 Sep 2026, 10:00
  const rel = heuristicIntent('in twenty minutes tell me to stretch', now);
  assert.equal(rel.when, 'once');
  assert.equal(rel.at, now + 20 * 60000);
  assert.equal(rel.instruction, 'Remind the owner to stretch.');
  const tmr = heuristicIntent('tomorrow at 3 remind me to call Ana', now);
  assert.equal(tmr.when, 'once');
  assert.equal(new Date(tmr.at).toString().slice(0, 21), new Date(2026, 8, 4, 15, 0).toString().slice(0, 21), 'three tomorrow, in the afternoon: 3 and no am is 15');
  assert.equal(tmr.instruction, 'Remind the owner to call Ana.');
  const tonight = heuristicIntent('tonight at 8 check whether the deploy went through', now);
  assert.equal(new Date(tonight.at).getHours(), 20);
  assert.equal(tonight.instruction, 'Check whether the deploy went through.');
  const clock = heuristicIntent('at 6pm summarise what I did today', now);
  assert.equal(new Date(clock.at).getHours(), 18);
  assert.equal(new Date(clock.at).getDate(), 3);
  const past = heuristicIntent('today at 9 remind me to stretch', now);
  assert.equal(past.isAutomation, false, 'a moment already gone is not a job');
  assert.equal(heuristicIntent('what did I do at 9 this morning?', now).isAutomation, false, 'a question about the past is not a job');
});

test('a "when" is read: an app, or a site', () => {
  const fig = heuristicIntent('whenever I open Figma, remind me to check the design tokens');
  assert.equal(fig.when, 'event');
  assert.equal(fig.app, 'Figma');
  assert.equal(fig.site, '');
  assert.equal(fig.instruction, 'Remind the owner to check the design tokens.');
  const gh = heuristicIntent("when I'm on github.com list my open pull requests");
  assert.equal(gh.when, 'event');
  assert.equal(gh.site, 'github.com');
  assert.equal(gh.instruction, 'List my open pull requests.');
  const each = heuristicIntent('each time I open Slack, tell me the top three unread threads');
  assert.equal(each.when, 'event');
  assert.equal(each.app, 'Slack');
});

test('the model is asked for the three shapes and told the date', () => {
  const r = buildAutomationIntentRequest({ text: 'x', now: new Date(2026, 8, 3, 10, 0).getTime() });
  assert.match(r.system, /"once"/);
  assert.match(r.system, /"event"/);
  assert.match(r.system, /2026-09-03/);
  assert.ok(AUTOMATION_INTENT_SCHEMA.properties.when.enum.includes('event'));
  assert.equal(fromIsoLocal('2026-09-04T15:00'), new Date(2026, 8, 4, 15, 0).getTime());
  assert.ok(Number.isNaN(fromIsoLocal('tomorrow')));
});
