const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  active_app TEXT NOT NULL,
  window_title TEXT,
  screenshot_path TEXT,
  summarized INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_observations_ts ON observations(ts);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  ts_start INTEGER,
  ts_end INTEGER,
  activity TEXT NOT NULL,
  apps TEXT NOT NULL,
  confidence REAL,
  raw_count INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY,
  ts INTEGER,
  message TEXT NOT NULL,
  pattern TEXT,
  status TEXT NOT NULL DEFAULT 'proposed'
);
`;

function rowToObservation(row) {
  return {
    id: row.id,
    ts: row.ts,
    activeApp: row.active_app,
    windowTitle: row.window_title,
    screenshotPath: row.screenshot_path,
    summarized: row.summarized,
  };
}

function rowToMemory(row) {
  return {
    id: row.id,
    tsStart: row.ts_start,
    tsEnd: row.ts_end,
    activity: row.activity,
    apps: JSON.parse(row.apps),
    confidence: row.confidence,
    rawCount: row.raw_count,
  };
}

function openMemory(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);

  return {
    addObservation({ ts, activeApp, windowTitle, screenshotPath }) {
      const { lastInsertRowid } = db
        .prepare(
          'INSERT INTO observations (ts, active_app, window_title, screenshot_path) VALUES (?, ?, ?, ?)'
        )
        .run(ts, activeApp, windowTitle ?? null, screenshotPath ?? null);
      return Number(lastInsertRowid);
    },

    getRecentObservations({ sinceMs, limit = 500 } = {}) {
      // Newest N rows, returned in ascending order — "recent" must mean the
      // latest activity, not the oldest rows that happen to match.
      const rows = db
        .prepare(
          `SELECT * FROM (
             SELECT * FROM observations WHERE ts >= ? ORDER BY ts DESC, id DESC LIMIT ?
           ) ORDER BY ts ASC, id ASC`
        )
        .all(sinceMs ?? 0, limit);
      return rows.map(rowToObservation);
    },

    getUnsummarizedObservations(limit = 500) {
      const rows = db
        .prepare(
          'SELECT * FROM observations WHERE summarized = 0 ORDER BY ts ASC, id ASC LIMIT ?'
        )
        .all(limit);
      return rows.map(rowToObservation);
    },

    markSummarized(ids) {
      if (!ids || ids.length === 0) return;
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(
        `UPDATE observations SET summarized = 1 WHERE id IN (${placeholders})`
      ).run(...ids);
    },

    addMemory({ tsStart, tsEnd, activity, apps, confidence, rawCount }) {
      const { lastInsertRowid } = db
        .prepare(
          'INSERT INTO memories (ts_start, ts_end, activity, apps, confidence, raw_count) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(
          tsStart ?? null,
          tsEnd ?? null,
          activity,
          JSON.stringify(apps),
          confidence ?? null,
          rawCount ?? null
        );
      return Number(lastInsertRowid);
    },

    getRecentMemories({ sinceMs, limit = 50 } = {}) {
      // Newest N rows, ascending. COALESCE so rows with NULL ts_start still
      // appear when no sinceMs is given.
      const rows = db
        .prepare(
          `SELECT * FROM (
             SELECT * FROM memories WHERE COALESCE(ts_start, 0) >= ?
             ORDER BY COALESCE(ts_start, 0) DESC, id DESC LIMIT ?
           ) ORDER BY COALESCE(ts_start, 0) ASC, id ASC`
        )
        .all(sinceMs ?? 0, limit);
      return rows.map(rowToMemory);
    },

    addSuggestion({ ts, message, pattern }) {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO suggestions (ts, message, pattern) VALUES (?, ?, ?)')
        .run(ts ?? null, message, pattern ?? null);
      return Number(lastInsertRowid);
    },

    getSuggestions() {
      const rows = db
        .prepare('SELECT * FROM suggestions ORDER BY ts ASC, id ASC')
        .all();
      return rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        message: row.message,
        pattern: row.pattern,
        status: row.status,
      }));
    },

    // Deletes old rows and caps screenshot references; the CALLER unlinks the
    // returned paths — this module never touches the filesystem.
    cleanup({ retentionDays, maxScreenshots }) {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const screenshotPathsToDelete = [];

      const expired = db
        .prepare(
          'SELECT screenshot_path FROM observations WHERE ts < ? AND screenshot_path IS NOT NULL'
        )
        .all(cutoff);
      for (const row of expired) screenshotPathsToDelete.push(row.screenshot_path);

      const { changes } = db
        .prepare('DELETE FROM observations WHERE ts < ?')
        .run(cutoff);
      const deletedObservations = Number(changes);

      // Among what remains, only the newest maxScreenshots keep their files.
      const excess = db
        .prepare(
          `SELECT id, screenshot_path FROM observations
           WHERE screenshot_path IS NOT NULL
           ORDER BY ts DESC, id DESC
           LIMIT -1 OFFSET ?`
        )
        .all(maxScreenshots);
      if (excess.length > 0) {
        const placeholders = excess.map(() => '?').join(',');
        db.prepare(
          `UPDATE observations SET screenshot_path = NULL WHERE id IN (${placeholders})`
        ).run(...excess.map((row) => row.id));
        for (const row of excess) screenshotPathsToDelete.push(row.screenshot_path);
      }

      return { deletedObservations, screenshotPathsToDelete };
    },

    /**
     * Small key/value store for what the user TELLS fren, as opposed to what
     * fren observes. Kept apart from memories on purpose: observations expire,
     * and someone's name should not.
     */
    getSetting(key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
      if (!row) return null;
      try { return JSON.parse(row.value); } catch { return null; }
    },

    setSetting(key, value) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ' +
                 'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(String(key), JSON.stringify(value ?? null));
    },

    close() {
      db.close();
    },
  };
}

module.exports = { openMemory };
