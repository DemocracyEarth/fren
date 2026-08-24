const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMemory } = require('..');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-'));
  return path.join(dir, 'memory.db');
}

test('observation insert + query round trip with camelCase mapping', () => {
  const mem = openMemory(tempDb());
  const id = mem.addObservation({
    ts: 1000,
    activeApp: 'VS Code',
    windowTitle: 'index.js — fren',
    screenshotPath: '/shots/a.jpg',
  });
  assert.strictEqual(typeof id, 'number');

  const rows = mem.getRecentObservations();
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], {
    id,
    ts: 1000,
    activeApp: 'VS Code',
    windowTitle: 'index.js — fren',
    screenshotPath: '/shots/a.jpg',
    summarized: 0,
  });
  mem.close();
});

test('observation optional fields default to null', () => {
  const mem = openMemory(tempDb());
  mem.addObservation({ ts: 1, activeApp: 'Finder' });
  const [row] = mem.getRecentObservations();
  assert.strictEqual(row.windowTitle, null);
  assert.strictEqual(row.screenshotPath, null);
  mem.close();
});

test('getRecentObservations honors sinceMs and limit, ascending order', () => {
  const mem = openMemory(tempDb());
  // Insert out of ts order to prove ordering comes from the query.
  mem.addObservation({ ts: 300, activeApp: 'C' });
  mem.addObservation({ ts: 100, activeApp: 'A' });
  mem.addObservation({ ts: 200, activeApp: 'B' });

  const all = mem.getRecentObservations();
  assert.deepStrictEqual(all.map((r) => r.ts), [100, 200, 300]);

  const since = mem.getRecentObservations({ sinceMs: 200 });
  assert.deepStrictEqual(since.map((r) => r.activeApp), ['B', 'C']);

  // limit keeps the NEWEST rows, still returned ascending
  const limited = mem.getRecentObservations({ limit: 2 });
  assert.deepStrictEqual(limited.map((r) => r.ts), [200, 300]);
  mem.close();
});

test('markSummarized flips only the given ids; getUnsummarizedObservations filters', () => {
  const mem = openMemory(tempDb());
  const a = mem.addObservation({ ts: 1, activeApp: 'A' });
  const b = mem.addObservation({ ts: 2, activeApp: 'B' });
  const c = mem.addObservation({ ts: 3, activeApp: 'C' });

  mem.markSummarized([a, c]);

  const unsummarized = mem.getUnsummarizedObservations();
  assert.deepStrictEqual(unsummarized.map((r) => r.id), [b]);

  const limited = mem.getUnsummarizedObservations(1);
  assert.strictEqual(limited.length, 1);

  mem.markSummarized([]); // no-op, must not throw
  mem.close();
});

test('memory apps JSON round trip and camelCase mapping', () => {
  const mem = openMemory(tempDb());
  const id = mem.addMemory({
    tsStart: 1000,
    tsEnd: 2000,
    activity: 'debugging the auth flow',
    apps: ['VS Code', 'Chrome'],
    confidence: 0.8,
    rawCount: 12,
  });

  const rows = mem.getRecentMemories();
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], {
    id,
    tsStart: 1000,
    tsEnd: 2000,
    activity: 'debugging the auth flow',
    apps: ['VS Code', 'Chrome'],
    confidence: 0.8,
    rawCount: 12,
  });
  mem.close();
});

test('getRecentMemories honors sinceMs and limit, ascending', () => {
  const mem = openMemory(tempDb());
  mem.addMemory({ tsStart: 300, tsEnd: 350, activity: 'c', apps: [] });
  mem.addMemory({ tsStart: 100, tsEnd: 150, activity: 'a', apps: [] });
  mem.addMemory({ tsStart: 200, tsEnd: 250, activity: 'b', apps: [] });

  const all = mem.getRecentMemories();
  assert.deepStrictEqual(all.map((r) => r.activity), ['a', 'b', 'c']);

  const since = mem.getRecentMemories({ sinceMs: 200 });
  assert.deepStrictEqual(since.map((r) => r.activity), ['b', 'c']);

  // limit keeps the NEWEST rows, still returned ascending
  const limited = mem.getRecentMemories({ limit: 1 });
  assert.deepStrictEqual(limited.map((r) => r.activity), ['c']);
  mem.close();
});

test('suggestions insert and query', () => {
  const mem = openMemory(tempDb());
  const id = mem.addSuggestion({ ts: 5, message: 'take a break', pattern: 'long-session' });
  const rows = mem.getSuggestions();
  assert.deepStrictEqual(rows, [
    // draft is null until asked: fren proposes an automation only on request,
    // and never runs what it writes.
    { id, ts: 5, message: 'take a break', pattern: 'long-session', status: 'proposed', draft: null },
  ]);
  mem.close();
});

test('cleanup deletes expired observations and collects their screenshot paths', () => {
  const mem = openMemory(tempDb());
  const now = Date.now();
  const old = now - 10 * 24 * 60 * 60 * 1000; // 10 days ago

  mem.addObservation({ ts: old, activeApp: 'Old', screenshotPath: '/shots/old.jpg' });
  mem.addObservation({ ts: old + 1, activeApp: 'OldNoShot' });
  mem.addObservation({ ts: now, activeApp: 'Fresh', screenshotPath: '/shots/fresh.jpg' });

  const result = mem.cleanup({ retentionDays: 7, maxScreenshots: 10 });
  assert.strictEqual(result.deletedObservations, 2);
  assert.deepStrictEqual(result.screenshotPathsToDelete, ['/shots/old.jpg']);

  const remaining = mem.getRecentObservations();
  assert.deepStrictEqual(remaining.map((r) => r.activeApp), ['Fresh']);
  assert.strictEqual(remaining[0].screenshotPath, '/shots/fresh.jpg');
  mem.close();
});

test('cleanup caps screenshots: keeps newest N, nulls the rest, collects paths', () => {
  const mem = openMemory(tempDb());
  const now = Date.now();

  // 4 recent observations with screenshots, oldest first.
  for (let i = 0; i < 4; i++) {
    mem.addObservation({
      ts: now - (4 - i) * 1000,
      activeApp: `App${i}`,
      screenshotPath: `/shots/${i}.jpg`,
    });
  }

  const result = mem.cleanup({ retentionDays: 7, maxScreenshots: 2 });
  assert.strictEqual(result.deletedObservations, 0);
  // The two oldest lose their screenshot references.
  assert.deepStrictEqual(result.screenshotPathsToDelete.sort(), ['/shots/0.jpg', '/shots/1.jpg']);

  const rows = mem.getRecentObservations();
  assert.deepStrictEqual(
    rows.map((r) => r.screenshotPath),
    [null, null, '/shots/2.jpg', '/shots/3.jpg']
  );
  // Rows themselves survive — only screenshot references are dropped.
  assert.strictEqual(rows.length, 4);
  mem.close();
});

test('cleanup combines retention deletes and screenshot cap in one pass', () => {
  const mem = openMemory(tempDb());
  const now = Date.now();
  const old = now - 10 * 24 * 60 * 60 * 1000;

  mem.addObservation({ ts: old, activeApp: 'Expired', screenshotPath: '/shots/expired.jpg' });
  mem.addObservation({ ts: now - 3000, activeApp: 'A', screenshotPath: '/shots/a.jpg' });
  mem.addObservation({ ts: now - 2000, activeApp: 'B', screenshotPath: '/shots/b.jpg' });
  mem.addObservation({ ts: now - 1000, activeApp: 'C', screenshotPath: '/shots/c.jpg' });

  const result = mem.cleanup({ retentionDays: 7, maxScreenshots: 2 });
  assert.strictEqual(result.deletedObservations, 1);
  assert.deepStrictEqual(
    result.screenshotPathsToDelete.sort(),
    ['/shots/a.jpg', '/shots/expired.jpg']
  );
  mem.close();
});

test('close() closes the database; further use throws', () => {
  const dbPath = tempDb();
  const mem = openMemory(dbPath);
  mem.addObservation({ ts: 1, activeApp: 'A' });
  mem.close();
  assert.throws(() => mem.addObservation({ ts: 2, activeApp: 'B' }));

  // Reopening the same file sees the persisted row.
  const reopened = openMemory(dbPath);
  assert.strictEqual(reopened.getRecentObservations().length, 1);
  reopened.close();
});

// --- day-shaped reads, for the dashboard ------------------------------------

test('getMemoriesBetween returns a day in order, and excludes its neighbours', () => {
  const mem = openMemory(':memory:');
  const day = (h) => new Date(2026, 7, 20, h).getTime();
  mem.addMemory({ tsStart: day(23) - 86400000, tsEnd: day(23) - 86400000, activity: 'the day before', apps: [], confidence: 1, rawCount: 1 });
  mem.addMemory({ tsStart: day(9), tsEnd: day(10), activity: 'morning', apps: ['A'], confidence: 1, rawCount: 1 });
  mem.addMemory({ tsStart: day(14), tsEnd: day(15), activity: 'afternoon', apps: ['B'], confidence: 1, rawCount: 1 });
  mem.addMemory({ tsStart: day(9) + 86400000, tsEnd: day(9) + 86400000, activity: 'the day after', apps: [], confidence: 1, rawCount: 1 });

  const got = mem.getMemoriesBetween({
    fromMs: new Date(2026, 7, 20).getTime(),
    toMs: new Date(2026, 7, 21).getTime(),
  });
  assert.deepEqual(got.map((m) => m.activity), ['morning', 'afternoon'],
    'a day must not bleed into the ones on either side of it');
  mem.close();
});

test('getActiveDays reports which days hold anything, newest first', () => {
  const mem = openMemory(':memory:');
  const at = (d, h) => new Date(2026, 7, d, h).getTime();
  mem.addMemory({ tsStart: at(18, 9), tsEnd: at(18, 10), activity: 'a', apps: [], confidence: 1, rawCount: 1 });
  mem.addMemory({ tsStart: at(20, 9), tsEnd: at(20, 10), activity: 'b', apps: [], confidence: 1, rawCount: 1 });
  mem.addMemory({ tsStart: at(20, 14), tsEnd: at(20, 15), activity: 'c', apps: [], confidence: 1, rawCount: 1 });

  const days = mem.getActiveDays();
  assert.equal(days[0].day, '2026-08-20');
  assert.equal(days[0].memories, 2);
  assert.equal(days[1].day, '2026-08-18');
  assert.equal(days[1].memories, 1);
  mem.close();
});

test('getScreenshotsBetween returns only observations that actually have one', () => {
  const mem = openMemory(':memory:');
  const t = new Date(2026, 7, 20, 10).getTime();
  mem.addObservation({ ts: t, activeApp: 'Safari', windowTitle: 'a', screenshotPath: '/tmp/a.jpg' });
  mem.addObservation({ ts: t + 1000, activeApp: 'Safari', windowTitle: 'b' });   // no shot
  const got = mem.getScreenshotsBetween({
    fromMs: new Date(2026, 7, 20).getTime(),
    toMs: new Date(2026, 7, 21).getTime(),
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].screenshotPath, '/tmp/a.jpg');
  mem.close();
});

// --- the conversation -------------------------------------------------------
//
// The most sensitive thing in the database, and the newest. Until recently the
// chat lived only in the panel's DOM; it is written down now so it can be read
// back in the big window.

test('a message round-trips, and a blank one is not a message', () => {
  const mem = openMemory(tempDb());
  mem.addMessage({ role: 'you', text: 'what have I been up to?' });
  mem.addMessage({ role: 'fren', text: 'Mostly Figma.' });
  assert.equal(mem.addMessage({ role: 'you', text: '   ' }), null);
  const got = mem.getMessages();
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((m) => m.role), ['you', 'fren']);
  assert.equal(got[0].text, 'what have I been up to?');
  mem.close();
});

test('an unknown role is recorded as yours, never as fren', () => {
  // Fail toward attributing speech to the person, not to the character. A line
  // wrongly labelled "fren" is fren appearing to have said something it did not.
  const mem = openMemory(tempDb());
  mem.addMessage({ role: 'assistant', text: 'hello' });
  mem.addMessage({ role: undefined, text: 'hello again' });
  assert.deepEqual(mem.getMessages().map((m) => m.role), ['you', 'you']);
  mem.close();
});

test('the conversation is read back oldest first', () => {
  const mem = openMemory(tempDb());
  const now = Date.now();
  mem.addMessage({ ts: now - 3000, role: 'you', text: 'first' });
  mem.addMessage({ ts: now - 2000, role: 'fren', text: 'second' });
  mem.addMessage({ ts: now - 1000, role: 'you', text: 'third' });
  assert.deepEqual(mem.getMessages().map((m) => m.text), ['first', 'second', 'third']);
  mem.close();
});

test('a limit keeps the LATEST messages, still in order', () => {
  const mem = openMemory(tempDb());
  const now = Date.now();
  for (let i = 0; i < 10; i++) mem.addMessage({ ts: now + i, role: 'you', text: `m${i}` });
  const got = mem.getMessages({ limit: 3 });
  assert.deepEqual(got.map((m) => m.text), ['m7', 'm8', 'm9']);
  mem.close();
});

test('the conversation expires with the observations it is about', () => {
  const mem = openMemory(tempDb());
  const now = Date.now();
  mem.addMessage({ ts: now - 40 * 86400000, role: 'you', text: 'long ago' });
  mem.addMessage({ ts: now, role: 'you', text: 'today' });
  const r = mem.cleanup({ retentionDays: 30, maxScreenshots: 100 });
  assert.equal(r.deletedMessages, 1);
  assert.deepEqual(mem.getMessages().map((m) => m.text), ['today']);
  mem.close();
});

test('forgetting the conversation removes the bytes, not just the rows', () => {
  // DELETE alone is not forgetting: the rows leave the table but the text stays
  // legible inside the database file and its -wal sibling. The button says
  // "Forget" and the privacy document says the bytes go, so this is the test
  // that keeps that true.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fren-forget-'));
  const file = path.join(dir, 'forget.db');
  const mem = openMemory(file);
  const secret = 'XYZZY-A-VERY-DISTINCTIVE-CONFESSION';
  mem.addMessage({ role: 'you', text: secret });
  assert.equal(mem.clearMessages(), 1);
  mem.close();

  const still = fs.readdirSync(dir)
    .filter((n) => fs.readFileSync(path.join(dir, n)).includes(secret));
  assert.deepEqual(still, [], `text survived in: ${still.join(', ')}`);
});

test('forgetting the conversation leaves everything else alone', () => {
  const mem = openMemory(tempDb());
  mem.addObservation({ ts: Date.now(), activeApp: 'Figma', windowTitle: 'a file' });
  mem.addMessage({ role: 'you', text: 'something' });
  mem.setSetting('profile', { name: 'Sam' });
  mem.clearMessages();
  assert.equal(mem.getMessages().length, 0);
  assert.equal(mem.getRecentObservations({ limit: 10 }).length, 1, 'observations survive');
  assert.equal(mem.getSetting('profile').name, 'Sam', 'settings survive');
  mem.close();
});
