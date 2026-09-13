'use strict';
/**
 * The planning half of scripts/agent-sync.js, pure: given an agent and the
 * workspace's tools, what to create, what to attach, which defaults to fill —
 * and, above all, what to leave alone.
 */
const test = require('node:test');
const assert = require('node:assert');
const { plan, toolConfig, CLIENT_TOOLS, PLACEHOLDERS } = require('../agent-sync.js');

const agentWith = ({ toolIds = [], placeholders = null } = {}) => ({
  name: 'Fren',
  conversation_config: {
    agent: {
      prompt: { prompt: '# Personality …', llm: 'some-llm', tool_ids: toolIds, tools: [{ type: 'system', name: 'end_call' }] },
      ...(placeholders ? { dynamic_variables: { dynamic_variable_placeholders: placeholders } } : {}),
    },
  },
});
const tool = (id, name) => ({ id, tool_config: { type: 'client', name } });

test('a fresh workspace: create all three tools, fill all four defaults', () => {
  const p = plan({ agent: agentWith(), tools: [] });
  assert.deepEqual(p.create.map((s) => s.name), ['look_around', 'recall', 'remember']);
  assert.deepEqual(p.attach, []);
  assert.deepEqual(p.placeholders, PLACEHOLDERS);
  assert.equal(p.nothing, false);
});

test('tools that exist but are not attached are attached, not re-created', () => {
  const tools = [tool('t1', 'look_around'), tool('t2', 'recall'), tool('t9', 'unrelated')];
  const p = plan({ agent: agentWith({ toolIds: ['t1'] }), tools });
  assert.deepEqual(p.inPlace, ['look_around']);
  assert.deepEqual(p.attach, [{ id: 't2', name: 'recall' }]);
  assert.deepEqual(p.create.map((s) => s.name), ['remember']);
});

test('everything in place: nothing to do', () => {
  const tools = [tool('t1', 'look_around'), tool('t2', 'recall'), tool('t3', 'remember')];
  const p = plan({ agent: agentWith({ toolIds: ['t1', 't2', 't3'], placeholders: PLACEHOLDERS }), tools });
  assert.equal(p.nothing, true);
  assert.deepEqual(p.inPlace, ['look_around', 'recall', 'remember']);
});

test('a default the owner set in the dashboard is kept; only missing ones are filled', () => {
  const p = plan({ agent: agentWith({ placeholders: { user_name: 'Santi', local_time: 'sometime' } }), tools: [] });
  assert.deepEqual(p.placeholders, { soul: '', recent_context: 'Nothing noted yet.' });
});

test('the tool shape the API expects: a client tool the conversation waits on, with the doc\'s parameters', () => {
  const c = toolConfig(CLIENT_TOOLS[1]);
  assert.equal(c.type, 'client');
  assert.equal(c.name, 'recall');
  assert.equal(c.expects_response, true);
  assert.deepEqual(c.parameters.required, ['question']);
  assert.equal(typeof c.parameters.properties.question.description, 'string');
  assert.deepEqual(toolConfig(CLIENT_TOOLS[0]).parameters.required, [], 'focus is optional');
});
