'use strict';
/**
 * What the runtime host must contain before FREN can talk to it: one agent
 * group, one owner, one conversation surface, wired together. Every step is
 * create-if-missing by natural key, so running it again changes nothing.
 *
 * The names here are the whole of FREN's footprint in the host's entity
 * model. docs/runtime-architecture.md §11.2 lists them.
 */
const GROUP_FOLDER = 'fren';
const GROUP_NAME = 'fren';
const CHANNEL = 'fren';
const OWNER_HANDLE = 'owner';
const OWNER_ID = `${CHANNEL}:${OWNER_HANDLE}`;

function has(list, pred) {
  return Array.isArray(list) && list.some(pred);
}

/** Tolerate "already exists" from a create, which is the idempotent outcome. */
async function createIfMissing(ncl, exists, command, args) {
  if (await exists()) return 'present';
  try {
    await ncl.call(command, args);
    return 'created';
  } catch (err) {
    if (/exist|duplicate|already/i.test(err.message)) return 'present';
    throw err;
  }
}

/**
 * @param {object} opts
 * @param {{call: Function}} opts.ncl
 * @param {string} opts.timezone
 * @param {string} [opts.model]
 * @param {string} [opts.displayName]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ agentGroupId: string, messagingGroupId: string, steps: Record<string,string> }>}
 */
async function ensureEntities({ ncl, timezone, model, displayName = 'you', toolsUrl = null, toolsToken = null, log = () => {} }) {
  const steps = {};

  // 1. The agent group: fren's workspace.
  const groups = await ncl.call('groups-list', {});
  const groupsList = Array.isArray(groups) ? groups : (groups && groups.items) || [];
  steps.group = await createIfMissing(ncl, async () => has(groupsList, (g) => g.folder === GROUP_FOLDER),
    'groups-create', { folder: GROUP_FOLDER, name: GROUP_NAME, ...(timezone ? { timezone } : {}) });
  const groupsAfter = steps.group === 'created' ? await ncl.call('groups-list', {}) : groups;
  const group = (Array.isArray(groupsAfter) ? groupsAfter : (groupsAfter && groupsAfter.items) || []).find((g) => g.folder === GROUP_FOLDER);
  if (!group) throw new Error('the runtime host has no fren agent group after creating it');
  const agentGroupId = group.id;

  // 2. Its container config: no self-scheduling from inside, the model, the zone.
  try {
    await ncl.call('groups-config-update', { id: agentGroupId, cli_scope: 'disabled', ...(model ? { model } : {}), ...(timezone ? { timezone } : {}) });
    steps.config = 'applied';
  } catch (err) {
    steps.config = `skipped: ${err.message}`;
    log(`[runtime] group config not applied: ${err.message}`);
  }

  // 2b. FREN's own tool server, so the agent can do things for its owner (notify
  // them, …), each gated by fren. A fixed loopback URL on the sandbox proxy,
  // authorised by the same token the model lane uses. Takes effect next spawn.
  if (toolsUrl && toolsToken) {
    try {
      await ncl.call('groups-config-add-mcp-server', {
        id: agentGroupId, name: 'fren', url: toolsUrl,
        headers: JSON.stringify({ Authorization: `Bearer ${toolsToken}` }),
      });
      steps.tools = 'wired';
    } catch (err) {
      steps.tools = `skipped: ${err.message}`;
      log(`[runtime] fren tools not wired: ${err.message}`);
    }
  }

  // 3. The owner, and their role.
  const users = await ncl.call('users-list', {});
  const usersList = Array.isArray(users) ? users : (users && users.items) || [];
  steps.user = await createIfMissing(ncl, async () => has(usersList, (u) => u.id === OWNER_ID),
    'users-create', { id: OWNER_ID, kind: CHANNEL, display_name: displayName });
  try {
    const roles = await ncl.call('roles-list', {});
    const rolesList = Array.isArray(roles) ? roles : (roles && roles.items) || [];
    if (!has(rolesList, (r) => r.user_id === OWNER_ID && r.role === 'owner')) {
      await ncl.call('roles-grant', { user: OWNER_ID, role: 'owner' });
      steps.role = 'granted';
    } else {
      steps.role = 'present';
    }
  } catch (err) {
    if (/exist|already/i.test(err.message)) steps.role = 'present';
    else throw err;
  }

  // 4. The conversation surface, and its wiring to the agent group.
  const mgs = await ncl.call('messaging-groups-list', {});
  const mgList = Array.isArray(mgs) ? mgs : (mgs && mgs.items) || [];
  const findOwner = (list) => list.find((m) => m.channel_type === CHANNEL && m.platform_id === OWNER_HANDLE);
  steps.messagingGroup = await createIfMissing(ncl, async () => !!findOwner(mgList),
    'messaging-groups-create', { channel_type: CHANNEL, platform_id: OWNER_HANDLE, instance: CHANNEL, name: 'fren', is_group: 1, unknown_sender_policy: 'public' });
  const mgsAfter = steps.messagingGroup === 'created' ? await ncl.call('messaging-groups-list', {}) : mgs;
  const owner = findOwner(Array.isArray(mgsAfter) ? mgsAfter : (mgsAfter && mgsAfter.items) || []);
  if (!owner) throw new Error('the runtime host has no owner conversation after creating it');

  const wirings = await ncl.call('wirings-list', {});
  const wList = Array.isArray(wirings) ? wirings : (wirings && wirings.items) || [];
  steps.wiring = await createIfMissing(ncl, async () => has(wList, (w) => w.messaging_group_id === owner.id && w.agent_group_id === agentGroupId),
    'wirings-create', { channel_type: CHANNEL, platform_id: OWNER_HANDLE, instance: CHANNEL, agent_group: GROUP_FOLDER, engage_mode: 'pattern', engage_pattern: '.', session_mode: 'per-thread' });

  return { agentGroupId, messagingGroupId: owner.id, steps };
}

module.exports = { ensureEntities, GROUP_FOLDER, GROUP_NAME, CHANNEL, OWNER_HANDLE, OWNER_ID };
