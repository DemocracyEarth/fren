'use strict';
/**
 * Permissions: what an agent may do to the host or the world, in words a
 * person can read.
 *
 * Container isolation says what an agent physically can reach. This layer is
 * the other half: a structured request ("filesystem.write", "email.send")
 * decided as ALLOW, DENY or ASK_USER against a policy. Pure functions, no
 * storage — the broker in fren-core keeps the requests and asks the person.
 *
 * Decision order, first match wins: a hard deny; a grant on the automation
 * the request came from; a grant on the conversation; the default for the
 * scope; otherwise ask. Asking is the default because a permission nobody
 * granted is not one to assume.
 */
const SCOPES = Object.freeze([
  'filesystem.read', 'filesystem.write',
  'browser.read', 'browser.navigate', 'browser.submit',
  'email.read', 'email.send',
  'calendar.read', 'calendar.write',
  'shell.execute',
  'notification.send',
  'network.request',
  'runtime.self_modify',   // install packages, add tool servers inside the sandbox
  'runtime.schedule',      // an agent creating or changing schedules by itself
  'runtime.agents',        // an agent creating other agents
]);

const DECISIONS = Object.freeze(['ALLOW', 'DENY', 'ASK_USER']);

/** What each scope means, for the card a person reads. */
const DESCRIPTIONS = Object.freeze({
  'filesystem.read': 'read files on this computer',
  'filesystem.write': 'change files on this computer',
  'browser.read': 'read what is in the browser',
  'browser.navigate': 'open pages in the browser',
  'browser.submit': 'submit forms in the browser',
  'email.read': 'read email',
  'email.send': 'send email',
  'calendar.read': 'read the calendar',
  'calendar.write': 'change the calendar',
  'shell.execute': 'run commands on this computer',
  'notification.send': 'show notifications',
  'network.request': 'reach the internet',
  'runtime.self_modify': 'install tools into its own workspace',
  'runtime.schedule': 'schedule work for itself',
  'runtime.agents': 'create other agents',
});

/**
 * The runtime's own action names, mapped to a scope. Anything unknown maps
 * to null and the broker asks, with the runtime's title as the question.
 */
function scopeForRuntimeAction(action) {
  const a = String(action || '');
  if (/install_packages|add_mcp_server|self_mod|groups-config|groups-restart|mount/.test(a)) return 'runtime.self_modify';
  if (/agents\.create|create_agent|a2a|agent-to-agent/.test(a)) return 'runtime.agents';
  if (/tasks-|schedule/.test(a)) return 'runtime.schedule';
  if (/shell|exec|bash/.test(a)) return 'shell.execute';
  if (/network|fetch|http/.test(a)) return 'network.request';
  return null;
}

function isScope(s) {
  return SCOPES.includes(s);
}

const DEFAULTS = Object.freeze({
  // Open egress is the container's state today; a prompt per request would
  // be theatre until an allowlist exists (docs/runtime-architecture.md §9.4).
  'network.request': 'ALLOW',
});

/**
 * @param {{ scope: string|null, subject?: { automationId?: string, sessionId?: string } }} request
 * @param {{ denied?: string[], automationGrants?: Record<string, string[]>, sessionGrants?: Record<string, string[]>, defaults?: Record<string, string> }} [policy]
 * @returns {{ decision: 'ALLOW'|'DENY'|'ASK_USER', reason: string, rule: string }}
 */
function decide(request, policy = {}) {
  const scope = request && request.scope;
  const subject = (request && request.subject) || {};
  if (!scope || !isScope(scope)) {
    return { decision: 'ASK_USER', reason: 'this kind of action has no standing rule', rule: 'unknown-scope' };
  }
  if ((policy.denied || []).includes(scope)) {
    return { decision: 'DENY', reason: `${DESCRIPTIONS[scope]} is switched off`, rule: 'denied' };
  }
  const automationGrant = subject.automationId && (policy.automationGrants || {})[subject.automationId];
  if (automationGrant && automationGrant.includes(scope)) {
    return { decision: 'ALLOW', reason: 'granted when the automation was created', rule: 'automation-grant' };
  }
  const sessionGrant = subject.sessionId && (policy.sessionGrants || {})[subject.sessionId];
  if (sessionGrant && sessionGrant.includes(scope)) {
    return { decision: 'ALLOW', reason: 'granted for this conversation', rule: 'session-grant' };
  }
  const fallback = { ...DEFAULTS, ...(policy.defaults || {}) }[scope];
  if (fallback && DECISIONS.includes(fallback)) {
    return { decision: fallback, reason: `the default for ${DESCRIPTIONS[scope]}`, rule: 'default' };
  }
  return { decision: 'ASK_USER', reason: 'nobody has granted this', rule: 'ask' };
}

module.exports = { SCOPES, DECISIONS, DESCRIPTIONS, DEFAULTS, isScope, decide, scopeForRuntimeAction };
