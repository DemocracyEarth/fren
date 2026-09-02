/**
 * FREN channel — the desktop companion as a channel adapter.
 *
 * FREN overlay file, registered by one line in src/channels/index.ts. This
 * host is spawned by FREN Core; the link to it lives in
 * src/modules/fren/link.ts. What arrives from FREN is routed like any other
 * channel; what the agent says goes back through `deliver`, cards and all.
 *
 * Shape: one messaging group per surface. `owner` is the person's chat
 * (threads are FREN sessions, so `supportsThreads` is true and the wiring is
 * per-thread); `automation:<id>` groups are where automations send their
 * results, one per automation, so a delivery's platform id says which
 * automation it came from without parsing text. Approval cards arrive on the
 * owner's DM, which is the same `owner` group.
 *
 * `deliver()` rejects when Core is not connected. The row is retried by the
 * host and marked failed after its attempts — never silently marked
 * delivered, because a message nobody saw is not a delivered message.
 */
import { log } from '../log.js';
import { frenLink, type Frame } from '../modules/fren/link.js';
import { watchTurn } from '../modules/fren/index.js';

import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

export const FREN_CHANNEL = 'fren';
export const OWNER_PLATFORM_ID = 'owner';

/**
 * Every line from FREN is for the agent (pattern '.'); the socket is Core's
 * and Core is the owner, so senders are trusted ('public'); threads are FREN
 * sessions; FREN never marks mentions.
 */
export const FREN_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'never',
};

const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

function str(v: unknown, max = 8000): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function createAdapter(): ChannelAdapter {
  let offFrames: (() => void) | null = null;

  const adapter: ChannelAdapter = {
    name: FREN_CHANNEL,
    channelType: FREN_CHANNEL,
    supportsThreads: true,
    defaults: FREN_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      offFrames = frenLink.onFrame((frame) => {
        void handleFrame(frame, config);
      });
      frenLink.start();
      log.info('FREN channel ready', { socket: frenLink.socketPath() });
    },

    async teardown(): Promise<void> {
      if (offFrames) offFrames();
      offFrames = null;
      frenLink.stop();
    },

    isConnected(): boolean {
      return frenLink.isConnected();
    },

    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      const files = (message.files ?? []).map((f) => ({ filename: f.filename, data: f.data.toString('base64') }));
      const ack = await frenLink.request({
        type: 'deliver',
        platformId,
        threadId,
        kind: message.kind,
        content: message.content,
        ...(files.length ? { files } : {}),
      });
      if (ack.ok !== true) throw new Error(`FREN Core refused the delivery: ${str(ack.error) || 'unknown'}`);
      return typeof ack.messageId === 'string' ? ack.messageId : undefined;
    },

    async setTyping(platformId, threadId, status, statusKind): Promise<void> {
      frenLink.send({ type: 'typing', platformId, threadId, on: true, status: status ?? null, statusKind: statusKind ?? null });
    },
  };

  return adapter;
}

/** Frames from Core that are the channel's to act on. */
export async function handleFrame(frame: Frame, config: ChannelSetup): Promise<void> {
  if (frame.type === 'inbound') {
    const id = str(frame.id, 120);
    const platformId = str(frame.platformId, 120) || OWNER_PLATFORM_ID;
    const text = str(frame.text);
    if (!ID_RE.test(id) || !ID_RE.test(platformId) || !text) {
      log.warn('FREN channel: ignoring a malformed inbound frame');
      return;
    }
    const threadId = typeof frame.threadId === 'string' && ID_RE.test(frame.threadId) ? frame.threadId : null;
    try {
      await config.onInbound(platformId, threadId, {
        id,
        kind: 'chat',
        timestamp: typeof frame.timestamp === 'string' ? frame.timestamp : new Date().toISOString(),
        content: {
          text,
          sender: str(frame.sender, 80) || 'owner',
          senderId: str(frame.senderId, 120) || `${FREN_CHANNEL}:${OWNER_PLATFORM_ID}`,
        },
      });
      // The inbound id is Core's run id; its acknowledgement is the run's end.
      watchTurn(id);
    } catch (err) {
      log.error('FREN channel: onInbound threw', { err });
    }
    return;
  }
  if (frame.type === 'action') {
    const questionId = str(frame.questionId, 200);
    const value = str(frame.value, 200);
    const userId = str(frame.userId, 120) || OWNER_PLATFORM_ID;
    if (!questionId || !value) return;
    try {
      config.onAction(questionId, value, userId);
    } catch (err) {
      log.error('FREN channel: onAction threw', { err });
    }
  }
}

registerChannelAdapter(FREN_CHANNEL, { factory: createAdapter, defaults: FREN_DEFAULTS });
