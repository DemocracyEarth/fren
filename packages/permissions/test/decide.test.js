'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, isScope, SCOPES, DESCRIPTIONS, scopeForRuntimeAction } = require('..');

test('every scope has a description a person can read', () => {
  for (const s of SCOPES) assert.equal(typeof DESCRIPTIONS[s], 'string', s);
  assert.equal(isScope('shell.execute'), true);
  assert.equal(isScope('root.everything'), false);
});

test('asking is the default', () => {
  assert.equal(decide({ scope: 'email.send' }).decision, 'ASK_USER');
  assert.equal(decide({ scope: 'made.up' }).decision, 'ASK_USER');
  assert.equal(decide({ scope: null }).rule, 'unknown-scope');
});

test('a hard deny beats every grant', () => {
  const policy = { denied: ['email.send'], automationGrants: { atm_1: ['email.send'] } };
  const d = decide({ scope: 'email.send', subject: { automationId: 'atm_1' } }, policy);
  assert.equal(d.decision, 'DENY');
  assert.equal(d.rule, 'denied');
});

test('automation and session grants allow, in that order', () => {
  const policy = { automationGrants: { atm_1: ['filesystem.read'] }, sessionGrants: { ses_1: ['shell.execute'] } };
  assert.equal(decide({ scope: 'filesystem.read', subject: { automationId: 'atm_1' } }, policy).rule, 'automation-grant');
  assert.equal(decide({ scope: 'shell.execute', subject: { sessionId: 'ses_1' } }, policy).rule, 'session-grant');
  assert.equal(decide({ scope: 'shell.execute', subject: { automationId: 'atm_1' } }, policy).decision, 'ASK_USER');
});

test('defaults apply last and can be overridden', () => {
  assert.equal(decide({ scope: 'network.request' }).decision, 'ALLOW');
  assert.equal(decide({ scope: 'network.request' }, { defaults: { 'network.request': 'ASK_USER' } }).decision, 'ASK_USER');
});

test('runtime action names map to scopes', () => {
  assert.equal(scopeForRuntimeAction('self_mod.install_packages'), 'runtime.self_modify');
  assert.equal(scopeForRuntimeAction('agents.create'), 'runtime.agents');
  assert.equal(scopeForRuntimeAction('cli_command tasks-create'), 'runtime.schedule');
  assert.equal(scopeForRuntimeAction('mock.ask'), null);
});
