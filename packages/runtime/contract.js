'use strict';
/**
 * The contract test suite. Every FrenRuntime implementation runs it; a
 * runtime is done when it passes.
 *
 * It asserts shapes, ordering and idempotency — never content, because a real
 * agent's words are its own. A factory that wants stricter checks passes
 * `expect` hooks (the mock does: its replies are deterministic).
 *
 * Usage, from an adapter's own test file:
 *
 *   runContractTests({ name: 'mock', createRuntime: () => createMockRuntime(), features: { ask: true } });
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRuntime, isTerminal, newId, EVENTS } = require('./index');

/** Buffer events and wait for one that satisfies a predicate. */
function recorder(rt) {
  const events = [];
  const waiters = [];
  const unsubscribe = rt.subscribe((event) => {
    events.push(event);
    for (const w of [...waiters]) {
      if (w.pred(event)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(event);
      }
    }
  });
  return {
    events,
    unsubscribe,
    waitFor(pred, timeoutMs = 10_000, label = 'event') {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.splice(waiters.findIndex((w) => w.resolve === resolve), 1);
          reject(new Error(`timed out waiting for ${label}; saw ${events.map((e) => e.type).join(', ') || 'nothing'}`));
        }, timeoutMs);
        waiters.push({ pred, resolve: (e) => { clearTimeout(timer); resolve(e); } });
      });
    },
  };
}

function runContractTests({ name, createRuntime, features = {}, timeoutMs = 10_000 }) {
  const t = (title, fn) => test(`[runtime:${name}] ${title}`, { timeout: timeoutMs * 3 }, fn);

  async function withRuntime(fn) {
    const rt = assertRuntime(await createRuntime());
    await rt.start();
    try {
      await fn(rt);
    } finally {
      await rt.stop();
    }
  }

  t('start is idempotent and status becomes ready; stop is idempotent', async () => {
    const rt = assertRuntime(await createRuntime());
    await rt.start();
    await rt.start();
    const status = await rt.getStatus();
    assert.equal(status.state, 'ready');
    await rt.stop();
    await rt.stop();
    assert.equal((await rt.getStatus()).state, 'stopped');
  });

  t('capabilities are complete and typed', async () => {
    await withRuntime((rt) => {
      const caps = rt.getCapabilities();
      assert.equal(typeof caps.tokenStreaming, 'boolean');
      assert.equal(typeof caps.toolEvents, 'boolean');
      assert.ok(['exact', 'inferred'].includes(caps.turnBoundary));
      assert.equal(caps.scheduleTrigger, 'cron');
      assert.ok(caps.maxFiresPerDay === null || typeof caps.maxFiresPerDay === 'number');
      assert.ok(['container', 'vm', 'process', 'none'].includes(caps.isolation));
      assert.equal(typeof caps.files, 'boolean');
    });
  });

  t('every event carries a known type', async () => {
    await withRuntime(async (rt) => {
      const rec = recorder(rt);
      const session = await rt.createSession({ name: 'events' });
      const runId = newId('run');
      await rt.sendMessage({ sessionId: session.id, runId, text: 'hello' });
      await rec.waitFor((e) => e.runId === runId && isTerminal(e.type.replace('run.', '')), timeoutMs, 'run end');
      for (const e of rec.events) assert.ok(EVENTS.includes(e.type), `unknown event ${e.type}`);
      rec.unsubscribe();
    });
  });

  t('sessions are created and listed', async () => {
    await withRuntime(async (rt) => {
      const a = await rt.createSession({ name: 'one', persona: 'You are terse.' });
      const b = await rt.createSession({ name: 'two' });
      assert.equal(typeof a.id, 'string');
      assert.notEqual(a.id, b.id);
      assert.equal(typeof a.createdAt, 'number');
      const list = await rt.listSessions();
      const ids = list.map((s) => s.id);
      assert.ok(ids.includes(a.id) && ids.includes(b.id));
    });
  });

  t('sendMessage: accepted run, then started, message, completed; getRun agrees', async () => {
    await withRuntime(async (rt) => {
      const rec = recorder(rt);
      const session = await rt.createSession({ name: 'chat' });
      const runId = newId('run');
      const accepted = await rt.sendMessage({ sessionId: session.id, runId, text: 'what time is it?' });
      assert.equal(accepted.id, runId);
      assert.equal(accepted.sessionId, session.id);
      assert.equal(accepted.kind, 'chat');
      assert.ok(['queued', 'running'].includes(accepted.status));

      await rec.waitFor((e) => e.type === 'run.started' && e.runId === runId, timeoutMs, 'run.started');
      const msg = await rec.waitFor((e) => e.type === 'agent.message' && e.runId === runId, timeoutMs, 'agent.message');
      assert.equal(typeof msg.message.seq, 'number');
      assert.equal(typeof msg.message.at, 'number');
      assert.equal(typeof msg.message.final, 'boolean');
      const done = await rec.waitFor((e) => e.type === 'run.completed' && e.runId === runId, timeoutMs, 'run.completed');
      assert.equal(done.runId, runId);

      const run = await rt.getRun(runId);
      assert.equal(run.status, 'completed');
      assert.ok(run.messages.length >= 1);
      assert.equal(run.messages[run.messages.length - 1].final, true, 'the last message is final');
      assert.ok(run.endedAt >= run.startedAt);

      // Ordering: started before any message, message before completed.
      const types = rec.events.filter((e) => e.runId === runId).map((e) => e.type);
      assert.ok(types.indexOf('run.started') < types.indexOf('agent.message'));
      assert.ok(types.indexOf('agent.message') < types.indexOf('run.completed'));
      rec.unsubscribe();
    });
  });

  t('sendMessage with the same runId twice does not start a second run', async () => {
    await withRuntime(async (rt) => {
      const session = await rt.createSession({ name: 'dedupe' });
      const runId = newId('run');
      const first = await rt.sendMessage({ sessionId: session.id, runId, text: 'once' });
      const second = await rt.sendMessage({ sessionId: session.id, runId, text: 'once' });
      assert.equal(first.id, second.id);
    });
  });

  t('getRun of an unknown id rejects', async () => {
    await withRuntime(async (rt) => {
      await assert.rejects(() => rt.getRun('run_does_not_exist'));
    });
  });

  t('cancelRun ends a run and is idempotent afterwards', async () => {
    await withRuntime(async (rt) => {
      const rec = recorder(rt);
      const session = await rt.createSession({ name: 'cancel' });
      const runId = newId('run');
      await rt.sendMessage({ sessionId: session.id, runId, text: 'take your time' });
      await rt.cancelRun(runId);
      await rec.waitFor((e) => e.runId === runId && /^run\.(cancelled|completed|failed)$/.test(e.type), timeoutMs, 'run end');
      const run = await rt.getRun(runId);
      assert.ok(isTerminal(run.status));
      await rt.cancelRun(runId); // already over: no throw
      rec.unsubscribe();
    });
  });

  t('runAgent runs without a session and completes', async () => {
    await withRuntime(async (rt) => {
      const rec = recorder(rt);
      const runId = newId('run');
      const run = await rt.runAgent({ runId, instruction: 'say hi' });
      assert.equal(run.kind, 'agent');
      await rec.waitFor((e) => e.runId === runId && /^run\.(completed|failed)$/.test(e.type), timeoutMs, 'run end');
      rec.unsubscribe();
    });
  });

  t('schedules: create, list, update, trigger, delete', async () => {
    await withRuntime(async (rt) => {
      const rec = recorder(rt);
      const input = {
        automationId: newId('atm'), name: 'morning check', cron: '0 9 * * *', timezone: 'UTC',
        instruction: 'Report the news.', deliveryName: 'fren',
      };
      const created = await rt.createSchedule(input);
      assert.equal(typeof created.id, 'string');
      assert.equal(created.automationId, input.automationId);
      assert.equal(created.enabled, true);
      assert.equal(created.runs, 0);

      const listed = await rt.listSchedules();
      assert.ok(listed.some((s) => s.id === created.id));

      const paused = await rt.updateSchedule(created.id, { enabled: false });
      assert.equal(paused.enabled, false);
      const resumed = await rt.updateSchedule(created.id, { enabled: true, instruction: 'Report the AI news.' });
      assert.equal(resumed.enabled, true);
      assert.equal(resumed.instruction, 'Report the AI news.');

      const run = await rt.triggerSchedule(created.id);
      assert.equal(run.kind, 'schedule');
      await rec.waitFor((e) => e.type === 'schedule.fired' && e.scheduleId === created.id, timeoutMs, 'schedule.fired');
      const msg = await rec.waitFor((e) => e.type === 'agent.message' && e.automationId === input.automationId, timeoutMs, 'agent.message');
      assert.equal(msg.automationId, input.automationId);
      await rec.waitFor((e) => /^schedule\.(completed|failed)$/.test(e.type) && e.scheduleId === created.id, timeoutMs, 'schedule end');
      const after = (await rt.listSchedules()).find((s) => s.id === created.id);
      assert.ok(after.runs >= 1);

      await rt.deleteSchedule(created.id);
      assert.ok(!(await rt.listSchedules()).some((s) => s.id === created.id));
      await rt.deleteSchedule(created.id); // idempotent
      rec.unsubscribe();
    });
  });

  t('createSchedule rejects a malformed cron', async () => {
    await withRuntime(async (rt) => {
      await assert.rejects(() => rt.createSchedule({
        automationId: newId('atm'), name: 'bad', cron: 'every morning', timezone: 'UTC',
        instruction: 'x', deliveryName: 'fren',
      }));
    });
  });

  t('subscribe returns an unsubscribe that stops delivery', async () => {
    await withRuntime(async (rt) => {
      let seen = 0;
      const off = rt.subscribe(() => { seen += 1; });
      off();
      const session = await rt.createSession({ name: 'quiet' });
      const rec = recorder(rt);
      const runId = newId('run');
      await rt.sendMessage({ sessionId: session.id, runId, text: 'hi' });
      await rec.waitFor((e) => e.type === 'run.completed' && e.runId === runId, timeoutMs, 'run.completed');
      assert.equal(seen, 0);
      rec.unsubscribe();
    });
  });

  if (features.ask) {
    t('a permission request pauses the run until resolved; approve completes it', async () => {
      await withRuntime(async (rt) => {
        const rec = recorder(rt);
        const session = await rt.createSession({ name: 'ask' });
        const runId = newId('run');
        await rt.sendMessage({ sessionId: session.id, runId, text: features.ask.trigger || '[ask] delete everything' });
        const req = await rec.waitFor((e) => e.type === 'permission.request', timeoutMs, 'permission.request');
        assert.equal(typeof req.request.id, 'string');
        assert.equal(typeof req.request.action, 'string');
        assert.ok(Array.isArray(req.request.options));
        assert.ok(!rec.events.some((e) => e.type === 'run.completed' && e.runId === runId), 'not done while asking');
        await rt.resolvePermission(req.request.id, 'approve');
        await rec.waitFor((e) => e.type === 'run.completed' && e.runId === runId, timeoutMs, 'run.completed');
        await rt.resolvePermission(req.request.id, 'approve'); // late answer: ignored, no throw
        rec.unsubscribe();
      });
    });

    t('a denied permission still ends the run', async () => {
      await withRuntime(async (rt) => {
        const rec = recorder(rt);
        const session = await rt.createSession({ name: 'deny' });
        const runId = newId('run');
        await rt.sendMessage({ sessionId: session.id, runId, text: features.ask.trigger || '[ask] delete everything' });
        const req = await rec.waitFor((e) => e.type === 'permission.request', timeoutMs, 'permission.request');
        await rt.resolvePermission(req.request.id, 'deny', 'not today');
        await rec.waitFor((e) => e.runId === runId && /^run\.(completed|failed)$/.test(e.type), timeoutMs, 'run end');
        rec.unsubscribe();
      });
    });
  }
}

module.exports = { runContractTests, recorder };
