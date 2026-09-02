'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { createNclClient } = require('../ncl-client');
const { createBridge } = require('../bridge');
const { detect } = require('../container-runtime');
const { createScheduleStore } = require('../schedules');

const tmpSock = (name) => path.join(fs.mkdtempSync('/tmp/frn-'), name);

test('the control client sends one frame per connection and reads one answer', async () => {
  const sock = tmpSock('ncl.sock');
  const seen = [];
  const server = net.createServer((s) => {
    s.setEncoding('utf8');
    s.on('data', (d) => {
      const f = JSON.parse(d);
      seen.push(f);
      if (f.command === 'boom') s.end(JSON.stringify({ id: f.id, ok: false, error: { code: 'invalid-args', message: 'nope' } }) + '\n');
      else s.end(JSON.stringify({ id: f.id, ok: true, data: { echo: f.args } }) + '\n');
    });
  }).listen(sock);
  await once(server, 'listening');
  const ncl = createNclClient({ socketPath: sock });
  const data = await ncl.call('tasks-create', { group: 'fren', name: 'x' });
  assert.deepEqual(data, { echo: { group: 'fren', name: 'x' } });
  await assert.rejects(() => ncl.call('boom'), (err) => err.code === 'invalid-args' && /nope/.test(err.message));
  assert.equal(await ncl.alive(), true);
  server.close();
  const dead = createNclClient({ socketPath: sock + '.missing', timeoutMs: 200 });
  assert.equal(await dead.alive(), false);
});

test('the bridge refuses a stranger and welcomes the host', async () => {
  const sock = tmpSock('fren-runtime.sock');
  const frames = [];
  const bridge = createBridge({ socketPath: sock, token: 't0k', onFrame: (f, reply) => { frames.push(f); if (f.type === 'deliver') reply({ ok: true, messageId: 'm1' }); }, log: () => {} });
  await bridge.listen();
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);

  const stranger = net.createConnection(sock);
  await once(stranger, 'connect');
  stranger.write(JSON.stringify({ type: 'hello', token: 'wrong' }) + '\n');
  await once(stranger, 'close');
  assert.equal(bridge.isConnected(), false);

  const host = net.createConnection(sock);
  host.setEncoding('utf8');
  await once(host, 'connect');
  const lines = [];
  host.on('data', (d) => lines.push(...d.split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  host.write(JSON.stringify({ type: 'hello', token: 't0k' }) + '\n');
  await bridge.waitForPeer(1000);
  assert.equal(bridge.isConnected(), true);
  host.write(JSON.stringify({ type: 'deliver', id: 'd1', platformId: 'owner', kind: 'chat', content: { text: 'hi' } }) + '\n');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lines.some((l) => l.type === 'welcome'));
  assert.ok(lines.some((l) => l.type === 'ack' && l.id === 'd1' && l.ok === true && l.messageId === 'm1'));
  assert.ok(frames.some((f) => f.type === 'connected'));
  assert.ok(bridge.send({ type: 'inbound', id: 'run_1', text: 'x' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(lines.some((l) => l.type === 'inbound' && l.id === 'run_1'));
  host.destroy();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(frames.some((f) => f.type === 'disconnected'));
  await bridge.close();
  assert.equal(fs.existsSync(sock), false);
});

test('the container runtime probe explains absence and stoppage', async () => {
  const missing = (bin, args, opts, cb) => cb(Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }), '', '');
  const r1 = await detect({ exec: missing });
  assert.equal(r1.installed, false);
  assert.match(r1.hint, /Install Docker Desktop/);
  const stopped = (bin, args, opts, cb) => (args[0] === 'version' ? cb(null, '28.0.1\n', '') : cb(new Error('Cannot connect to the Docker daemon'), '', ''));
  const r2 = await detect({ exec: stopped });
  assert.equal(r2.installed, true);
  assert.equal(r2.running, false);
  assert.match(r2.hint, /Start Docker Desktop/);
  const fine = (bin, args, opts, cb) => cb(null, '28.0.1\n', '');
  const r3 = await detect({ exec: fine });
  assert.equal(r3.running, true);
  assert.equal(r3.hint, null);
});

test('schedules translate to tasks and a delivery surface, and back', async () => {
  const calls = [];
  const state = { mgs: [], tasks: [] };
  const ncl = {
    async call(command, args) {
      calls.push([command, args]);
      switch (command) {
        case 'messaging-groups-list': return state.mgs;
        case 'messaging-groups-create': { const m = { id: `mg${state.mgs.length + 1}`, ...args }; state.mgs.push(m); return m; }
        case 'destinations-add': return args;
        case 'tasks-create': { const t = { series_id: 'morning-1a2b', session_id: 'ses-9', name: args.name, prompt: args.prompt, recurrence: args.recurrence, status: 'pending', runs: 2, failed_runs: 1, last_run: '2026-09-02T09:00:00.000Z', next_run: '2026-09-03T09:00:00.000Z' }; state.tasks.push(t); return t; }
        case 'tasks-get': { const t = state.tasks.find((x) => x.series_id === args.id); if (!t) throw new Error('task not found'); return t; }
        case 'tasks-list': return state.tasks;
        case 'tasks-pause': state.tasks[0].status = 'paused'; return {};
        case 'tasks-resume': state.tasks[0].status = 'pending'; return {};
        case 'tasks-update': Object.assign(state.tasks[0], { prompt: args.prompt || state.tasks[0].prompt, recurrence: args.recurrence || state.tasks[0].recurrence }); return {};
        case 'tasks-run': return { series_id: args.id, row_id: 'row-7', status: 'pending' };
        case 'tasks-delete': state.tasks = []; return {};
        case 'destinations-remove': return {};
        case 'messaging-groups-delete': state.mgs = []; return {};
        default: throw new Error(`unexpected ${command}`);
      }
    },
  };
  const store = createScheduleStore({ ncl, agentGroupId: 'ag-1', log: () => {} });
  const s = await store.create({ automationId: 'atm_abc', name: 'morning', cron: '0 9 * * *', timezone: 'UTC', instruction: 'Check HN. automation-atm_abc', deliveryName: 'automation-atm_abc' });
  assert.equal(s.id, 'morning-1a2b');
  assert.equal(s.automationId, 'atm_abc');
  assert.equal(s.runs, 2);
  assert.equal(s.failedRuns, 1);
  assert.equal(s.enabled, true);
  assert.equal(s.nextRunAt, Date.parse('2026-09-03T09:00:00.000Z'));
  assert.deepEqual(s.runtimeRef.seriesId, 'morning-1a2b');
  const created = calls.filter(([c]) => c === 'messaging-groups-create')[0][1];
  assert.equal(created.platform_id, 'automation:atm_abc');
  const dest = calls.find(([c]) => c === 'destinations-add')[1];
  assert.equal(dest.local_name, 'automation-atm_abc');
  assert.equal(dest.target_id, 'mg1');
  const task = calls.find(([c]) => c === 'tasks-create')[1];
  assert.equal(task.group, 'ag-1', 'the task commands take the agent group id');
  assert.equal(task.recurrence, '0 9 * * *');

  const paused = await store.update(s.id, { enabled: false, instruction: 'Check HN carefully. automation-atm_abc' });
  assert.equal(paused.enabled, false);
  assert.equal(paused.instruction, 'Check HN carefully. automation-atm_abc');
  assert.deepEqual(await store.trigger(s.id), { runId: 'row-7', seriesId: 'morning-1a2b' });

  // A fresh store (a new Core life) recovers the automation id from the task itself.
  const again = createScheduleStore({ ncl, agentGroupId: 'ag-1', log: () => {} });
  const listed = await again.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].automationId, 'atm_abc');

  await store.remove(s.id);
  assert.equal((await store.list()).length, 0);
  assert.ok(calls.some(([c]) => c === 'messaging-groups-delete'));
});
