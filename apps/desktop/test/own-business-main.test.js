'use strict';
/**
 * fren doing what it was told about itself.
 *
 * Every reply here is a promise about a setting, so each test checks both: the
 * deed reached the function main handed in, and the sentence says what
 * happened. The second half of the file is the management card — the only
 * place a routine or an automation can be paused, run or deleted once the
 * dashboard is gone, so its chips are pinned to the exact entries they call.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createOwnBusiness, whenText, automationRow } = require('../main/own-business.js');

function harness(over = {}) {
  const calls = [];
  const world = {
    watching: true, exclusions: [], domain: '', volunteer: true, awareness: true, readPage: true, readSelection: true,
    routines: [], automations: [], facts: [], patterns: [],
    ...over,
  };
  const ob = createOwnBusiness({
    now: () => new Date(2026, 8, 20, 10, 0).getTime(),
    watching: () => world.watching,
    setWatching: (on) => { world.watching = on; calls.push(['setWatching', on]); },
    routines: () => world.routines,
    automations: async () => { if (world.automations === 'down') throw new Error('gateway down'); return world.automations; },
    browser: () => ({ exclusions: world.exclusions, awareness: world.awareness, readPage: world.readPage, readSelection: world.readSelection }),
    // The real one sanitises: junk never reaches the list.
    setBrowser: (patch) => {
      calls.push(['setBrowser', patch]);
      if (patch.exclusions) world.exclusions = patch.exclusions.filter((x) => /^[a-z0-9.-]+$/.test(x) && x.includes('.'));
      return world.exclusions;
    },
    currentDomain: () => world.domain,
    setColour: (hex) => calls.push(['setColour', hex]),
    setWakeOnLaunch: (on) => calls.push(['setWakeOnLaunch', on]),
    setVolunteer: (on) => { calls.push(['setVolunteer', on]); return world.noProfile ? { volunteer: false } : { volunteer: on }; },
    remember: async (note) => { calls.push(['remember', note]); return { kept: !!world.keeps }; },
    facts: () => world.facts,
    forgetFact: (fact) => { calls.push(['forgetFact', fact]); return { removed: world.facts.includes(fact) }; },
    patterns: () => world.patterns,
  });
  return { ob, calls, world };
}

test('watch: does it, and says nothing happened when nothing did', async () => {
  const { ob, calls } = harness({ watching: true });
  assert.equal((await ob.apply('watch', { on: false })).say, 'Okay — not watching.');
  assert.deepEqual(calls, [['setWatching', false]]);
  assert.match((await ob.apply('watch', { on: false })).say, /not watching/);
  assert.equal(calls.length, 1, 'already off: no second deed');
  assert.equal((await ob.apply('watch', { on: true })).say, 'Okay — watching again.');
});

test('watch: a length of time is not promised, because there is no timer', async () => {
  const { ob } = harness({ watching: true });
  assert.equal((await ob.apply('watch', { on: false, timed: true })).say, 'Okay — not watching. I won\'t start again on my own — say "start watching".');
  assert.match((await ob.apply('watch', { on: false, timed: true })).say, /light is off\. I won't start again/);
});

test('"this site" is the page in front of them, and with no page fren says so', async () => {
  const { ob, calls, world } = harness({ domain: '' });
  const blind = await ob.apply('exclude', { domain: null });
  assert.match(blind.say, /can't see a page/);
  assert.equal(calls.length, 0);

  world.domain = 'github.com';
  const res = await ob.apply('exclude', { domain: null });
  assert.equal(res.say, "I won't read github.com from now on.");
  assert.deepEqual(world.exclusions, ['github.com']);
  // Undo is a chip, and it is the same door the sentence would use.
  assert.deepEqual(res.chips, [{ label: 'Undo', call: 'ownBusiness', args: ['include', { domain: 'github.com' }, ''] }]);
});

test('exclude: already excluded, built in, and not a site at all', async () => {
  const { ob, calls } = harness({ exclusions: ['github.com'] });
  assert.match((await ob.apply('exclude', { domain: 'gist.github.com' })).say, /already don't read gist\.github\.com/);
  assert.match((await ob.apply('exclude', { domain: 'chase.com' })).say, /already/);
  assert.equal(calls.length, 0);
  assert.match((await ob.apply('exclude', { domain: 'not a site' })).say, /doesn't look like a site/);
});

test('include: removes what covered the site, refuses the built-in list, and knows when there was nothing', async () => {
  const { ob, world } = harness({ exclusions: ['google.com', 'github.com'] });
  assert.equal((await ob.apply('include', { domain: 'mail.google.com' })).say, 'Okay — I can read google.com again.');
  assert.deepEqual(world.exclusions, ['github.com']);
  assert.match((await ob.apply('include', { domain: 'chase.com' })).say, /never read/);
  assert.equal((await ob.apply('include', { domain: 'example.com' })).say, "I wasn't skipping example.com.");
  assert.deepEqual(world.exclusions, ['github.com']);
});

test('the three browser switches go through the one settings function', async () => {
  const { ob, calls } = harness();
  await ob.apply('readPages', { on: false });
  await ob.apply('readSelections', { on: false });
  await ob.apply('awareness', { on: true });
  assert.deepEqual(calls, [
    ['setBrowser', { readPage: false }],
    ['setBrowser', { readSelection: false }],
    ['setBrowser', { awareness: true }],
  ]);
});

test('reading again is not claimed while fren is out of the browser', async () => {
  const out = harness({ awareness: false });
  assert.match((await out.ob.apply('readPages', { on: true })).say, /once I'm back in your browser.*start watching my browser/);
  assert.match((await out.ob.apply('readSelections', { on: true })).say, /once I'm back in your browser/);
  assert.deepEqual(out.calls, [['setBrowser', { readPage: true }], ['setBrowser', { readSelection: true }]], 'the wish is still stored');
  assert.equal((await harness().ob.apply('readPages', { on: true })).say, 'Okay — reading pages again.');
});

test('what are you reading: the switches in words, each exclusion with its way back, nothing changed', async () => {
  const { ob, calls } = harness({ readSelection: false, exclusions: ['github.com', 'example.org'] });
  const res = await ob.apply('reading', {});
  assert.match(res.say, /^I read the pages you visit, but not what you select\. You've told me to skip 2 sites\./);
  assert.deepEqual(res.rows.map((r) => r.text), ['github.com', 'example.org']);
  assert.deepEqual(res.rows[0].chips, [{ label: 'Read it again', call: 'ownBusiness', args: ['include', { domain: 'github.com' }, ''], then: 'drop' }]);
  assert.equal(calls.length, 0);
  assert.match((await harness({ awareness: false }).ob.apply('reading', {})).say, /^I'm out of your browser/);
});

test('settings: points at the one pane, with a chip that opens it', async () => {
  const res = await harness().ob.apply('settings', {});
  assert.match(res.say, /sliders button/);
  assert.deepEqual(res.chips, [{ label: 'Open it', call: 'openSettings', args: [], then: 'keep' }]);
});

test('colour: a preset by name or by what people call it; an unknown name lists the names', async () => {
  const { ob, calls } = harness();
  assert.equal((await ob.apply('colour', { name: 'blue' })).say, 'Cornflower it is.');
  assert.equal((await ob.apply('colour', { name: 'default' })).say, 'Back to ember.');
  assert.deepEqual(calls, [['setColour', 0x4a7fe0], ['setColour', 0xffa200]]);
  const unknown = await ob.apply('colour', { name: 'beige' });
  assert.match(unknown.say, /don't have "beige"/);
  for (const n of ['ember', 'rhubarb', 'mulberry', 'cornflower', 'lagoon', 'moss']) assert.match(unknown.say, new RegExp(n));
  assert.equal(calls.length, 2, 'an unknown colour changes nothing');
});

test('waking at launch', async () => {
  const { ob, calls } = harness();
  assert.match((await ob.apply('wakeOnLaunch', { on: false })).say, /start dark/);
  assert.match((await ob.apply('wakeOnLaunch', { on: true })).say, /light on/);
  assert.deepEqual(calls, [['setWakeOnLaunch', false], ['setWakeOnLaunch', true]]);
});

test('speaking up: the chat window is told to read the profile again', async () => {
  // It decides whether to speak from a copy it cached at boot. Without the
  // refresh "stop interrupting me" is a claim that comes true at next launch.
  const { ob } = harness();
  const off = await ob.apply('volunteer', { on: false });
  assert.match(off.say, /won't speak up/);
  assert.deepEqual(off.refresh, ['profile']);
  assert.deepEqual((await ob.apply('volunteer', { on: true })).refresh, ['profile']);
});

test('speaking up: when it could not be stored, fren does not claim it was', async () => {
  const { ob } = harness({ noProfile: true });
  const res = await ob.apply('volunteer', { on: true });
  assert.match(res.say, /couldn't/);
  assert.equal(res.refresh, undefined);
});

test('remember: says whether it kept it', async () => {
  const kept = harness({ keeps: true });
  assert.equal((await kept.ob.apply('remember', { note: 'I take the 8:15' })).say, "I'll remember that.");
  assert.deepEqual(kept.calls, [['remember', 'I take the 8:15']]);
  // An instruction is never refused: the only reason left is that it is there already.
  assert.equal((await harness().ob.apply('remember', { note: 'hmm' })).say, 'I already have that.');
});

const FACTS = ['- Takes the 8:15 train _(2026-03-01)_', '- Sister is called Ana _(2026-03-02)_'];

test('what do you know about me: the notes as they are, and the way to the folder', async () => {
  const { ob } = harness({ facts: FACTS });
  const res = await ob.apply('knows', {});
  assert.equal(res.say, "I've kept 2 things about you.");
  assert.deepEqual(res.rows.map((r) => r.text), ['Takes the 8:15 train', 'Sister is called Ana']);
  assert.equal(res.chips[0].call, 'openDataFolder');
  const none = await harness().ob.apply('knows', {});
  assert.match(none.say, /Nothing yet/);
  assert.equal(none.chips[0].call, 'openDataFolder');
});

test('forget that …: shows the note with a chip, and deletes nothing by itself', async () => {
  const { ob, calls } = harness({ facts: FACTS });
  const res = await ob.apply('forget', { query: 'my sister' });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].text, 'Sister is called Ana');
  assert.deepEqual(res.rows[0].chips, [{ label: 'Forget this', call: 'ownBusiness', args: ['forgetFact', { fact: FACTS[1] }, ''], then: 'drop' }]);
  assert.equal(calls.length, 0, 'the sentence removed nothing');
  assert.match((await ob.apply('forget', { query: 'my dog' })).say, /don't have a note like that/);

  assert.equal((await ob.apply('forgetFact', { fact: FACTS[1] })).say, 'Forgotten.');
  assert.match((await ob.apply('forgetFact', { fact: '- never was' })).say, /couldn't find/);
});

test('forget this conversation: a question with a chip, never a deed', async () => {
  const { ob, calls } = harness();
  const res = await ob.apply('forgetConversation', {});
  assert.equal(calls.length, 0);
  assert.deepEqual(res.chips[0], { label: 'Yes, forget it', call: 'clearMessages', args: [], then: 'wipe', done: 'Gone.' });
  assert.equal(res.chips[1].call, undefined, '"Keep it" does nothing at all');
});

test('patterns: the recent ones that were not dismissed, newest first', async () => {
  const patterns = [
    { id: 1, status: 'new', message: 'old one' },
    { id: 2, status: 'dismissed', message: 'dismissed one' },
    { id: 3, status: 'drafted', message: 'newest one' },
  ];
  const res = await harness({ patterns }).ob.apply('patterns', {});
  assert.equal(res.say, "2 things I've noticed lately.");
  assert.deepEqual(res.rows.map((r) => r.text), ['newest one', 'old one']);
  assert.deepEqual(res.rows[0].chips, [{ label: 'Not useful', call: 'dismissSuggestion', args: [3], then: 'drop' }]);
  assert.equal((await harness().ob.apply('patterns', {})).say, "Nothing I'd call a pattern yet.");
});

// ---- the management card ------------------------------------------------------

const ROUTINE = { id: 4, name: 'Morning recap', prompt: 'what did I do yesterday', hour: 9, minute: 0, days: [1, 2, 3, 4, 5], enabled: true, nextRun: new Date(2026, 8, 21, 9, 0).getTime() };
const AUTOMATION = { id: 'a1', name: 'News', describe: 'every day at 08:00', body: { kind: 'agent', instruction: 'Read the headlines and tell me three.' }, enabled: false, pausedByRuntime: 'it kept failing', nextRunAt: null };

test('nothing running', async () => {
  assert.deepEqual(await harness().ob.apply('running', {}), { say: 'Nothing running right now.' });
});

test('the card: what each thing does, when it next runs, on or paused', async () => {
  const { ob } = harness({ routines: [ROUTINE], automations: [AUTOMATION] });
  const res = await ob.apply('running', {});
  assert.equal(res.say, '2 things running.');
  assert.equal(res.rows[0].text, 'Morning recap — asks "what did I do yesterday" every weekday at 09:00. Next: tomorrow at 09:00.');
  assert.equal(res.rows[1].text, 'News — every day at 08:00: Read the headlines and tell me three. Reaches no websites. Stopped: it kept failing.');
});

test('the card: where an automation may go is said every time it is listed', () => {
  const row = automationRow({ ...AUTOMATION, network: { domains: ['example.com', 'news.example.org'] } }, Date.now());
  assert.match(row.text, /Can reach example\.com, news\.example\.org, and nothing else\./);
  const many = automationRow({ ...AUTOMATION, network: { domains: 'abcdefgh'.split('').map((c) => `${c}.com`) } }, Date.now());
  assert.match(many.text, /Can reach a\.com, b\.com, c\.com, d\.com, e\.com, f\.com and 2 more, and nothing else\./);
});

test('the card: each chip is an entry the chat window already has, with the right arguments', async () => {
  const { ob } = harness({ routines: [ROUTINE], automations: [AUTOMATION] });
  const [routine, automation] = (await ob.apply('running', {})).rows;
  assert.deepEqual(routine.chips, [
    { label: 'Pause', call: 'setRoutineEnabled', args: [4, false], then: 'redraw' },
    { label: 'Delete', confirm: 'Yes, delete it', then: 'redraw', call: 'deleteRoutine', args: [4] },
  ]);
  assert.deepEqual(automation.chips.map((c) => [c.label, c.call, c.args]), [
    ['Resume', 'patchAgentAutomation', ['a1', { enabled: true }]],
    ['Run now', 'runAgentAutomation', ['a1']],
    ['Delete', 'deleteAgentAutomation', ['a1']],
  ]);
  // Deleting always asks once more, for both kinds.
  assert.equal(automation.chips[2].confirm, 'Yes, delete it');
});

test('the card survives the gateway being away: routines still show, and fren says what is missing', async () => {
  const { ob } = harness({ routines: [ROUTINE], automations: 'down' });
  const res = await ob.apply('running', {});
  assert.equal(res.rows.length, 1);
  assert.match(res.say, /couldn't reach my automations/);
  assert.match((await harness({ automations: 'down' }).ob.apply('running', {})).say, /couldn't reach/);
});

test('names: what is running, by name, and no reply to speak', async () => {
  const { ob } = harness({ routines: [ROUTINE], automations: [AUTOMATION] });
  assert.deepEqual(await ob.apply('names', {}), { say: '', names: ['Morning recap', 'News'] });
});

test('an unknown verb, a prototype name and a throwing deed are all just something fren says', async () => {
  const { ob } = harness();
  assert.equal((await ob.apply('nope', {})).say, "I didn't follow that.");
  assert.equal((await ob.apply('constructor', {})).say, "I didn't follow that.");
  const broken = createOwnBusiness({ watching: () => true, setWatching: () => { throw new Error('observer fell over'); } });
  assert.equal((await broken.apply('watch', { on: false })).say, "I couldn't do that: observer fell over.");
});

test('whenText, in local time', () => {
  const now = new Date(2026, 8, 20, 10, 0).getTime();            // a Sunday
  assert.equal(whenText(new Date(2026, 8, 20, 14, 5).getTime(), now), 'today at 14:05');
  assert.equal(whenText(new Date(2026, 8, 21, 9, 0).getTime(), now), 'tomorrow at 09:00');
  assert.equal(whenText(new Date(2026, 8, 23, 9, 0).getTime(), now), 'Wednesday at 09:00');
  assert.equal(whenText(new Date(2026, 9, 5, 9, 0).getTime(), now), '2026-10-05 at 09:00');
});
