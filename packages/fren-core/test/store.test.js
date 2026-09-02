'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openCoreStore, MIGRATIONS } = require('../store');

function tempDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fren-core-')), 'core.db');
}

test('migrations apply once and reopening is a no-op', () => {
  const file = tempDb();
  const a = openCoreStore(file);
  assert.equal(a.version(), MIGRATIONS.length);
  a.close();
  const b = openCoreStore(file);
  assert.equal(b.version(), MIGRATIONS.length);
  b.close();
});

test('runs, messages, open runs, prune', () => {
  const store = openCoreStore(tempDb());
  store.upsertSession({ id: 'ses_1', name: 'main', createdAt: 1 });
  store.insertRun({ id: 'run_a', sessionId: 'ses_1', kind: 'chat', input: { text: 'hi' }, startedAt: 1000 });
  store.addRunMessage('run_a', { seq: 1, at: 1001, text: 'hello', final: false });
  store.addRunMessage('run_a', { seq: 2, at: 1002, text: 'bye', final: true, files: ['a.txt'] });
  store.addRunMessage('run_a', { seq: 2, at: 1003, text: 'dupe', final: true }); // ignored: same seq
  const run = store.getRun('run_a');
  assert.equal(run.status, 'queued');
  assert.deepEqual(run.input, { text: 'hi' });
  assert.equal(run.messages.length, 2);
  assert.deepEqual(run.messages[1].files, ['a.txt']);
  assert.equal(run.messages[1].text, 'bye');
  assert.equal(store.openRuns().length, 1);
  store.updateRun('run_a', { status: 'completed', endedAt: 2000 });
  assert.equal(store.openRuns().length, 0);
  assert.equal(store.listRuns({ sessionId: 'ses_1' }).length, 1);
  assert.equal(store.getRun('run_zzz'), null);
  const pruned = store.prune({ beforeMs: 5000 });
  assert.equal(pruned.runs, 1);
  assert.equal(store.getRun('run_a'), null);
  store.close();
});

test('sessions by name and runtime ref', () => {
  const store = openCoreStore(tempDb());
  store.upsertSession({ id: 'ses_1', name: 'main', createdAt: 1 });
  assert.equal(store.getSessionByName('main').id, 'ses_1');
  store.upsertSession({ id: 'ses_1', name: 'main', createdAt: 1, runtimeRef: { kind: 'mock', id: 'x' } });
  assert.deepEqual(store.getSession('ses_1').runtimeRef, { kind: 'mock', id: 'x' });
  assert.equal(store.listSessions().length, 1);
  store.close();
});

test('automations and their runs', () => {
  const store = openCoreStore(tempDb());
  store.insertAutomation({
    id: 'atm_1', name: 'morning', trigger: { type: 'schedule', cron: '0 9 * * *', timezone: 'UTC' },
    body: { kind: 'agent', instruction: 'check hn' }, permissions: ['network.request'], createdAt: 10, nextRunAt: 99,
  });
  let a = store.getAutomation('atm_1');
  assert.equal(a.enabled, true);
  assert.equal(a.revision, 1);
  assert.deepEqual(a.permissions, ['network.request']);
  assert.equal(a.trigger.cron, '0 9 * * *');
  store.updateAutomation('atm_1', { enabled: false, updatedAt: 20, bumpRevision: true, runtimeRef: { id: 'sch_1' } });
  a = store.getAutomation('atm_1');
  assert.equal(a.enabled, false);
  assert.equal(a.revision, 2);
  assert.deepEqual(a.runtimeRef, { id: 'sch_1' });
  store.insertAutomationRun({ id: 'ar_1', automationId: 'atm_1', trigger: 'manual', startedAt: 30, runId: 'run_x' });
  store.updateAutomationRun('ar_1', { status: 'ok', endedAt: 40, output: 'x'.repeat(9000), delivered: true });
  const r = store.getAutomationRunByRunId('run_x');
  assert.equal(r.status, 'ok');
  assert.equal(r.output.length, 8000, 'output is capped');
  assert.equal(r.delivered, true);
  assert.equal(store.getAutomation('atm_1').lastRunAt, 30);
  assert.equal(store.listAutomationRuns('atm_1').length, 1);
  store.deleteAutomation('atm_1');
  assert.equal(store.getAutomation('atm_1'), null);
  assert.equal(store.listAutomationRuns('atm_1').length, 0);
  store.close();
});

test('permission requests resolve once', () => {
  const store = openCoreStore(tempDb());
  store.insertPermissionRequest({
    id: 'perm_1', scope: 'shell.execute', source: 'runtime', subject: { runId: 'run_1' },
    detail: { title: 't', question: 'q', options: ['approve', 'deny'] }, runtimeRequestId: 'rq', createdAt: 1, expiresAt: 100,
  });
  assert.equal(store.listPermissionRequests({ status: 'open' }).length, 1);
  store.resolvePermissionRequest('perm_1', { status: 'approved', decision: 'approve', resolvedAt: 2 });
  store.resolvePermissionRequest('perm_1', { status: 'denied', decision: 'deny', resolvedAt: 3 });
  const r = store.getPermissionRequest('perm_1');
  assert.equal(r.status, 'approved', 'the first answer wins');
  assert.equal(r.runtimeRequestId, 'rq');
  store.close();
});

test('events are ordered and resumable', () => {
  const store = openCoreStore(tempDb());
  const a = store.appendEvent('run.started', { runId: 'r1' }, 1);
  const b = store.appendEvent('agent.message', { runId: 'r1', message: { seq: 1 } }, 2);
  assert.ok(b > a);
  assert.equal(store.lastEventId(), b);
  const since = store.eventsSince(a);
  assert.equal(since.length, 1);
  assert.equal(since[0].type, 'agent.message');
  assert.equal(since[0].runId, 'r1');
  assert.deepEqual(since[0].message, { seq: 1 });
  store.close();
});
