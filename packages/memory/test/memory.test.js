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

  const limited = mem.getRecentObservations({ limit: 2 });
  assert.deepStrictEqual(limited.map((r) => r.ts), [100, 200]);
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

  const limited = mem.getRecentMemories({ limit: 1 });
  assert.deepStrictEqual(limited.map((r) => r.activity), ['a']);
  mem.close();
});

test('suggestions insert and query', () => {
  const mem = openMemory(tempDb());
  const id = mem.addSuggestion({ ts: 5, message: 'take a break', pattern: 'long-session' });
  const rows = mem.getSuggestions();
  assert.deepStrictEqual(rows, [
    { id, ts: 5, message: 'take a break', pattern: 'long-session', status: 'proposed' },
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
