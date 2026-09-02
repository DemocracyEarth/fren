'use strict';
/**
 * The FrenRuntime contract: the one seam between FREN's product layer and
 * whatever executes agents underneath it.
 *
 * Types live in ./types.js as JSDoc. This file holds the few runtime values
 * every implementation and every caller share: event names, run statuses,
 * the error a runtime throws when it cannot start, id minting, and a shape
 * check that fails loudly at wiring time instead of at the first call.
 *
 * The rule this package enforces by existing: nothing outside a runtime
 * adapter may depend on how a runtime works. If a caller needs something
 * that is not expressed here, the contract grows and every adapter answers
 * to it — the caller does not reach around.
 */
const crypto = require('node:crypto');

const EVENTS = Object.freeze([
  'runtime.status',
  'run.started', 'run.completed', 'run.failed', 'run.cancelled',
  'agent.working', 'agent.message', 'agent.question',
  'schedule.fired', 'schedule.completed', 'schedule.failed', 'schedule.paused',
  'permission.request',
]);

const RUN_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

const METHODS = Object.freeze([
  'start', 'stop', 'getStatus', 'getCapabilities',
  'createSession', 'listSessions', 'sendMessage', 'runAgent', 'getRun', 'cancelRun',
  'createSchedule', 'updateSchedule', 'deleteSchedule', 'listSchedules', 'triggerSchedule',
  'resolvePermission', 'subscribe',
]);

const CAPABILITY_KEYS = Object.freeze([
  'tokenStreaming', 'toolEvents', 'turnBoundary', 'scheduleTrigger', 'maxFiresPerDay', 'isolation', 'files',
]);

/** Thrown by start() when the runtime cannot run here. `hint` is for people. */
class RuntimeUnavailable extends Error {
  constructor(reason, hint) {
    super(reason);
    this.name = 'RuntimeUnavailable';
    this.reason = reason;
    this.hint = hint || '';
  }
}

/** `run_9f2c…`, `atm_…`: readable prefix, unguessable rest. */
function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function isTerminal(status) {
  return TERMINAL.has(status);
}

function isRuntimeEvent(event) {
  return !!event && typeof event === 'object' && EVENTS.includes(event.type);
}

/**
 * Check that an object has the whole contract. Called where a runtime is
 * wired in, so a half-implemented adapter is a startup error with a list of
 * what is missing, never a TypeError three calls deep.
 */
function assertRuntime(rt) {
  const missing = METHODS.filter((m) => typeof (rt && rt[m]) !== 'function');
  if (!rt || typeof rt.kind !== 'string') missing.unshift('kind');
  if (missing.length) throw new Error(`not a FrenRuntime: missing ${missing.join(', ')}`);
  const caps = rt.getCapabilities();
  const gaps = CAPABILITY_KEYS.filter((k) => !(k in caps));
  if (gaps.length) throw new Error(`runtime "${rt.kind}" capabilities missing ${gaps.join(', ')}`);
  return rt;
}

module.exports = {
  EVENTS, RUN_STATUSES, METHODS, CAPABILITY_KEYS,
  RuntimeUnavailable, newId, isTerminal, isRuntimeEvent, assertRuntime,
};
