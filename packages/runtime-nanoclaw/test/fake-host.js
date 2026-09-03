'use strict';
/**
 * A stand-in for the vendored host, for testing the adapter with no
 * container runtime: it speaks the bridge protocol like the fren channel
 * does, serves a control socket like `ncl` does, and plays an agent that
 * echoes, asks for permission when told to, and answers scheduled tasks.
 *
 * Started by the adapter under test exactly as the real host would be
 * (cwd = runtime dir, env from hostEnv()), so what the adapter sees is what
 * it would see in production, minus the container.
 */
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const corePath = process.env.FREN_CORE_SOCKET;
const token = process.env.FREN_RUNTIME_TOKEN;
const dataDir = path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const nclPath = path.join(dataDir, 'ncl.sock');

// ---- the "central DB" ------------------------------------------------------
const db = { groups: [], users: [], roles: [], mgs: [], wirings: [], destinations: [], tasks: [] };
// Tasks outlive a host process, like the real host's rows do.
const tasksFile = path.join(dataDir, 'tasks.json');
try { db.tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch { /* first life */ }
function save() { fs.writeFileSync(tasksFile, JSON.stringify(db.tasks)); }
let ids = 0;
const nid = (p) => `${p}-${(ids += 1)}`;
const items = (list) => list;

const commands = {
  help: () => ({ commands: Object.keys(commands) }),
  'groups-list': () => items(db.groups),
  'groups-create': ({ folder, name }) => { if (db.groups.some((g) => g.folder === folder)) throw new Error('already exists'); const g = { id: nid('ag'), folder, name }; db.groups.push(g); return g; },
  'groups-config-update': (a) => ({ ok: true, ...a }),
  'users-list': () => items(db.users),
  'users-create': ({ id, kind, display_name }) => { const u = { id, kind, display_name }; db.users.push(u); return u; },
  'roles-list': () => items(db.roles),
  'roles-grant': ({ user, role }) => { const r = { user_id: user, role }; db.roles.push(r); return r; },
  'messaging-groups-list': () => items(db.mgs),
  'messaging-groups-create': (a) => { const m = { id: nid('mg'), channel_type: a.channel_type, platform_id: a.platform_id, instance: a.instance || a.channel_type, name: a.name }; db.mgs.push(m); return m; },
  'messaging-groups-delete': ({ id }) => { db.mgs = db.mgs.filter((m) => m.id !== id); return { deleted: true }; },
  'wirings-list': () => items(db.wirings),
  'wirings-create': (a) => { const mg = db.mgs.find((m) => m.channel_type === a.channel_type && m.platform_id === a.platform_id); const ag = db.groups.find((g) => g.folder === a.agent_group); const w = { id: nid('w'), messaging_group_id: mg.id, agent_group_id: ag.id, session_mode: a.session_mode }; db.wirings.push(w); return w; },
  'destinations-add': (a) => { const d = { ...a }; db.destinations.push(d); db.lastDestination = a.local_name; return d; },
  'destinations-remove': (a) => { db.destinations = db.destinations.filter((d) => d.local_name !== a.local_name); return { removed: true }; },
  // The list shortens prompts like the real host's does; get returns the whole task and its run log.
  'tasks-list': () => items(db.tasks.map((t) => { const { recent_log, name, ...row } = taskRow(t); return { ...row, process_after: t.next_run, prompt: row.prompt.length > 120 ? row.prompt.slice(0, 117) + '...' : row.prompt }; })),
  // Like the real host's, get has the whole prompt, the run log and completed_runs, and none of the list's extras.
  'tasks-get': ({ id }) => { const t = db.tasks.find((x) => x.series_id === id); if (!t) throw new Error(`task not found: ${id}`); const { runs, next_run, last_run, name, ...row } = taskRow(t); return { ...row, process_after: t.next_run, completed_runs: t.runs }; },
  'tasks-create': (a) => { const series = `${(a.name || 't').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${nid('x').slice(2)}`; const t = { destination: db.lastDestination || null, series_id: series, row_id: series, session_id: nid('ses'), name: a.name, prompt: a.prompt, recurrence: a.recurrence || null, status: 'pending', runs: 0, failed_runs: 0, last_run: null, next_run: a.process_after ? new Date(a.process_after).toISOString() : new Date(Date.now() + 3600e3).toISOString(), recent_log: [] }; db.tasks.push(t); save(); return taskRow(t); },
  'tasks-update': (a) => { const t = db.tasks.find((x) => x.series_id === a.id); if (!t) throw new Error(`task not found: ${a.id}`); if (a.prompt) t.prompt = a.prompt; if (a.recurrence) t.recurrence = a.recurrence; save(); return taskRow(t); },
  'tasks-pause': ({ id }) => { const t = db.tasks.find((x) => x.series_id === id); if (!t) throw new Error(`task not found: ${id}`); t.status = 'paused'; save(); return { paused: 1 }; },
  'tasks-resume': ({ id }) => { const t = db.tasks.find((x) => x.series_id === id); if (!t) throw new Error(`task not found: ${id}`); t.status = 'pending'; save(); return { resumed: 1 }; },
  'tasks-cancel': ({ id }) => ({ cancelled: id }),
  'tasks-delete': ({ id }) => { const before = db.tasks.length; db.tasks = db.tasks.filter((x) => x.series_id !== id); if (db.tasks.length === before) throw new Error(`task not found: ${id}`); save(); return { deleted: true }; },
  // Run-now inserts a due row the list hides behind the future one; the counters move once it is acknowledged.
  'tasks-run': ({ id }) => { const t = db.tasks.find((x) => x.series_id === id); if (!t) throw new Error(`task not found: ${id}`); const rowId = `${id}-run-${nid('r')}`; setTimeout(() => runTask(t, rowId).then(() => settle(t, { ok: true })), 20); return { series_id: id, row_id: rowId, status: 'pending' }; },
  /**
   * Test-only: a fire on the host's own clock. 'ok' and 'fail' make the live
   * row due, run it, acknowledge it and re-arm the series; 'silent' and
   * 'pause' re-arm without any of that, as a fire nobody watched would look
   * a sweep later.
   */
  'fake-fire': ({ id, outcome }) => {
    const t = db.tasks.find((x) => x.series_id === id); if (!t) throw new Error(`task not found: ${id}`);
    const rowId = t.row_id;
    const due = () => { t.next_run = new Date(Date.now() - 1000).toISOString(); save(); };
    if (outcome === 'ok' || outcome === 'fail') {
      due();
      setTimeout(async () => {
        if (outcome === 'ok') { await runTask(t, rowId); setTimeout(() => settle(t, { ok: true }), 100); return; }
        // The real host records a failed occurrence without a word about why.
        send({ type: 'turn', runId: rowId, status: 'failed', sessionId: t.session_id });
        setTimeout(() => settle(t, { ok: false }), 100);
      }, 150);
    } else if (outcome === 'eager') {
      // A warm container takes the row the moment it is due and answers at once.
      due();
      deliverTask(t).then(() => { send({ type: 'turn', runId: rowId, status: 'completed', sessionId: t.session_id }); setTimeout(() => settle(t, { ok: true }), 100); });
    } else if (outcome === 'quiet') {
      // The message arrives, the counters move, and no acknowledgement is ever reported.
      due();
      setTimeout(async () => { await deliverTask(t); setTimeout(() => settle(t, { ok: true }), 100); }, 150);
    } else if (outcome === 'retry') {
      // The host gives the same row a later time (a restart, a backoff), then runs it.
      due();
      setTimeout(() => {
        t.next_run = new Date(Date.now() + 300).toISOString(); t.tries = (t.tries || 0) + 1; save();
        setTimeout(async () => { await runTask(t, rowId); setTimeout(() => settle(t, { ok: true }), 100); }, 450);
      }, 150);
    } else if (outcome === 'silent') {
      settle(t, { ok: true });
    } else if (outcome === 'pause') {
      t.recent_log.push(`2026-09-04 09:00 — auto-paused after 8 consecutive script failures (host); fix the script, then \`ncl tasks resume ${id}\``);
      settle(t, { ok: false, paused: true });
    } else throw new Error('outcome must be ok, fail, eager, quiet, retry, silent or pause');
    return { series_id: id, row_id: rowId, outcome };
  },
};
function taskRow(t) { return { ...t }; }
/** The sweep after an acknowledgement: counters move, the next occurrence is armed. */
function settle(t, { ok, paused = false }) {
  if (ok) { t.runs += 1; t.last_run = new Date().toISOString(); } else t.failed_runs += 1;
  t.row_id = `${t.series_id}-${nid('row')}`;
  t.next_run = new Date(Date.now() + 3600e3).toISOString();
  if (paused) t.status = 'paused';
  // A row with no recurrence is not re-armed: the series is over.
  if (!t.recurrence) db.tasks = db.tasks.filter((x) => x !== t);
  save();
}

const nclServer = net.createServer((socket) => {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    const idx = buffer.indexOf('\n');
    if (idx < 0) return;
    const line = buffer.slice(0, idx);
    let frame;
    try { frame = JSON.parse(line); } catch { socket.end(JSON.stringify({ id: 'unknown', ok: false, error: { code: 'transport-error', message: 'bad frame' } }) + '\n'); return; }
    const fn = commands[frame.command];
    if (!fn) { socket.end(JSON.stringify({ id: frame.id, ok: false, error: { code: 'unknown-command', message: `unknown command ${frame.command}` } }) + '\n'); return; }
    try {
      const data = fn(frame.args || {});
      socket.end(JSON.stringify({ id: frame.id, ok: true, data }) + '\n');
    } catch (err) {
      socket.end(JSON.stringify({ id: frame.id, ok: false, error: { code: 'handler-error', message: err.message } }) + '\n');
    }
  });
});
try { fs.unlinkSync(nclPath); } catch { /* first life */ }
nclServer.listen(nclPath);

// ---- the bridge side --------------------------------------------------------
const link = net.createConnection(corePath);
link.setEncoding('utf8');
let acks = 0;
const waiting = new Map();
function send(frame) { link.write(JSON.stringify(frame) + '\n'); }
function deliver(frame) {
  acks += 1;
  const id = `d${acks}`;
  return new Promise((resolve) => { waiting.set(id, resolve); send({ type: 'deliver', id, ...frame }); });
}
link.on('connect', () => send({ type: 'hello', token, adapter: 'fren', version: 1 }));

const pendingAsks = new Map(); // questionId -> { runId, threadId, text }

async function onInbound(f) {
  send({ type: 'typing', platformId: f.platformId, threadId: f.threadId, on: true });
  if (/\[ask\]/i.test(f.text)) {
    const questionId = `apr-${f.id}`;
    pendingAsks.set(questionId, f);
    await deliver({ platformId: f.platformId, threadId: null, kind: 'chat-sdk', content: { type: 'ask_question', questionId, title: 'CLI: groups-config-update', question: `Allow "${f.text.replace(/\[ask\]\s*/i, '')}"?`, options: ['approve', 'reject', 'reject_with_reason'] } });
    return;
  }
  if (/\[slow\]/i.test(f.text)) await new Promise((r) => setTimeout(r, 300));
  await deliver({ platformId: f.platformId, threadId: f.threadId, kind: 'chat', content: { text: `(fake) you said: ${f.text}` } });
  send({ type: 'provenance', inReplyTo: f.id, kind: 'chat', sessionId: 'ses-1', agentGroupId: 'ag-1', platformId: f.platformId, threadId: f.threadId });
  send({ type: 'turn', runId: f.id, status: 'completed', sessionId: 'ses-1' });
}

async function onAction(f) {
  const ask = pendingAsks.get(f.questionId);
  if (!ask) return;
  pendingAsks.delete(f.questionId);
  const text = f.value === 'approve' ? `approved: (fake) did ${ask.text.replace(/\[ask\]\s*/i, '')}` : 'I did not do that — you declined.';
  await deliver({ platformId: ask.platformId, threadId: ask.threadId, kind: 'chat', content: { text } });
  send({ type: 'turn', runId: ask.id, status: 'completed', sessionId: 'ses-1' });
}

async function deliverTask(t) {
  // The agent sends to the destination the prompt names; here, the one made for this task.
  const fromDest = t.destination && /^automation-(.+)$/.exec(t.destination);
  const m = /automation-(atm_[0-9a-f]+)/.exec(t.prompt);
  const automationId = fromDest ? fromDest[1] : (m ? m[1] : 'unknown');
  await deliver({ platformId: `automation:${automationId}`, threadId: null, kind: 'chat', content: { text: `(fake) ${t.name} ran: ${t.prompt.split('\n').find((l) => l && !/^You are running|^Instruction:|^Delivery/.test(l)) || ''}`.trim() } });
}

async function runTask(t, rowId) {
  await deliverTask(t);
  send({ type: 'turn', runId: rowId, status: 'completed', sessionId: t.session_id });
}

let buffer = '';
link.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (frame.type === 'ack') { const r = waiting.get(frame.id); if (r) { waiting.delete(frame.id); r(frame); } }
    else if (frame.type === 'ping') send({ type: 'pong' });
    else if (frame.type === 'inbound') onInbound(frame).catch(() => {});
    else if (frame.type === 'action') onAction(frame).catch(() => {});
    else if (frame.type === 'watch') { /* task runs report on their own */ }
  }
});
link.on('close', () => process.exit(0));
link.on('error', () => process.exit(1));
process.on('SIGTERM', () => process.exit(0));
