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
-- Routines: things fren does at a time, rather than when asked.
--
-- What a routine does is deliberately narrow: it ASKS fren something and reads
-- the answer back. It does not run commands. Scheduling arbitrary generated
-- scripts is a different and much larger decision than scheduling a question,
-- and this schema does not quietly leave the door open for it.
CREATE TABLE IF NOT EXISTS routines (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  prompt   TEXT NOT NULL,
  hour     INTEGER NOT NULL,
  minute   INTEGER NOT NULL,
  days     TEXT NOT NULL DEFAULT '',   -- '' = every day, else '1,2,3,4,5'
  enabled  INTEGER NOT NULL DEFAULT 1,
  created  INTEGER,
  last_run INTEGER,
  last_text TEXT
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
  status TEXT NOT NULL DEFAULT 'proposed',
  -- A drafted automation, as JSON. fren writes it; the user reads it and
  -- decides. Nothing here is ever executed.
  draft TEXT
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

    /**
     * Memories inside a window, oldest first. The dashboard reads a day at a
     * time rather than "the most recent N", because a day is the unit a person
     * actually thinks in.
     */
    getMemoriesBetween({ fromMs, toMs, limit = 500 }) {
      const rows = db
        .prepare(
          'SELECT * FROM memories WHERE ts_start >= ? AND ts_start < ? ' +
          'ORDER BY ts_start ASC LIMIT ?'
        )
        .all(Number(fromMs), Number(toMs), Number(limit));
      return rows.map(rowToMemory);
    },

    /**
     * Observations in a window that have a screenshot on disk.
     *
     * These never leave the machine — they are not sent to the gateway or the
     * model, and showing them in a local window does not change that. It only
     * lets someone see what was already stored about them.
     */
    getScreenshotsBetween({ fromMs, toMs, limit = 200 }) {
      const rows = db
        .prepare(
          'SELECT ts, active_app, window_title, screenshot_path FROM observations ' +
          'WHERE screenshot_path IS NOT NULL AND ts >= ? AND ts < ? ' +
          'ORDER BY ts ASC LIMIT ?'
        )
        .all(Number(fromMs), Number(toMs), Number(limit));
      return rows.map((r) => ({
        ts: r.ts,
        activeApp: r.active_app,
        windowTitle: r.window_title,
        screenshotPath: r.screenshot_path,
      }));
    },

    /** Which days have anything in them at all, newest first. */
    getActiveDays(limit = 60) {
      const rows = db
        .prepare(
          "SELECT date(ts_start / 1000, 'unixepoch', 'localtime') AS day, " +
          'COUNT(*) AS memories, MIN(ts_start) AS first_ts, MAX(ts_end) AS last_ts ' +
          'FROM memories GROUP BY day ORDER BY day DESC LIMIT ?'
        )
        .all(Number(limit));
      return rows.map((r) => ({
        day: r.day,
        memories: r.memories,
        firstTs: r.first_ts,
        lastTs: r.last_ts,
      }));
    },

    addSuggestion({ ts, message, pattern }) {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO suggestions (ts, message, pattern) VALUES (?, ?, ?)')
        .run(ts ?? null, message, pattern ?? null);
      return Number(lastInsertRowid);
    },

    setSuggestionStatus(id, status) {
      db.prepare('UPDATE suggestions SET status = ? WHERE id = ?')
        .run(String(status), Number(id));
    },

    /** Store a drafted automation against the pattern it came from. */
    setSuggestionDraft(id, draft) {
      db.prepare('UPDATE suggestions SET draft = ?, status = ? WHERE id = ?')
        .run(draft == null ? null : JSON.stringify(draft), 'drafted', Number(id));
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
        draft: (() => { try { return row.draft ? JSON.parse(row.draft) : null; } catch { return null; } })(),
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
    // ---- routines ---------------------------------------------------------
    addRoutine({ name, prompt, hour, minute, days = [], created = Date.now() }) {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO routines (name, prompt, hour, minute, days, created) ' +
                 'VALUES (?, ?, ?, ?, ?, ?)')
        .run(String(name), String(prompt), Number(hour), Number(minute),
             days.join(','), Number(created));
      return Number(lastInsertRowid);
    },

    getRoutines() {
      return db.prepare('SELECT * FROM routines ORDER BY hour ASC, minute ASC').all()
        .map((r) => ({
          id: r.id,
          name: r.name,
          prompt: r.prompt,
          hour: r.hour,
          minute: r.minute,
          days: r.days ? r.days.split(',').map(Number) : [],
          enabled: !!r.enabled,
          created: r.created,
          lastRun: r.last_run,
          lastText: r.last_text,
        }));
    },

    setRoutineEnabled(id, enabled) {
      db.prepare('UPDATE routines SET enabled = ? WHERE id = ?')
        .run(enabled ? 1 : 0, Number(id));
    },

    /** Record that a routine ran, and what it said. */
    markRoutineRun(id, ts, text) {
      db.prepare('UPDATE routines SET last_run = ?, last_text = ? WHERE id = ?')
        .run(Number(ts), text == null ? null : String(text).slice(0, 2000), Number(id));
    },

    deleteRoutine(id) {
      db.prepare('DELETE FROM routines WHERE id = ?').run(Number(id));
    },

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
