'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compactObservations,
  buildSummarizeRequest,
  parseSummary,
  buildChatRequest,
  buildPatternRequest,
} = require('..');

// Local-time constructor so HH:MM assertions hold in any timezone.
const at = (h, m, s = 0) => new Date(2026, 0, 15, h, m, s).getTime();

test('compactObservations: empty and non-array input', () => {
  assert.equal(compactObservations([]), '');
  assert.equal(compactObservations(undefined), '');
  assert.equal(compactObservations(null), '');
});

test('compactObservations: single row is a zero-minute range', () => {
  const out = compactObservations([
    { ts: at(14, 3), activeApp: 'Chrome', windowTitle: 'GitHub PR #42' },
  ]);
  assert.equal(out, '14:03-14:03 (0m) Chrome — GitHub PR #42');
});

test('compactObservations: consecutive same app+title merge into one range', () => {
  const rows = [
    { ts: at(14, 3), activeApp: 'Chrome', windowTitle: 'GitHub PR #42' },
    { ts: at(14, 8), activeApp: 'Chrome', windowTitle: 'GitHub PR #42' },
    { ts: at(14, 12), activeApp: 'Chrome', windowTitle: 'GitHub PR #42' },
  ];
  assert.equal(compactObservations(rows), '14:03-14:12 (9m) Chrome — GitHub PR #42');
});

test('compactObservations: app or title change starts a new range', () => {
  const rows = [
    { ts: at(9, 0), activeApp: 'Chrome', windowTitle: 'Docs' },
    { ts: at(9, 5), activeApp: 'VS Code', windowTitle: 'index.js' },
    { ts: at(9, 10), activeApp: 'VS Code', windowTitle: 'test.js' },
    { ts: at(9, 15), activeApp: 'Chrome', windowTitle: 'Docs' },
  ];
  const lines = compactObservations(rows).split('\n');
  assert.deepEqual(lines, [
    '09:00-09:00 (0m) Chrome — Docs',
    '09:05-09:05 (0m) VS Code — index.js',
    '09:10-09:10 (0m) VS Code — test.js',
    '09:15-09:15 (0m) Chrome — Docs',
  ]);
});

test('compactObservations: missing title is omitted and merges with empty title', () => {
  const rows = [
    { ts: at(10, 0), activeApp: 'Finder' },
    { ts: at(10, 2), activeApp: 'Finder', windowTitle: '' },
  ];
  assert.equal(compactObservations(rows), '10:00-10:02 (2m) Finder');
});

test('compactObservations: duration rounds to nearest minute', () => {
  const rows = [
    { ts: at(14, 3, 0), activeApp: 'Chrome', windowTitle: 'x' },
    { ts: at(14, 3, 40), activeApp: 'Chrome', windowTitle: 'x' },
  ];
  assert.match(compactObservations(rows), /\(1m\)/);
});

test('parseSummary: accepts an object', () => {
  const out = parseSummary({ activity: 'writing tests', applications: ['VS Code'], confidence: 0.9 });
  assert.deepEqual(out, { activity: 'writing tests', applications: ['VS Code'], confidence: 0.9 });
});

test('parseSummary: accepts a plain JSON string', () => {
  const out = parseSummary('{"activity":"reading docs","applications":["Chrome"],"confidence":0.7}');
  assert.deepEqual(out, { activity: 'reading docs', applications: ['Chrome'], confidence: 0.7 });
});

test('parseSummary: strips markdown code fences', () => {
  const raw = '```json\n{"activity":"reviewing a PR","applications":["Chrome"],"confidence":0.8}\n```';
  const out = parseSummary(raw);
  assert.equal(out.activity, 'reviewing a PR');
  assert.equal(out.confidence, 0.8);
});

test('parseSummary: junk returns null, never throws', () => {
  assert.equal(parseSummary('not json at all'), null);
  assert.equal(parseSummary('```\ngarbage\n```'), null);
  assert.equal(parseSummary(null), null);
  assert.equal(parseSummary(undefined), null);
  assert.equal(parseSummary(42), null);
  assert.equal(parseSummary([1, 2]), null);
  assert.equal(parseSummary({ applications: ['Chrome'] }), null); // no activity
  assert.equal(parseSummary({ activity: '   ' }), null); // blank activity
});

test('parseSummary: clamps confidence and defaults to 0.5', () => {
  assert.equal(parseSummary({ activity: 'a', confidence: 3 }).confidence, 1);
  assert.equal(parseSummary({ activity: 'a', confidence: -2 }).confidence, 0);
  assert.equal(parseSummary({ activity: 'a' }).confidence, 0.5);
  assert.equal(parseSummary({ activity: 'a', confidence: 'nope' }).confidence, 0.5);
  assert.equal(parseSummary({ activity: 'a', confidence: null }).confidence, 0.5);
  assert.equal(parseSummary({ activity: 'a', confidence: '0.7' }).confidence, 0.7);
});

test('parseSummary: coerces applications to string[]', () => {
  assert.deepEqual(parseSummary({ activity: 'a' }).applications, []);
  assert.deepEqual(parseSummary({ activity: 'a', applications: 'Chrome' }).applications, []);
  assert.deepEqual(
    parseSummary({ activity: 'a', applications: [1, 'Chrome', null] }).applications,
    ['1', 'Chrome']
  );
});

test('buildSummarizeRequest: shape and timeline embedding', () => {
  const req = buildSummarizeRequest([
    { ts: at(14, 3), activeApp: 'Chrome', windowTitle: 'GitHub PR #42' },
  ]);
  assert.equal(typeof req.system, 'string');
  assert.ok(req.system.length > 0);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, 'user');
  assert.match(req.messages[0].content, /14:03-14:03 \(0m\) Chrome — GitHub PR #42/);

  const s = req.schema;
  assert.equal(s.type, 'object');
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required.sort(), ['activity', 'applications', 'confidence']);
  assert.equal(s.properties.activity.type, 'string');
  assert.equal(s.properties.applications.type, 'array');
  assert.equal(s.properties.applications.items.type, 'string');
  assert.equal(s.properties.confidence.type, 'number');
  // Anthropic structured outputs do not support numeric bounds.
  assert.ok(!('minimum' in s.properties.confidence));
  assert.ok(!('maximum' in s.properties.confidence));
});

test('buildChatRequest: embeds question, memories, and raw timeline', () => {
  const req = buildChatRequest({
    question: 'what was I doing before lunch?',
    memories: [
      { tsStart: at(11, 0), tsEnd: at(11, 30), activity: 'editing slides', apps: ['Keynote'], confidence: 0.8 },
    ],
    observations: [
      { ts: at(11, 40), activeApp: 'Slack', windowTitle: '#general' },
    ],
    now: at(12, 5),
  });
  assert.equal(typeof req.system, 'string');
  assert.ok(req.system.length > 0);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, 'user');
  const c = req.messages[0].content;
  assert.match(c, /what was I doing before lunch\?/);
  assert.match(c, /11:00-11:30 editing slides \[Keynote\]/);
  assert.match(c, /11:40-11:40 \(0m\) Slack — #general/);
  assert.match(c, /12:05/);
});

test('buildChatRequest: empty context is labeled, not invented', () => {
  const req = buildChatRequest({ question: 'anything?', memories: [], observations: [], now: at(9, 0) });
  assert.match(req.messages[0].content, /\(none\)/);
  assert.match(req.messages[0].content, /anything\?/);
});

test('buildPatternRequest: shape and schema', () => {
  const req = buildPatternRequest({
    memories: [
      { tsStart: at(10, 0), tsEnd: at(10, 20), activity: 'copying rows into a spreadsheet', apps: ['Excel'], confidence: 0.9 },
    ],
  });
  assert.equal(typeof req.system, 'string');
  assert.ok(req.system.length > 0);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, 'user');
  assert.match(req.messages[0].content, /copying rows into a spreadsheet/);

  const s = req.schema;
  assert.equal(s.type, 'object');
  assert.equal(s.additionalProperties, false);
  // `pattern` and `occurrences` are required, not decorative. `pattern` names
  // the behaviour so the same one is not raised twice however differently the
  // model words it on a later pass, and `occurrences` is what separates a
  // repeated workflow from something that happened to be done twice. Both are
  // the difference between a useful companion and one that gets muted.
  assert.deepEqual(
    s.required.slice().sort(),
    ['confidence', 'interrupt', 'message', 'occurrences', 'pattern', 'reason']
  );
  assert.equal(s.properties.interrupt.type, 'boolean');
  assert.equal(s.properties.reason.type, 'string');
  assert.equal(s.properties.confidence.type, 'number');
  assert.equal(s.properties.message.type, 'string');
  assert.equal(s.properties.pattern.type, 'string');
  assert.equal(s.properties.occurrences.type, 'number');
});
