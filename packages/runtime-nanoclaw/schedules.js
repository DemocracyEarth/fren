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
 * next fire; this module only translates. What the host does not keep (the
 * automation id, the timezone, whether FREN itself paused the series) lives
 * in `refs` for this Core life, and is recovered from the task's own prompt
 * for the next one: the list shortens prompts, so recovery reads the whole
 * task.
 */
const { CHANNEL } = require('./bootstrap');

const platformIdFor = (automationId) => `automation:${automationId}`;
const deliveryNameFor = (automationId) => `automation-${automationId}`;
const DEFAULT_FAILURE = 'the run failed in the secure execution environment';

function toSchedule(task, ref, extra = {}) {
  const paused = task.status === 'paused';
  return {
    id: task.series_id || task.id,
    automationId: ref.automationId,
    name: task.name || ref.name || task.series_id,
    cron: task.recurrence || ref.cron,
    timezone: ref.timezone,
    instruction: ref.instruction || task.prompt,
    deliveryName: deliveryNameFor(ref.automationId),
    enabled: !paused,
    runs: Number(task.runs || 0),
    failedRuns: Number(task.failed_runs || 0),
    lastRunAt: task.last_run ? Date.parse(task.last_run) || undefined : undefined,
    nextRunAt: task.next_run ? Date.parse(task.next_run) || undefined : (task.process_after ? Date.parse(task.process_after) || undefined : undefined),
    pausedByRuntime: paused && extra.pausedByRuntime ? String(extra.pausedByRuntime) : undefined,
    runtimeRef: { ...ref, seriesId: task.series_id || task.id, rowId: task.row_id || task.id || undefined, sessionId: task.session_id || ref.sessionId },
  };
}

/** The automation behind a task, from the prompt FREN compiled for it. */
function refFromPrompt(prompt, task) {
  const text = String(prompt || '');
  const id = (/automation-(atm_[0-9a-f]+)/.exec(text) || [])[1];
  if (!id) return null;
  const name = (/FREN's automation "(.+?)"/.exec(text) || [])[1];
  return { automationId: id, name: task.name || name || id, cron: task.recurrence || '', timezone: '', instruction: text, sessionId: task.session_id, enabled: task.status !== 'paused' };
}

/** The host's note when it gives up on a series, as a sentence for a person. */
function pauseNote(lines) {
  for (const line of [...(lines || [])].reverse()) {
    const m = /auto-paused after (\d+) consecutive/.exec(String(line));
    if (m) return `it failed ${m[1]} times in a row`;
  }
  return null;
}

/** The last thing the run log says that is not the host's pause note. */
function failureNote(lines) {
  for (const line of [...(lines || [])].reverse()) {
    const text = String(line).replace(/\s+/g, ' ').trim();
    if (!text || /auto-paused after \d+ consecutive/.test(text)) continue;
    return text.replace(/^\[?\d{4}-\d{2}-\d{2}[ T][\d:.+Z-]+\]?\s*[-–:]?\s*/, '').slice(0, 200) || null;
  }
  return null;
}

function createScheduleStore({ ncl, agentGroupId, log = () => {} }) {
  const refs = new Map();    // seriesId -> ref
  const foreign = new Set(); // series on the host that are not FREN's
  const pauseNotes = new Map(); // seriesId -> { rowId, detail }

  const logLines = (task) => (Array.isArray(task.recent_log) ? task.recent_log : []);

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
    const ref = { automationId: input.automationId, name: input.name, cron: input.cron, timezone: input.timezone, instruction: input.instruction, sessionId: task.session_id, enabled: input.enabled !== false };
    refs.set(seriesId, ref);
    if (input.enabled === false) await ncl.call('tasks-pause', { id: seriesId, group: agentGroupId });
    const fresh = await get(seriesId);
    return fresh || toSchedule({ ...task, series_id: seriesId, status: input.enabled === false ? 'paused' : 'pending' }, ref);
  }

  async function fetchTask(seriesId) {
    try {
      return await ncl.call('tasks-get', { id: seriesId, group: agentGroupId });
    } catch (err) {
      if (/not found/i.test(err.message)) return null;
      throw err;
    }
  }

  async function get(seriesId) {
    const ref = refs.get(seriesId);
    if (!ref) return null;
    const task = await fetchTask(seriesId);
    if (!task) return null;
    return toSchedule(task, ref, { pausedByRuntime: task.status === 'paused' ? pauseNote(logLines(task)) : null });
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
    if (patch.enabled === false) { ref.enabled = false; await ncl.call('tasks-pause', { id: seriesId, group: agentGroupId }); }
    if (patch.enabled === true) { ref.enabled = true; pauseNotes.delete(seriesId); await ncl.call('tasks-resume', { id: seriesId, group: agentGroupId }); }
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
    pauseNotes.delete(seriesId);
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

  /** A task this Core life never created: read the whole task and look for FREN's mark. */
  async function recover(seriesId, listed) {
    if (foreign.has(seriesId)) return null;
    const task = (await fetchTask(seriesId)) || listed;
    const ref = refFromPrompt(task.prompt, task);
    if (!ref) { foreign.add(seriesId); return null; }
    refs.set(seriesId, ref);
    return ref;
  }

  /** Why the host paused this series, if it did. One read per paused row. */
  async function pausedDetail(seriesId, rowId) {
    const cached = pauseNotes.get(seriesId);
    if (cached && cached.rowId === rowId) return cached.detail;
    const task = await fetchTask(seriesId);
    const detail = task ? pauseNote(logLines(task)) : null;
    pauseNotes.set(seriesId, { rowId, detail });
    return detail;
  }

  /** What the run log says about the latest failure, for a person. */
  async function failureDetail(seriesId) {
    const task = await fetchTask(seriesId).catch(() => null);
    return (task && failureNote(logLines(task))) || DEFAULT_FAILURE;
  }

  async function list() {
    const rows = await ncl.call('tasks-list', { group: agentGroupId });
    const tasks = Array.isArray(rows) ? rows : (rows && rows.items) || [];
    const out = [];
    for (const task of tasks) {
      const seriesId = task.series_id || task.id;
      const ref = refs.get(seriesId) || (await recover(seriesId, task));
      if (!ref) continue;
      const pausedByRuntime = task.status === 'paused' ? await pausedDetail(seriesId, task.row_id || seriesId) : null;
      out.push(toSchedule(task, ref, { pausedByRuntime }));
    }
    return out;
  }

  async function trigger(seriesId) {
    const fired = await ncl.call('tasks-run', { id: seriesId, group: agentGroupId });
    return { runId: fired.row_id || fired.id, seriesId: fired.series_id || seriesId };
  }

  return { create, get, update, remove, list, trigger, failureDetail, refs, platformIdFor, deliveryNameFor };
}

module.exports = { createScheduleStore, platformIdFor, deliveryNameFor, toSchedule, refFromPrompt, pauseNote, failureNote, DEFAULT_FAILURE };
