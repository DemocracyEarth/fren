import { describe, expect, it, vi } from 'vitest';

vi.mock('../modules/fren/index.js', () => ({ watchTurn: vi.fn() }));

import { createAdapter, FREN_DEFAULTS, handleFrame, OWNER_PLATFORM_ID } from './fren.js';
import { watchTurn } from '../modules/fren/index.js';
import { getRegisteredChannelNames } from './channel-registry.js';
import type { InboundMessage } from './adapter.js';

function setup() {
  return {
    onInbound: vi.fn<(platformId: string, threadId: string | null, message: InboundMessage) => Promise<void>>(async () => undefined),
    onInboundEvent: vi.fn(async () => undefined),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  };
}

describe('FREN channel adapter', () => {
  it('is registered with the defaults FREN needs', () => {
    expect(getRegisteredChannelNames()).toContain('fren');
    expect(FREN_DEFAULTS.dm.engagePattern).toBe('.');
    expect(FREN_DEFAULTS.dm.threads).toBe(true);
    expect(FREN_DEFAULTS.mentions).toBe('never');
    const adapter = createAdapter();
    expect(adapter.channelType).toBe('fren');
    expect(adapter.supportsThreads).toBe(true);
    expect(adapter.isConnected()).toBe(false);
  });

  it('routes an inbound frame as a chat message whose id is the run id, and watches the turn', async () => {
    const config = setup();
    await handleFrame({ type: 'inbound', id: 'run_0123456789abcdef', platformId: 'owner', threadId: 'ses_1', text: 'hello', sender: 'you', senderId: 'fren:owner', timestamp: '2026-09-02T12:00:00.000Z' }, config);
    expect(config.onInbound).toHaveBeenCalledTimes(1);
    const [platformId, threadId, raw] = config.onInbound.mock.calls[0];
    const message = raw as InboundMessage & { content: { text: string; senderId: string } };
    expect(platformId).toBe('owner');
    expect(threadId).toBe('ses_1');
    expect(message.id).toBe('run_0123456789abcdef');
    expect(message.kind).toBe('chat');
    expect(message.content.text).toBe('hello');
    expect(message.content.senderId).toBe('fren:owner');
    expect(watchTurn).toHaveBeenCalledWith('run_0123456789abcdef');
  });

  it('drops malformed inbound frames and defaults the platform to the owner', async () => {
    const config = setup();
    await handleFrame({ type: 'inbound', id: 'bad id!', text: 'x' }, config);
    await handleFrame({ type: 'inbound', id: 'run_1', text: '' }, config);
    expect(config.onInbound).not.toHaveBeenCalled();
    await handleFrame({ type: 'inbound', id: 'run_2', text: 'hi' }, config);
    expect(config.onInbound.mock.calls[0][0]).toBe(OWNER_PLATFORM_ID);
    expect(config.onInbound.mock.calls[0][1]).toBeNull();
  });

  it('turns an action frame into a card answer from the owner', async () => {
    const config = setup();
    await handleFrame({ type: 'action', questionId: 'apr_1', value: 'approve' }, config);
    expect(config.onAction).toHaveBeenCalledWith('apr_1', 'approve', 'owner');
    await handleFrame({ type: 'action', questionId: '', value: 'approve' }, config);
    expect(config.onAction).toHaveBeenCalledTimes(1);
  });
});
