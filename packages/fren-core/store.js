'use strict';
/**
 * core.db — FREN Core's own store.
 *
 * One writer: the Core process. The desktop reads it over HTTP, never from
 * the file. It sits beside fren.db (the desktop's store) and is deliberately
 * a separate file so each database keeps one writer, the same discipline the
 * runtime keeps for its own files.
 *
 * Unlike fren.db this store has migrations from day one: a schema_version
 * ledger and numbered steps, because "CREATE TABLE IF NOT EXISTS" cannot add
 * a column to an existing install and this store will change.
 *
 * Every method is synchronous (node:sqlite). Timestamps are epoch ms. JSON
 * columns are stringified on the way in and parsed on the way out; a row with
 * unparseable JSON reads back as null rather than throwing, because a stored
 * row must never make the whole list unreadable.
 */
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  {
    name: '001-initial',
    up(db) {
      db.exec(`
        CREATE TABLE sessions (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL UNIQUE,
          created_at   INTEGER NOT NULL,
          runtime_ref  TEXT
        );
        CREATE TABLE runs (
          id             TEXT PRIMARY KEY,
          session_id     TEXT,
          kind           TEXT NOT NULL,           -- chat | agent | schedule
          status         TEXT NOT NULL,           -- queued | running | completed | failed | cancelled | interrupted
          automation_id  TEXT,
          input          TEXT,                    -- JSON: what started it, never sent anywhere
          started_at     INTEGER NOT NULL,
          ended_at       INTEGER,
          error          TEXT
        );
        CREATE INDEX idx_runs_started ON runs(started_at);
        CREATE INDEX idx_runs_session ON runs(session_id, started_at);
        CREATE TABLE run_messages (
          run_id   TEXT NOT NULL,
          seq      INTEGER NOT NULL,
          at       INTEGER NOT NULL,
          text     TEXT,
          files    TEXT,                          -- JSON array
          card     TEXT,                          -- JSON
          final    INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (run_id, seq)
        );
        CREATE TABLE automations (
          id                TEXT PRIMARY KEY,
          name              TEXT NOT NULL,
          trigger           TEXT NOT NULL,        -- JSON
          body              TEXT NOT NULL,        -- JSON
          permissions       TEXT NOT NULL DEFAULT '[]',
          enabled           INTEGER NOT NULL DEFAULT 1,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL,
          last_run_at       INTEGER,
          next_run_at       INTEGER,
          source            TEXT NOT NULL DEFAULT 'user',
          revision          INTEGER NOT NULL DEFAULT 1,
          paused_by_runtime TEXT,
          runtime_ref       TEXT                  -- JSON, opaque to everything but the runtime adapter
        );
        CREATE TABLE automation_runs (
          id             TEXT PRIMARY KEY,
          automation_id  TEXT NOT NULL,
          trigger        TEXT NOT NULL,           -- schedule | manual | event
          started_at     INTEGER NOT NULL,
          ended_at       INTEGER,
          status         TEXT NOT NULL,           -- started | ok | failed | blocked | skipped
          output         TEXT,
          delivered      INTEGER NOT NULL DEFAULT 0,
          run_id         TEXT
        );
        CREATE INDEX idx_automation_runs ON automation_runs(automation_id, started_at);
        CREATE TABLE permission_requests (
          id                  TEXT PRIMARY KEY,
          scope               TEXT NOT NULL,
          source              TEXT NOT NULL,      -- runtime | automation | core
          subject             TEXT,               -- JSON: sessionId, automationId, runId
          detail              TEXT NOT NULL,      -- JSON: title, question, options, payload
          runtime_request_id  TEXT,
          status              TEXT NOT NULL,      -- open | approved | denied | expired
          decision            TEXT,
          reason              TEXT,
          created_at          INTEGER NOT NULL,
          expires_at          INTEGER NOT NULL,
          resolved_at         INTEGER
        );
        CREATE TABLE events (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          at       INTEGER NOT NULL,
          type     TEXT NOT NULL,
          payload  TEXT NOT NULL
        );
        CREATE INDEX idx_events_at ON events(at);
      `);
    },
  },
  {
    name: '002-automation-network',
    up(db) {
      // The egress allowlist an agent automation may reach. JSON {domains:[...]}
      // or null (no allowlist declared; the environment keeps its current reach).
      db.exec('ALTER TABLE automations ADD COLUMN network TEXT');
    },
  },
];

const json = (v) => (v === undefined ? null : JSON.stringify(v));
function parse(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function openCoreStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  migrate(db);

  const rowToSession = (r) => (!r ? null : { id: r.id, name: r.name, createdAt: r.created_at, runtimeRef: parse(r.runtime_ref) });
  const rowToRun = (r) => (!r ? null : {
    id: r.id, sessionId: r.session_id, kind: r.kind, status: r.status, automationId: r.automation_id,
    input: parse(r.input), startedAt: r.started_at, endedAt: r.ended_at, error: r.error,
  });
  const rowToMessage = (r) => ({
    seq: r.seq, at: r.at, text: r.text, files: parse(r.files), card: parse(r.card), final: !!r.final,
  });
  const rowToAutomation = (r) => (!r ? null : {
    id: r.id, name: r.name, trigger: parse(r.trigger), body: parse(r.body), permissions: parse(r.permissions, []),
    network: parse(r.network, null),
    enabled: !!r.enabled, createdAt: r.created_at, updatedAt: r.updated_at, lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at, source: r.source, revision: r.revision, pausedByRuntime: r.paused_by_runtime,
    runtimeRef: parse(r.runtime_ref),
  });
  const rowToAutomationRun = (r) => (!r ? null : {
    id: r.id, automationId: r.automation_id, trigger: r.trigger, startedAt: r.started_at, endedAt: r.ended_at,
    status: r.status, output: r.output, delivered: !!r.delivered, runId: r.run_id,
  });
  const rowToRequest = (r) => (!r ? null : {
    id: r.id, scope: r.scope, source: r.source, subject: parse(r.subject, {}), detail: parse(r.detail, {}),
    runtimeRequestId: r.runtime_request_id, status: r.status, decision: r.decision, reason: r.reason,
    createdAt: r.created_at, expiresAt: r.expires_at, resolvedAt: r.resolved_at,
  });
  const rowToEvent = (r) => ({ id: r.id, at: r.at, type: r.type, ...parse(r.payload, {}) });

  return {
    // ---- sessions -----------------------------------------------------
    upsertSession({ id, name, createdAt = Date.now(), runtimeRef = null }) {
      db.prepare(`INSERT INTO sessions (id, name, created_at, runtime_ref) VALUES (?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET runtime_ref = excluded.runtime_ref`)
        .run(id, name, createdAt, json(runtimeRef));
    },
    getSession(id) {
      return rowToSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
    },
    getSessionByName(name) {
      return rowToSession(db.prepare('SELECT * FROM sessions WHERE name = ?').get(name));
    },
    listSessions() {
      return db.prepare('SELECT * FROM sessions ORDER BY created_at').all().map(rowToSession);
    },

    // ---- runs ---------------------------------------------------------
    insertRun({ id, sessionId = null, kind, status = 'queued', automationId = null, input = null, startedAt = Date.now() }) {
      db.prepare(`INSERT INTO runs (id, session_id, kind, status, automation_id, input, started_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, sessionId, kind, status, automationId, json(input), startedAt);
    },
    updateRun(id, patch) {
      const sets = [];
      const args = [];
      for (const [col, key] of [['status', 'status'], ['ended_at', 'endedAt'], ['error', 'error'], ['automation_id', 'automationId']]) {
        if (patch[key] !== undefined) { sets.push(`${col} = ?`); args.push(patch[key]); }
      }
      if (!sets.length) return;
      args.push(id);
      db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    },
    getRun(id) {
      const run = rowToRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
      if (!run) return null;
      run.messages = db.prepare('SELECT * FROM run_messages WHERE run_id = ? ORDER BY seq').all(id).map(rowToMessage);
      return run;
    },
    listRuns({ limit = 50, sessionId, automationId, status } = {}) {
      const where = [];
      const args = [];
      if (sessionId) { where.push('session_id = ?'); args.push(sessionId); }
      if (automationId) { where.push('automation_id = ?'); args.push(automationId); }
      if (status) { where.push('status = ?'); args.push(status); }
      const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT ?`;
      return db.prepare(sql).all(...args, limit).map(rowToRun);
    },
    addRunMessage(runId, { seq, at = Date.now(), text = null, files = null, card = null, final = false }) {
      db.prepare(`INSERT OR IGNORE INTO run_messages (run_id, seq, at, text, files, card, final)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(runId, seq, at, text, json(files), json(card), final ? 1 : 0);
    },
    /** Runs left open by a previous life of the process. */
    openRuns() {
      return db.prepare(`SELECT * FROM runs WHERE status IN ('queued', 'running')`).all().map(rowToRun);
    },

    // ---- automations ----------------------------------------------------
    insertAutomation(a) {
      db.prepare(`INSERT INTO automations (id, name, trigger, body, permissions, network, enabled, created_at, updated_at,
                    next_run_at, source, revision, runtime_ref)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(a.id, a.name, json(a.trigger), json(a.body), json(a.permissions || []), json(a.network ?? null), a.enabled === false ? 0 : 1,
          a.createdAt, a.updatedAt || a.createdAt, a.nextRunAt ?? null, a.source || 'user', json(a.runtimeRef ?? null));
    },
    updateAutomation(id, patch) {
      const map = {
        name: 'name', trigger: 'trigger', body: 'body', permissions: 'permissions', network: 'network', enabled: 'enabled',
        updatedAt: 'updated_at', lastRunAt: 'last_run_at', nextRunAt: 'next_run_at', pausedByRuntime: 'paused_by_runtime',
        runtimeRef: 'runtime_ref',
      };
      const jsonCols = new Set(['trigger', 'body', 'permissions', 'network', 'runtime_ref']);
      const sets = [];
      const args = [];
      for (const [key, col] of Object.entries(map)) {
        if (patch[key] === undefined) continue;
        sets.push(`${col} = ?`);
        let v = patch[key];
        if (jsonCols.has(col)) v = json(v);
        else if (col === 'enabled') v = v ? 1 : 0;
        args.push(v);
      }
      if (patch.bumpRevision) sets.push('revision = revision + 1');
      if (!sets.length) return;
      args.push(id);
      db.prepare(`UPDATE automations SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    },
    getAutomation(id) {
      return rowToAutomation(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
    },
    listAutomations() {
      return db.prepare('SELECT * FROM automations ORDER BY created_at').all().map(rowToAutomation);
    },
    deleteAutomation(id) {
      db.prepare('DELETE FROM automation_runs WHERE automation_id = ?').run(id);
      db.prepare('DELETE FROM automations WHERE id = ?').run(id);
    },

    // ---- automation runs -------------------------------------------------
    insertAutomationRun({ id, automationId, trigger, startedAt = Date.now(), status = 'started', runId = null }) {
      db.prepare(`INSERT INTO automation_runs (id, automation_id, trigger, started_at, status, run_id)
                  VALUES (?, ?, ?, ?, ?, ?)`).run(id, automationId, trigger, startedAt, status, runId);
      db.prepare('UPDATE automations SET last_run_at = ? WHERE id = ?').run(startedAt, automationId);
    },
    updateAutomationRun(id, { status, endedAt, output, delivered, trigger }) {
      const sets = [];
      const args = [];
      if (trigger !== undefined) { sets.push('trigger = ?'); args.push(trigger); }
      if (status !== undefined) { sets.push('status = ?'); args.push(status); }
      if (endedAt !== undefined) { sets.push('ended_at = ?'); args.push(endedAt); }
      if (output !== undefined) { sets.push('output = ?'); args.push(String(output).slice(0, 8000)); }
      if (delivered !== undefined) { sets.push('delivered = ?'); args.push(delivered ? 1 : 0); }
      if (!sets.length) return;
      args.push(id);
      db.prepare(`UPDATE automation_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    },
    getAutomationRun(id) {
      return rowToAutomationRun(db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id));
    },
    getAutomationRunByRunId(runId) {
      return rowToAutomationRun(db.prepare('SELECT * FROM automation_runs WHERE run_id = ?').get(runId));
    },
    listAutomationRuns(automationId, limit = 20) {
      return db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?')
        .all(automationId, limit).map(rowToAutomationRun);
    },

    // ---- permission requests -------------------------------------------
    insertPermissionRequest(r) {
      db.prepare(`INSERT INTO permission_requests (id, scope, source, subject, detail, runtime_request_id, status,
                    created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
        .run(r.id, r.scope, r.source, json(r.subject || {}), json(r.detail || {}), r.runtimeRequestId ?? null,
          r.createdAt, r.expiresAt);
    },
    getPermissionRequest(id) {
      return rowToRequest(db.prepare('SELECT * FROM permission_requests WHERE id = ?').get(id));
    },
    listPermissionRequests({ status } = {}) {
      const sql = status
        ? 'SELECT * FROM permission_requests WHERE status = ? ORDER BY created_at DESC'
        : 'SELECT * FROM permission_requests ORDER BY created_at DESC LIMIT 200';
      return (status ? db.prepare(sql).all(status) : db.prepare(sql).all()).map(rowToRequest);
    },
    resolvePermissionRequest(id, { status, decision = null, reason = null, resolvedAt = Date.now() }) {
      db.prepare(`UPDATE permission_requests SET status = ?, decision = ?, reason = ?, resolved_at = ?
                  WHERE id = ? AND status = 'open'`).run(status, decision, reason, resolvedAt, id);
    },

    // ---- events -----------------------------------------------------------
    appendEvent(type, payload, at = Date.now()) {
      const info = db.prepare('INSERT INTO events (at, type, payload) VALUES (?, ?, ?)').run(at, type, json(payload || {}));
      return Number(info.lastInsertRowid);
    },
    eventsSince(id, limit = 500) {
      return db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(id, limit).map(rowToEvent);
    },
    lastEventId() {
      const row = db.prepare('SELECT MAX(id) AS id FROM events').get();
      return row && row.id ? row.id : 0;
    },

    /** Retention: runs and events are working memory, not the archive. */
    prune({ beforeMs }) {
      const runs = db.prepare(`DELETE FROM runs WHERE started_at < ? AND status NOT IN ('queued', 'running')`).run(beforeMs);
      db.prepare('DELETE FROM run_messages WHERE run_id NOT IN (SELECT id FROM runs)').run();
      const events = db.prepare('DELETE FROM events WHERE at < ?').run(beforeMs);
      return { runs: Number(runs.changes), events: Number(events.changes) };
    },

    version() {
      return db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v || 0;
    },
    close() {
      db.close();
    },
  };
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied INTEGER NOT NULL)`);
  const applied = new Set(db.prepare('SELECT name FROM schema_version').all().map((r) => r.name));
  MIGRATIONS.forEach((m, i) => {
    if (applied.has(m.name)) return;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(i + 1, m.name, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
}

module.exports = { openCoreStore, MIGRATIONS };
