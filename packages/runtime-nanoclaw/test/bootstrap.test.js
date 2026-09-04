'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureEntities } = require('../bootstrap');

/** A fake ncl that records calls; lists return empty so every step "creates". */
function fakeNcl() {
  const calls = [];
  const state = { groups: [], mgs: [] };
  const call = async (command, args) => {
    calls.push({ command, args });
    if (command === 'groups-list') return state.groups;
    if (command === 'messaging-groups-list') return state.mgs;
    if (command.endsWith('-list')) return [];
    if (command === 'groups-create') { state.groups.push({ id: 'g-1', folder: args.folder }); return { id: 'g-1' }; }
    if (command === 'messaging-groups-create') { state.mgs.push({ id: 'm-1', channel_type: args.channel_type, platform_id: args.platform_id }); return { id: 'm-1' }; }
    return { ok: true };
  };
  return { call, calls };
}

test('bootstrap wires the fren tools server with the tier-correct url and bearer', async () => {
  const ncl = fakeNcl();
  const res = await ensureEntities({ ncl, timezone: 'UTC', model: 'm', log: () => {}, toolsUrl: 'http://127.0.0.1:4527/mcp', toolsToken: 'host-secret' });
  assert.equal(res.steps.tools, 'wired');
  const add = ncl.calls.find((c) => c.command === 'groups-config-add-mcp-server');
  assert.ok(add, 'add-mcp-server was called');
  assert.equal(add.args.id, res.agentGroupId);
  assert.equal(add.args.name, 'fren');
  assert.equal(add.args.url, 'http://127.0.0.1:4527/mcp');
  // headers is a JSON STRING (the socket handler JSON.parses it)
  assert.deepEqual(JSON.parse(add.args.headers), { Authorization: 'Bearer host-secret' });
});

test('bootstrap skips the tools server when no url is given, without failing', async () => {
  const ncl = fakeNcl();
  const res = await ensureEntities({ ncl, timezone: 'UTC', log: () => {} });
  assert.equal(res.steps.tools, undefined);
  assert.equal(ncl.calls.some((c) => c.command === 'groups-config-add-mcp-server'), false);
  // the rest of the bootstrap still ran
  assert.ok(res.agentGroupId);
});

test('a failing tools injection is tolerated, not fatal', async () => {
  const ncl = fakeNcl();
  const orig = ncl.call;
  ncl.call = async (command, args) => { if (command === 'groups-config-add-mcp-server') throw new Error('boom'); return orig(command, args); };
  const res = await ensureEntities({ ncl, timezone: 'UTC', log: () => {}, toolsUrl: 'http://127.0.0.1:4527/mcp', toolsToken: 't' });
  assert.match(res.steps.tools, /^skipped:/);
  assert.ok(res.agentGroupId);
});
