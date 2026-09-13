#!/usr/bin/env node
'use strict';
/**
 * Bring the ElevenLabs "Fren" agent in line with docs/voice-agent.md — the part
 * the voice client cannot work without: the three client tools (look_around,
 * recall, remember) and the dynamic-variable defaults. The prompt and the
 * greeting are the owner's to paste by hand; this never sends them.
 *
 *   node scripts/agent-sync.js            # dry run: says what would change
 *   node scripts/agent-sync.js --apply    # makes the changes
 *
 * Reads ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID from .env; the key never
 * leaves this process. Idempotent: tools are reused by name, nothing already in
 * place is touched, a default the owner changed in the dashboard is kept. After
 * applying it reads the agent back and checks the prompt text survived — and
 * puts it back as it was if the API did not merge the way it should.
 */
const { loadEnv } = require('../packages/shared');

const BASE = 'https://api.elevenlabs.io';

/** §4 of docs/voice-agent.md, verbatim. */
const CLIENT_TOOLS = [
  {
    name: 'look_around',
    description: 'What the user has in front of them right now: the active app and window, and the page open in the browser, if any. Returns a short plain-text description, or says that nothing is available.',
    parameters: { type: 'object', properties: { focus: { type: 'string', description: 'What they are asking about, to pick the relevant part.' } }, required: [] },
  },
  {
    name: 'recall',
    description: 'What fren noticed earlier, and the durable notes it keeps about the user. Returns recent activity summaries and matching notes as plain text. Everything about the past must come from here.',
    parameters: { type: 'object', properties: { question: { type: 'string', description: 'What to look for.' } }, required: ['question'] },
  },
  {
    name: 'remember',
    description: 'Keep something the user said that is worth remembering — a preference, a fact about them, or something they asked to be remembered. fren applies its own judgment about what is kept.',
    parameters: { type: 'object', properties: { note: { type: 'string', description: 'The thing to remember, as one plain sentence.' } }, required: ['note'] },
  },
];

/** §5: harmless defaults, so the prompt still reads if a variable is missing. */
const PLACEHOLDERS = { user_name: 'there', soul: '', recent_context: 'Nothing noted yet.', local_time: 'daytime' };

/** The API's shape for one of ours: a client tool the conversation waits on. */
function toolConfig(spec) {
  return { type: 'client', name: spec.name, description: spec.description, expects_response: true, response_timeout_secs: 10, parameters: spec.parameters };
}

const promptOf = (agent) => (((agent || {}).conversation_config || {}).agent || {}).prompt || {};
const placeholdersOf = (agent) => ((((agent || {}).conversation_config || {}).agent || {}).dynamic_variables || {}).dynamic_variable_placeholders || {};

/** Pure: given the agent and the workspace's tools, what has to change. */
function plan({ agent, tools }) {
  const attached = new Set(promptOf(agent).tool_ids || []);
  const byName = new Map((tools || []).map((t) => [(t.tool_config || {}).name, t]));
  const create = [];
  const attach = [];
  const inPlace = [];
  for (const spec of CLIENT_TOOLS) {
    const existing = byName.get(spec.name);
    if (!existing) create.push(spec);
    else if (attached.has(existing.id)) inPlace.push(spec.name);
    else attach.push({ id: existing.id, name: spec.name });
  }
  const current = placeholdersOf(agent);
  const placeholders = {};
  for (const [k, v] of Object.entries(PLACEHOLDERS)) if (!(k in current)) placeholders[k] = v;
  return { create, attach, inPlace, placeholders, nothing: !create.length && !attach.length && !Object.keys(placeholders).length };
}

async function api(key, method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return null; }
}

async function main() {
  loadEnv();
  const key = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!key || !agentId) {
    console.error('ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID must both be set in .env');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');

  const before = await api(key, 'GET', `/v1/convai/agents/${agentId}`);
  const tools = (await api(key, 'GET', '/v1/convai/tools') || {}).tools || [];
  const p = plan({ agent: before, tools });

  console.log(`agent "${before.name}" (${agentId})`);
  if (p.inPlace.length) console.log(`  in place: ${p.inPlace.join(', ')}`);
  for (const s of p.create) console.log(`  create and attach client tool: ${s.name}`);
  for (const t of p.attach) console.log(`  attach existing tool: ${t.name} (${t.id})`);
  for (const [k, v] of Object.entries(p.placeholders)) console.log(`  default for {{${k}}}: ${JSON.stringify(v)}`);
  if (p.nothing) { console.log('  nothing to do — the agent matches the doc'); return; }
  if (!apply) { console.log('dry run — add --apply to make these changes'); return; }

  const ids = [...(promptOf(before).tool_ids || []), ...p.attach.map((t) => t.id)];
  for (const s of p.create) {
    const made = await api(key, 'POST', '/v1/convai/tools', { tool_config: toolConfig(s) });
    ids.push(made.id);
    console.log(`  created ${s.name} → ${made.id}`);
  }
  // Send the prompt object back whole (minus the deprecated inline `tools`
  // list) with the ids added, so a partial update cannot drop the rest of it.
  const { tools: _inline, ...prompt } = promptOf(before);
  const patch = {
    conversation_config: {
      agent: {
        prompt: { ...prompt, tool_ids: ids },
        dynamic_variables: { dynamic_variable_placeholders: { ...placeholdersOf(before), ...p.placeholders } },
      },
    },
  };
  await api(key, 'PATCH', `/v1/convai/agents/${agentId}`, patch);

  let after = await api(key, 'GET', `/v1/convai/agents/${agentId}`);
  if (promptOf(after).prompt !== promptOf(before).prompt || promptOf(after).llm !== promptOf(before).llm) {
    console.log('  the prompt or model changed under the update — putting them back as they were');
    await api(key, 'PATCH', `/v1/convai/agents/${agentId}`, { conversation_config: { agent: { prompt: { ...prompt, tool_ids: ids } } } });
    after = await api(key, 'GET', `/v1/convai/agents/${agentId}`);
  }
  const check = plan({ agent: after, tools: (await api(key, 'GET', '/v1/convai/tools') || {}).tools || [] });
  const promptIntact = promptOf(after).prompt === promptOf(before).prompt && promptOf(after).llm === promptOf(before).llm;
  if (check.nothing && promptIntact) {
    console.log(`done — client tools attached: ${check.inPlace.join(', ')}; prompt and model untouched`);
  } else {
    console.log(`applied, but something still differs — ${check.nothing ? '' : 'the tools or defaults are not as the doc says; '}${promptIntact ? '' : 'the prompt or model is not what it was; '}check the dashboard`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { plan, toolConfig, CLIENT_TOOLS, PLACEHOLDERS };
