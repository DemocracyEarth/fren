'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { createNclClient } = require('../ncl-client');
const { createBridge } = require('../bridge');
const { detect, resolveDocker, pathWithDocker } = require('../container-runtime');
const { createScheduleStore, refFromPrompt, pauseNote } = require('../schedules');
const { observe, remember, release, ABSORB_MS } = require('../schedule-watch');

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

test('the docker binary is found on PATH or where the app keeps it', () => {
  const app = '/Applications/Docker.app/Contents/Resources/bin';
  const exists = (p) => p === `${app}/docker`;
  const found = resolveDocker({ env: { PATH: '/usr/bin:/bin' }, platform: 'darwin', exists });
  assert.equal(found.bin, `${app}/docker`);
  assert.equal(found.onPath, false);
  assert.equal(resolveDocker({ env: { PATH: '/usr/bin' }, platform: 'darwin', exists: () => false }), null);
  const onPath = resolveDocker({ env: { PATH: '/opt/homebrew/bin:/usr/bin' }, platform: 'darwin', exists: (p) => p === '/opt/homebrew/bin/docker' });
  assert.equal(onPath.onPath, true);
  const brew = (p) => p === '/opt/homebrew/bin/docker';
  assert.equal(pathWithDocker({ PATH: '/opt/homebrew/bin:/usr/bin' }, { platform: 'darwin', exists: brew }), '/opt/homebrew/bin:/usr/bin', 'already on PATH: unchanged');
  assert.equal(pathWithDocker({ PATH: '/usr/bin' }, { platform: 'darwin', exists }), `${app}:/usr/bin`, 'found in the app: prepended');
});

test('the container runtime probe explains absence and stoppage', async () => {
  const missing = (bin, args, opts, cb) => cb(Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }), '', '');
  const nowhere = () => false;
  const r0 = await detect({ exec: missing, exists: nowhere, env: { PATH: '/usr/bin' }, platform: 'darwin' });
  assert.equal(r0.installed, false);
  assert.match(r0.hint, /Install Docker Desktop/);
  const somewhere = (p) => p === '/usr/local/bin/docker';
  const r1 = await detect({ exec: missing, exists: somewhere, env: { PATH: '/usr/local/bin' }, platform: 'darwin' });
  assert.equal(r1.installed, false);
  assert.match(r1.hint, /Install Docker Desktop/);
  const stopped = (bin, args, opts, cb) => (args[0] === 'version' ? cb(null, '28.0.1\n', '') : cb(new Error('Cannot connect to the Docker daemon'), '', ''));
  const r2 = await detect({ exec: stopped, exists: somewhere, env: { PATH: '/usr/local/bin' }, platform: 'darwin' });
  assert.equal(r2.installed, true);
  assert.equal(r2.running, false);
  assert.match(r2.hint, /Start Docker Desktop/);
  const fine = (bin, args, opts, cb) => cb(null, '28.0.1\n', '');
  const r3 = await detect({ exec: fine, exists: somewhere, env: { PATH: '/usr/local/bin' }, platform: 'darwin' });
  assert.equal(r3.running, true);
  assert.equal(r3.hint, null);
  assert.equal(r3.bin, '/usr/local/bin/docker');
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
  assert.deepEqual(await store.trigger(s.id), { rowId: 'row-7', seriesId: 'morning-1a2b' });

  // A fresh store (a new Core life) recovers the automation id from the task itself.
  const again = createScheduleStore({ ncl, agentGroupId: 'ag-1', log: () => {} });
  const listed = await again.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].automationId, 'atm_abc');

  await store.remove(s.id);
  assert.equal((await store.list()).length, 0);
  assert.ok(calls.some(([c]) => c === 'messaging-groups-delete'));
});

test('a task is recognised as FREN\'s by the prompt it was given, and its run log reads as sentences', () => {
  const prompt = 'You are running FREN\'s automation "morning AI news" on behalf of its owner.\n\nInstruction:\nCheck HN.\n\nDelivery contract: send_message to the destination named "automation-atm_00cdc1155e19b679".';
  const ref = refFromPrompt(prompt, { recurrence: '0 9 * * *', status: 'paused', session_id: 'ses-1' });
  assert.equal(ref.automationId, 'atm_00cdc1155e19b679');
  assert.equal(ref.name, 'morning AI news');
  assert.equal(ref.cron, '0 9 * * *');
  assert.equal(ref.enabled, false);
  assert.equal(ref.instruction, prompt);
  assert.equal(refFromPrompt('Water the plants.', {}), null);
  // The host's run log lines: a local stamp, an em dash, the note.
  const note = '2026-09-05 09:00 — auto-paused after 8 consecutive script failures (host); fix the script, then `ncl tasks resume x`';
  assert.equal(pauseNote(['2026-09-04 09:00 — Sent the five stories.', note]), 'it failed 8 times in a row');
  assert.equal(pauseNote(['2026-09-04 09:00 — Sent the five stories.']), null);
  assert.equal(pauseNote([]), null);
});

test('the schedule watch reads fires, ends, misses and pauses off the task list', () => {
  const last = new Map();
  const S = (over = {}) => ({ id: 'morning-1', enabled: true, runs: 2, failedRuns: 0, nextRunAt: 1000, runtimeRef: { rowId: 'row-a' }, ...over });
  assert.deepEqual(observe(last, [S()], 500), [], 'a first reading is a baseline, history and all');
  assert.deepEqual(observe(last, [S()], 1000), [{ kind: 'fired', seriesId: 'morning-1', rowId: 'row-a' }], 'the row came due');
  assert.deepEqual(observe(last, [S()], 1500), [], 'still due, still the same fire');
  assert.deepEqual(
    observe(last, [S({ runs: 3, nextRunAt: 90000, runtimeRef: { rowId: 'row-b' } })], 2000),
    [{ kind: 'settled', seriesId: 'morning-1', rowId: 'row-a', ok: true }],
    'the counter moved while the fired run was open: it ended out of sight',
  );
  assert.deepEqual(
    observe(last, [S({ runs: 3, failedRuns: 1, nextRunAt: 180000, runtimeRef: { rowId: 'row-c' } })], 3000),
    [{ kind: 'missed', seriesId: 'morning-1', ok: false }],
    'a counter moving with no run open is a fire nobody saw',
  );
  const paused = S({ enabled: false, runs: 3, failedRuns: 1, nextRunAt: 180000, runtimeRef: { rowId: 'row-c' }, pausedByRuntime: 'it failed 8 times in a row' });
  assert.deepEqual(observe(last, [paused], 4000), [{ kind: 'paused', seriesId: 'morning-1', detail: 'it failed 8 times in a row' }]);
  assert.deepEqual(observe(last, [paused], 5000), [], 'said once');
  assert.deepEqual(observe(last, [S({ enabled: false, runs: 3, failedRuns: 1, nextRunAt: 180000, runtimeRef: { rowId: 'row-c' } })], 6000), []);
  assert.deepEqual(observe(last, [S({ id: 'own-1', enabled: false, nextRunAt: 180000, runtimeRef: { rowId: 'row-o' } })], 6500), [], 'paused without the host\'s note is FREN\'s own pause, never news');
  // A series missing from one reading (between acknowledgement and re-arm) keeps its state.
  const gap = S({ id: 'gap-1', runs: 0, nextRunAt: 7000, runtimeRef: { rowId: 'row-g' } });
  observe(last, [gap], 6900);
  assert.deepEqual(observe(last, [gap], 7000), [{ kind: 'fired', seriesId: 'gap-1', rowId: 'row-g' }]);
  assert.deepEqual(observe(last, [], 7100), []);
  assert.deepEqual(observe(last, [S({ id: 'gap-1', runs: 1, nextRunAt: 99000, runtimeRef: { rowId: 'row-h' } })], 7200), [{ kind: 'settled', seriesId: 'gap-1', rowId: 'row-g', ok: true }]);
});

test('an end the counters already explained is not remembered again; a let-go row fires again only as a new attempt', () => {
  const last = new Map();
  const S = (over = {}) => ({ id: 'm-1', enabled: true, runs: 0, failedRuns: 0, nextRunAt: 1000, runtimeRef: { rowId: 'row-a' }, ...over });
  observe(last, [S()], 500);
  observe(last, [S()], 1000); // fired
  assert.equal(observe(last, [S({ runs: 1, nextRunAt: 90000, runtimeRef: { rowId: 'row-b' } })], 2000)[0].kind, 'settled');
  remember(last, 'm-1', 'row-a', true, 2100); // the adapter closing that run must not plant a second explanation
  assert.deepEqual(
    observe(last, [S({ runs: 2, nextRunAt: 90000, runtimeRef: { rowId: 'row-b' } })], 2500),
    [{ kind: 'missed', seriesId: 'm-1', ok: true }],
    'the next unexplained move is reported',
  );
  // FREN lets go of a fired run (a cancel, a stop): the row as it stands is not fired again.
  observe(last, [S({ runs: 2, nextRunAt: 90000, runtimeRef: { rowId: 'row-b' } })], 90000); // fired row-b
  release(last, 'm-1', 'row-b');
  assert.deepEqual(observe(last, [S({ runs: 2, nextRunAt: 90000, runtimeRef: { rowId: 'row-b' } })], 90100), [], 'still due, still let go of');
  assert.deepEqual(
    observe(last, [S({ runs: 3, nextRunAt: 180000, runtimeRef: { rowId: 'row-c' } })], 91000),
    [{ kind: 'missed', seriesId: 'm-1', ok: true }],
    'what the host did with it is still reported, not absorbed',
  );
  // The host gives the same row a later time (a retry): a new attempt, fired again when due.
  observe(last, [S({ runs: 3, nextRunAt: 180000, runtimeRef: { rowId: 'row-c' } })], 180000); // fired row-c
  release(last, 'm-1', 'row-c');
  assert.deepEqual(observe(last, [S({ runs: 3, nextRunAt: 180500, runtimeRef: { rowId: 'row-c' } })], 180100), [], 'moved into the future: not due');
  assert.deepEqual(observe(last, [S({ runs: 3, nextRunAt: 180500, runtimeRef: { rowId: 'row-c' } })], 180500), [{ kind: 'fired', seriesId: 'm-1', rowId: 'row-c' }]);
});

test('an end FREN watched explains the next counter move, so one fire is one record', () => {
  const last = new Map();
  const S = (over = {}) => ({ id: 'morning-1', enabled: true, runs: 2, failedRuns: 0, nextRunAt: 1000, runtimeRef: { rowId: 'row-a' }, ...over });
  observe(last, [S()], 500);
  assert.equal(observe(last, [S()], 1000).length, 1, 'fired');
  remember(last, 'morning-1', 'row-a', true, 1200); // the acknowledgement arrived; FREN closed the run
  assert.deepEqual(observe(last, [S()], 1300), [], 'the same due row is not fired again while the host catches up');
  assert.deepEqual(observe(last, [S({ runs: 3, nextRunAt: 90000, runtimeRef: { rowId: 'row-b' } })], 2000), [], 'the counter move is spoken for');
  assert.deepEqual(
    observe(last, [S({ runs: 4, nextRunAt: 90000, runtimeRef: { rowId: 'row-b' } })], 2500),
    [{ kind: 'missed', seriesId: 'morning-1', ok: true }],
    'a second move is a real fire',
  );
  // Two run-nows end before the host applies either: both explained, like for like.
  remember(last, 'morning-1', 'row-x', true, 3000);
  remember(last, 'morning-1', 'row-y', false, 3100);
  assert.deepEqual(observe(last, [S({ runs: 5, failedRuns: 1, nextRunAt: 90000, runtimeRef: { rowId: 'row-b' } })], 3500), []);
  // An end remembered before any reading exists is still remembered, for a while.
  const fresh = new Map();
  const later = ABSORB_MS * 10;
  remember(fresh, 'x-1', 'row-z', false, 10);
  assert.deepEqual(observe(fresh, [S({ id: 'x-1', failedRuns: 1, nextRunAt: later, runtimeRef: { rowId: 'row-q' } })], 20), []);
  assert.deepEqual(observe(fresh, [S({ id: 'x-1', failedRuns: 2, nextRunAt: later, runtimeRef: { rowId: 'row-q' } })], 30), [], 'explained by the remembered end');
  assert.deepEqual(
    observe(fresh, [S({ id: 'x-1', failedRuns: 3, nextRunAt: later, runtimeRef: { rowId: 'row-q' } })], ABSORB_MS + 100),
    [{ kind: 'missed', seriesId: 'x-1', ok: false }],
    'nothing is explained by an end older than the absorb window',
  );
});

const { createSupervisor } = require('../supervisor');
const { spawn } = require('node:child_process');
const { once: onceEvent } = require('node:events');

test('the supervisor rotates the runtime log as the host writes, keeping three files', async () => {
  const dir = fs.mkdtempSync('/tmp/frn-sup-');
  const script = "for (let i = 0; i < 300; i++) console.log('line ' + i + ' ' + 'x'.repeat(40)); console.error('done');";
  const sup = createSupervisor({ runtimeDir: dir, env: process.env, logDir: path.join(dir, 'logs'), log: () => {}, args: ['-e', script], logMaxBytes: 4000 });
  const exited = new Promise((r) => sup.onExit(r));
  sup.start();
  await exited;
  const files = fs.readdirSync(path.join(dir, 'logs')).filter((f) => f.startsWith('runtime.log')).sort();
  assert.ok(files.includes('runtime.log') && files.includes('runtime.log.1'), `rotated: ${files.join(', ')}`);
  assert.ok(files.length <= 4, 'at most the live file and three kept');
  const lines = files.flatMap((f) => fs.readFileSync(path.join(dir, 'logs', f), 'utf8').split('\n')).filter((l) => l.startsWith('line '));
  assert.ok(lines.length >= 250, `the tail of the output survived rotation (${lines.length} lines kept)`);
  assert.ok(!fs.existsSync(sup.pidFile), 'the pid file goes with the host');
});

test('the supervisor stops a host an earlier life left running before starting its own', async () => {
  const dir = fs.mkdtempSync('/tmp/frn-sup-');
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const idle = path.join(dir, 'idle-host.js');
  fs.writeFileSync(idle, "setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0));");
  const orphan = spawn(process.execPath, [idle], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  // What the earlier life wrote down: its host's pid and what that host was running.
  fs.writeFileSync(path.join(logDir, 'runtime-host.pid'), JSON.stringify({ pid: orphan.pid, marker: idle }));
  const orphanGone = onceEvent(orphan, 'exit');

  const sup = createSupervisor({ runtimeDir: dir, env: process.env, logDir, log: () => {}, args: ['-e', '0'] });
  const exited = new Promise((r) => sup.onExit(r));
  sup.start();
  await orphanGone;
  await exited;
  let stillThere = true;
  try { process.kill(orphan.pid, 0); } catch { stillThere = false; }
  assert.equal(stillThere, false, 'the earlier host was stopped');
  assert.ok(!fs.existsSync(sup.pidFile));
});

test('the supervisor leaves a process alone when the pid was reused by something else', async () => {
  const dir = fs.mkdtempSync('/tmp/frn-sup-');
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const other = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0));"], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(logDir, 'runtime-host.pid'), JSON.stringify({ pid: other.pid, marker: '/nowhere/dist/index.js' }));
  const sup = createSupervisor({ runtimeDir: dir, env: process.env, logDir, log: () => {}, args: ['-e', '0'] });
  const exited = new Promise((r) => sup.onExit(r));
  sup.start();
  await exited;
  let alive = true;
  try { process.kill(other.pid, 0); } catch { alive = false; }
  assert.equal(alive, true, 'not ours, not touched');
  other.kill('SIGTERM');
  await onceEvent(other, 'exit');
});
