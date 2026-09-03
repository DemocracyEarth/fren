import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<Record<string, unknown>> = [];
vi.mock('./link.js', () => ({
  frenLink: {
    send: (f: Record<string, unknown>) => { sent.push(f); return true; },
    isConnected: () => true,
    request: vi.fn(),
    onFrame: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    socketPath: () => null,
  },
}));
vi.mock('../../delivery.js', () => ({ registerPostDeliveryHook: vi.fn() }));
vi.mock('../../host-lifecycle.js', () => ({ onHostShutdown: vi.fn() }));
vi.mock('../../db/sessions.js', () => ({ getActiveSessions: vi.fn(async () => [{ id: 'ses-1', agent_group_id: 'ag-1' }]) }));

const box = {
  acks: [] as Array<{ messageId: string; status: string }>,
  delivered: new Set<string>(),
  due: [] as Array<{ id: string }>,
};
vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: async (_ag: string, _s: string, fn: (m: unknown) => unknown) =>
    fn({
      getTerminalProcessingAcks: () => box.acks,
      getDeliveredIds: () => box.delivered,
      getDueMessages: (exclude: Set<string>) => box.due.filter((m) => !exclude.has(m.id)),
    }),
}));

import { pollOnce, watchTurn } from './index.js';

describe('FREN module: the end of a turn', () => {
  beforeEach(() => {
    sent.length = 0;
    box.acks = [];
    box.delivered = new Set();
    box.due = [];
  });

  it('reports the turn after its queued messages are delivered, not before', async () => {
    watchTurn('run_1');
    await pollOnce();
    expect(sent).toHaveLength(0);

    box.acks = [{ messageId: 'run_1:ag-1', status: 'completed' }];
    box.due = [{ id: 'out-1' }];
    await pollOnce();
    expect(sent).toHaveLength(0); // acknowledged, but the words are still on their way

    box.delivered = new Set(['out-1']);
    await pollOnce();
    expect(sent).toEqual([{ type: 'turn', runId: 'run_1', status: 'completed', sessionId: 'ses-1', agentGroupId: 'ag-1' }]);

    await pollOnce();
    expect(sent).toHaveLength(1); // once
  });

  it('reports a failed acknowledgement as a failed turn, in the session it was told', async () => {
    watchTurn('run_2', { agentGroupId: 'ag-1', sessionId: 'ses-1' });
    box.acks = [{ messageId: 'run_2', status: 'failed' }];
    await pollOnce();
    expect(sent[0]).toMatchObject({ type: 'turn', runId: 'run_2', status: 'failed', sessionId: 'ses-1' });
  });
});
