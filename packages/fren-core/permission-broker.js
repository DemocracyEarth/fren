'use strict';
/**
 * The permission broker: FREN as the human in the loop.
 *
 * The runtime raises a request when an agent wants something it may not
 * simply do (docs/runtime-architecture.md §9). The broker maps the runtime's
 * action to a FREN scope, decides against the standing policy — grants made
 * when an automation was created, grants made for a conversation, hard
 * denies, defaults — and either answers the runtime at once or asks the
 * person. Every path leaves a row and an event, so the history shows what
 * fren decided on the owner's behalf, and why.
 *
 * An unanswered request expires to a deny. Nothing is ever approved by
 * silence.
 */
const { newId } = require('../runtime');
const { decide, scopeForRuntimeAction, DESCRIPTIONS } = require('../permissions');
const { httpError } = require('./runs');

const EXPIRY_MS = 10 * 60 * 1000;
const SWEEP_MS = 30 * 1000;

function createPermissionBroker({ store, events, getRuntime, now = Date.now, log = () => {}, expiryMs = EXPIRY_MS, sweepMs = SWEEP_MS }) {
  const sessionGrants = new Map(); // sessionId -> Set<scope>, this Core life only
  let timer = null;

  function policy() {
    const automationGrants = {};
    for (const a of store.listAutomations()) automationGrants[a.id] = a.permissions || [];
    const grants = {};
    for (const [id, set] of sessionGrants) grants[id] = [...set];
    return { automationGrants, sessionGrants: grants, denied: [], defaults: {} };
  }

  function present(row) {
    if (!row) return null;
    const d = row.detail || {};
    return {
      id: row.id, scope: row.scope, description: DESCRIPTIONS[row.scope] || d.action || row.scope,
      source: row.source, subject: row.subject || {}, title: d.title || '', question: d.question || '',
      options: d.options || ['approve', 'deny'], action: d.action || null,
      status: row.status, decision: row.decision, reason: row.reason,
      createdAt: row.createdAt, expiresAt: row.expiresAt, resolvedAt: row.resolvedAt,
    };
  }

  async function answerRuntime(row, decision, reason) {
    const rt = getRuntime();
    if (!rt || !row.runtimeRequestId) return;
    try {
      await rt.resolvePermission(row.runtimeRequestId, decision, reason);
    } catch (err) {
      log(`[permissions] could not answer the runtime for ${row.id}: ${err.message}`);
    }
  }

  /** A request from the runtime. Returns true: this event is ours. */
  function onRuntimeEvent(event) {
    if (event.type !== 'permission.request' || !event.request) return false;
    const r = event.request;
    const scope = scopeForRuntimeAction(r.action);
    const subject = { sessionId: r.sessionId || null, automationId: r.automationId || null };
    const verdict = decide({ scope, subject }, policy());
    const at = now();
    const row = {
      id: newId('perm'), scope: scope || 'unknown', source: 'runtime', subject,
      detail: { title: r.title, question: r.question, options: r.options || ['approve', 'deny'], action: r.action, payload: r.payload },
      runtimeRequestId: r.id, createdAt: at, expiresAt: at + expiryMs,
    };
    store.insertPermissionRequest(row);
    const stored = store.getPermissionRequest(row.id);
    if (verdict.decision === 'ALLOW' || verdict.decision === 'DENY') {
      const decision = verdict.decision === 'ALLOW' ? 'approve' : 'deny';
      store.resolvePermissionRequest(row.id, { status: verdict.decision === 'ALLOW' ? 'approved' : 'denied', decision, reason: verdict.reason, resolvedAt: at });
      answerRuntime(stored, decision, verdict.reason);
      events.emit(verdict.decision === 'ALLOW' ? 'permission.approved' : 'permission.denied', {
        request: present(store.getPermissionRequest(row.id)), auto: true, rule: verdict.rule, reason: verdict.reason,
      });
      return true;
    }
    events.emit('permission.requested', { request: present(stored) });
    return true;
  }

  function list({ status } = {}) {
    return store.listPermissionRequests({ status }).map(present);
  }

  function get(id) {
    const row = store.getPermissionRequest(id);
    if (!row) throw httpError(404, 'no such request');
    return present(row);
  }

  /** The person answered. `remember: 'session'` grants the scope for that conversation. */
  async function decideRequest(id, { decision, reason = '', remember = 'once' } = {}) {
    const row = store.getPermissionRequest(id);
    if (!row) throw httpError(404, 'no such request');
    if (!['approve', 'deny'].includes(decision)) throw httpError(400, 'decision must be approve or deny');
    if (row.status !== 'open') throw httpError(409, `already ${row.status}`);
    if (row.expiresAt <= now()) {
      expire(row, 'expired before it was answered');
      throw httpError(409, 'that request expired');
    }
    const clean = String(reason || '').slice(0, 200);
    store.resolvePermissionRequest(id, { status: decision === 'approve' ? 'approved' : 'denied', decision, reason: clean, resolvedAt: now() });
    if (decision === 'approve' && remember === 'session' && row.subject && row.subject.sessionId && row.scope !== 'unknown') {
      if (!sessionGrants.has(row.subject.sessionId)) sessionGrants.set(row.subject.sessionId, new Set());
      sessionGrants.get(row.subject.sessionId).add(row.scope);
    }
    await answerRuntime(row, decision, clean);
    const after = present(store.getPermissionRequest(id));
    events.emit(decision === 'approve' ? 'permission.approved' : 'permission.denied', { request: after, auto: false, rule: 'user', reason: clean });
    return after;
  }

  function expire(row, why) {
    store.resolvePermissionRequest(row.id, { status: 'expired', decision: 'deny', reason: why, resolvedAt: now() });
    answerRuntime(row, 'deny', why);
    events.emit('permission.expired', { request: present(store.getPermissionRequest(row.id)), reason: why });
  }

  /** Open requests past their time become a deny. Returns how many. */
  function expireStale() {
    let n = 0;
    for (const row of store.listPermissionRequests({ status: 'open' })) {
      if (row.expiresAt <= now()) { expire(row, 'nobody answered in time'); n += 1; }
    }
    return n;
  }

  /** The runtime went away: whatever it was asking no longer exists. */
  function runtimeGone() {
    for (const row of store.listPermissionRequests({ status: 'open' })) expire(row, 'the secure execution environment restarted');
    sessionGrants.clear();
  }

  function start() {
    if (timer) return;
    timer = setInterval(expireStale, sweepMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { onRuntimeEvent, list, get, decide: decideRequest, expireStale, runtimeGone, start, stop, policy };
}

module.exports = { createPermissionBroker, EXPIRY_MS };
