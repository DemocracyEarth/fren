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

const { promptFromDoc } = require('../agent-sync.js');

const MINI_DOC = `# fren's voice
## 1 · Greeting (first message)
text
**Dashboard default:**

\`\`\`
Hey. I'm listening.
\`\`\`

**Variants**
\`\`\`
Hey there.
\`\`\`
## 2 · Main goal
\`\`\`
goal
\`\`\`
## 3 · Master prompt (system prompt)
Paste it whole.

\`\`\`
# Personality
You are fren.
\`\`\`
## 4 · Tools
`;

test('the greeting and the master prompt come out of the document, first fenced block under each heading', () => {
  const doc = promptFromDoc(MINI_DOC);
  assert.equal(doc.greeting, "Hey. I'm listening.");
  assert.equal(doc.prompt, '# Personality\nYou are fren.');
  assert.throws(() => promptFromDoc('# nothing here'), /no heading/);
});

test('with the doc, the plan says whether the dashboard prompt and greeting differ; without it, they are not its business', () => {
  const tools = [tool('t1', 'look_around'), tool('t2', 'recall'), tool('t3', 'remember')];
  const inPlace = agentWith({ toolIds: ['t1', 't2', 't3'], placeholders: PLACEHOLDERS });
  inPlace.conversation_config.agent.first_message = "Hey. I'm listening.";
  const doc = { greeting: "Hey. I'm listening.", prompt: '# Personality\nYou are fren.' };
  const p = plan({ agent: inPlace, tools, doc });
  assert.equal(p.promptDiffers, true, "the fixture's prompt is not the doc's");
  assert.equal(p.greetingDiffers, false);
  assert.equal(p.nothing, false);
  inPlace.conversation_config.agent.prompt.prompt = doc.prompt + '\n';
  assert.equal(plan({ agent: inPlace, tools, doc }).nothing, true, 'trailing whitespace is not a difference');
  const without = plan({ agent: inPlace, tools });
  assert.equal(without.promptDiffers, false);
  assert.equal(without.nothing, true);
});
