'use strict';
/**
 * Schedules, as the runtime host keeps them.
 *
 * A FREN schedule becomes: a messaging group `automation:<id>` (where the
 * result is sent, so a delivery's platform id names the automation), a
 * destination the agent group may send to, and a scheduled task with the
 * compiled instruction. The task id is the handle; everything else is
 * derived from the automation id and re-created if missing. The host's task
 * commands take the agent group's id (not its folder), so the store carries it.
 *
 * The host's task list is the source of truth for runs, failures and the
 * next fire; this module only translates.
 */
const { CHANNEL } = require('./bootstrap');

const platformIdFor = (automationId) => `automation:${automationId}`;
const deliveryNameFor = (automationId) => `automation-${automationId}`;

function toSchedule(task, ref) {
  const paused = task.status === 'paused';
  return {
    id: task.series_id || task.id,
    automationId: ref.automationId,
    name: task.name || ref.name || task.series_id,
    cron: task.recurrence || ref.cron,
    timezone: ref.timezone,
    instruction: task.prompt || ref.instruction,
    deliveryName: deliveryNameFor(ref.automationId),
    enabled: !paused,
    runs: Number(task.runs || 0),
    failedRuns: Number(task.failed_runs || 0),
    lastRunAt: task.last_run ? Date.parse(task.last_run) || undefined : undefined,
    nextRunAt: task.next_run ? Date.parse(task.next_run) || undefined : (task.process_after ? Date.parse(task.process_after) || undefined : undefined),
    pausedByRuntime: paused && task.paused_reason ? String(task.paused_reason) : undefined,
    runtimeRef: { ...ref, seriesId: task.series_id || task.id, sessionId: task.session_id || ref.sessionId },
  };
}

function createScheduleStore({ ncl, agentGroupId, log = () => {} }) {
  const refs = new Map(); // seriesId -> ref (what the host does not keep: automation id, timezone)

  async function ensureSurface(automationId) {
    const platformId = platformIdFor(automationId);
    const list = await ncl.call('messaging-groups-list', {});
    const mgs = Array.isArray(list) ? list : (list && list.items) || [];
    let mg = mgs.find((m) => m.channel_type === CHANNEL && m.platform_id === platformId);
    if (!mg) {
      try {
        await ncl.call('messaging-groups-create', { channel_type: CHANNEL, platform_id: platformId, instance: CHANNEL, name: deliveryNameFor(automationId), is_group: 0, unknown_sender_policy: 'public' });
      } catch (err) {
        if (!/exist|already/i.test(err.message)) throw err;
      }
      const again = await ncl.call('messaging-groups-list', {});
      mg = (Array.isArray(again) ? again : (again && again.items) || []).find((m) => m.channel_type === CHANNEL && m.platform_id === platformId);
    }
    if (!mg) throw new Error(`could not create the delivery surface for ${automationId}`);
    try {
      await ncl.call('destinations-add', { agent_group_id: agentGroupId, local_name: deliveryNameFor(automationId), target_type: 'channel', target_id: mg.id });
    } catch (err) {
      if (!/exist|already/i.test(err.message)) throw err;
    }
    return mg;
  }

  async function removeSurface(automationId) {
    try { await ncl.call('destinations-remove', { agent_group_id: agentGroupId, local_name: deliveryNameFor(automationId) }); } catch (err) { log(`[runtime] destination not removed: ${err.message}`); }
    try {
      const list = await ncl.call('messaging-groups-list', {});
      const mg = (Array.isArray(list) ? list : (list && list.items) || []).find((m) => m.channel_type === CHANNEL && m.platform_id === platformIdFor(automationId));
      if (mg) await ncl.call('messaging-groups-delete', { id: mg.id });
    } catch (err) {
      log(`[runtime] surface not removed: ${err.message}`);
    }
  }

  async function create(input) {
    await ensureSurface(input.automationId);
    const task = await ncl.call('tasks-create', {
      group: agentGroupId,
      name: input.name,
      prompt: input.instruction,
      recurrence: input.cron,
      ...(input.overrideFireLimit ? { dangerously_override_recurrence_limit: true } : {}),
    });
    const seriesId = task.series_id || task.id;
    const ref = { automationId: input.automationId, name: input.name, cron: input.cron, timezone: input.timezone, instruction: input.instruction, sessionId: task.session_id };
    refs.set(seriesId, ref);
    if (input.enabled === false) await ncl.call('tasks-pause', { id: seriesId });
    const fresh = await get(seriesId);
    return fresh || toSchedule({ ...task, series_id: seriesId, status: input.enabled === false ? 'paused' : 'pending' }, ref);
  }

  async function get(seriesId) {
    const ref = refs.get(seriesId);
    if (!ref) return null;
    try {
      const task = await ncl.call('tasks-get', { id: seriesId, group: agentGroupId });
      return toSchedule(task, ref);
    } catch (err) {
      if (/not found/i.test(err.message)) return null;
      throw err;
    }
  }

  async function update(seriesId, patch) {
    const ref = refs.get(seriesId);
    if (!ref) throw new Error(`unknown schedule ${seriesId}`);
    const fields = {};
    if (patch.instruction !== undefined) { fields.prompt = patch.instruction; ref.instruction = patch.instruction; }
    if (patch.cron !== undefined) { fields.recurrence = patch.cron; ref.cron = patch.cron; }
    if (patch.name !== undefined) ref.name = patch.name;
    if (patch.timezone !== undefined) ref.timezone = patch.timezone;
    if (Object.keys(fields).length) await ncl.call('tasks-update', { id: seriesId, group: agentGroupId, ...fields });
    if (patch.enabled === false) await ncl.call('tasks-pause', { id: seriesId, group: agentGroupId });
    if (patch.enabled === true) await ncl.call('tasks-resume', { id: seriesId, group: agentGroupId });
    return (await get(seriesId)) || toSchedule({ series_id: seriesId, status: patch.enabled === false ? 'paused' : 'pending' }, ref);
  }

  /** The host refuses to delete a task whose container is running: cancel now, delete when it is done. */
  async function remove(seriesId) {
    const ref = refs.get(seriesId);
    try {
      await ncl.call('tasks-delete', { id: seriesId, group: agentGroupId });
    } catch (err) {
      if (/running/i.test(err.message)) {
        await ncl.call('tasks-cancel', { id: seriesId, group: agentGroupId }).catch((e) => log(`[runtime] task cancel: ${e.message}`));
        deferDelete(seriesId, ref);
      } else if (!/not found/i.test(err.message)) {
        throw err;
      }
    }
    if (ref) await removeSurface(ref.automationId);
    refs.delete(seriesId);
  }

  function deferDelete(seriesId, ref, attempt = 0) {
    if (attempt >= 12) { log(`[runtime] task ${seriesId} still running after a minute; left cancelled`); return; }
    const timer = setTimeout(async () => {
      try {
        await ncl.call('tasks-delete', { id: seriesId, group: agentGroupId });
      } catch (err) {
        if (/running/i.test(err.message)) return deferDelete(seriesId, ref, attempt + 1);
        if (!/not found/i.test(err.message)) log(`[runtime] deferred task delete: ${err.message}`);
      }
    }, 5000);
    if (timer.unref) timer.unref();
  }

  async function list() {
    const rows = await ncl.call('tasks-list', { group: agentGroupId });
    const tasks = Array.isArray(rows) ? rows : (rows && rows.items) || [];
    const out = [];
    for (const task of tasks) {
      const seriesId = task.series_id || task.id;
      const ref = refs.get(seriesId) || refFromTask(task);
      if (!ref) continue;
      refs.set(seriesId, ref);
      out.push(toSchedule(task, ref));
    }
    return out;
  }

  /** A task this Core life never created: the automation id is in the delivery surface name, if FREN made it. */
  function refFromTask(task) {
    const m = /^FREN's automation "(.+?)"|automation-(atm_[0-9a-f]+)/.exec(String(task.prompt || ''));
    const id = m && m[2];
    if (!id) return null;
    return { automationId: id, name: task.name || id, cron: task.recurrence || '', timezone: '', instruction: task.prompt || '', sessionId: task.session_id };
  }

  async function trigger(seriesId) {
    const fired = await ncl.call('tasks-run', { id: seriesId, group: agentGroupId });
    return { runId: fired.row_id || fired.id, seriesId: fired.series_id || seriesId };
  }

  return { create, get, update, remove, list, trigger, refs, platformIdFor, deliveryNameFor };
}

module.exports = { createScheduleStore, platformIdFor, deliveryNameFor, toSchedule };
