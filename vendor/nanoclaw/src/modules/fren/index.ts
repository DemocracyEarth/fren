/**
 * FREN module: what the channel adapter cannot see, reported to FREN Core.
 *
 * FREN overlay file, registered by one line in src/modules/index.ts.
 *
 * Two things cross this host that an adapter is never told:
 *
 * 1. Provenance. `deliver()` receives a message with no id and no reply-to.
 *    The post-delivery hook receives the full row, whose `in_reply_to` is the
 *    inbound id — and FREN Core mints inbound ids as its run ids. So every
 *    delivered message can be tied to the run it answers, without parsing
 *    text.
 *
 * 2. The end of a turn. Nothing tells an adapter that the agent has finished
 *    with a message. The container acknowledges the inbound row in its own
 *    mailbox file; this module watches for that acknowledgement and tells
 *    Core `turn` — completed or failed — so a run has an exact end instead of
 *    a guessed one.
 */
import { getActiveSessions } from '../../db/sessions.js';
import { registerPostDeliveryHook } from '../../delivery.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { onHostShutdown } from '../../host-lifecycle.js';

import { frenLink } from './link.js';

const WATCH_POLL_MS = 1000;

/**
 * The router stores an inbound id as `<id>:<agentGroupId>`; the container's
 * acknowledgement and every reply's in_reply_to carry that suffixed form.
 * Core knows the bare id it minted, so both sides are compared by prefix.
 */
function bareId(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const i = stored.indexOf(':');
  return i < 0 ? stored : stored.slice(0, i);
}

function sameId(stored: string, bare: string): boolean {
  return stored === bare || stored.startsWith(bare + ':');
}
const WATCH_MAX_MS = 15 * 60 * 1000;

interface Watch {
  runId: string;
  since: number;
  agentGroupId?: string;
  sessionId?: string;
}

const watches = new Map<string, Watch>();
let poller: NodeJS.Timeout | null = null;

/** Start watching an inbound id for its acknowledgement. Idempotent. */
export function watchTurn(runId: string, session?: { agentGroupId: string; sessionId: string }): void {
  const existing = watches.get(runId);
  if (existing) {
    if (session && !existing.sessionId) Object.assign(existing, { agentGroupId: session.agentGroupId, sessionId: session.sessionId });
    return;
  }
  watches.set(runId, { runId, since: Date.now(), agentGroupId: session?.agentGroupId, sessionId: session?.sessionId });
  ensurePoller();
}

function ensurePoller(): void {
  if (poller) return;
  poller = setInterval(() => {
    void pollOnce();
  }, WATCH_POLL_MS);
  poller.unref();
}

/** One pass over every watched run. Exported for its test. */
export async function pollOnce(): Promise<void> {
  if (watches.size === 0) {
    if (poller) clearInterval(poller);
    poller = null;
    return;
  }
  const now = Date.now();
  // Runs whose session is still unknown are looked for in every active
  // session; there are few in a FREN install (one chat, a handful of tasks).
  let candidates: { agentGroupId: string; sessionId: string }[] | null = null;
  for (const w of [...watches.values()]) {
    if (now - w.since > WATCH_MAX_MS) {
      watches.delete(w.runId);
      frenLink.send({ type: 'turn', runId: w.runId, status: 'failed', detail: 'no acknowledgement in time' });
      continue;
    }
    if (!w.sessionId || !w.agentGroupId) {
      if (!candidates) {
        try {
          candidates = (await getActiveSessions()).map((s) => ({ agentGroupId: s.agent_group_id, sessionId: s.id }));
        } catch (err) {
          log.warn('FREN module: could not list sessions', { err });
          continue;
        }
      }
      for (const c of candidates) {
        if (await settle(w, c)) break;
      }
      continue;
    }
    await settle(w, { agentGroupId: w.agentGroupId, sessionId: w.sessionId });
  }
}

/**
 * True when the run's acknowledgement was found in this session. The end is
 * reported only once the messages the turn queued have been delivered: the
 * container acknowledges as soon as it has said its piece, and the host
 * delivers what it said on a poll of its own, a moment later. Reported
 * first, the end would close a run whose words were still on their way.
 */
async function settle(w: Watch, s: { agentGroupId: string; sessionId: string }): Promise<boolean> {
  let found: { status: string; waiting: number } | null = null;
  try {
    found = await withExistingMailboxSession(s.agentGroupId, s.sessionId, (mailbox) => {
      const ack = mailbox.getTerminalProcessingAcks().find((a) => sameId(a.messageId, w.runId));
      if (!ack) return null;
      const delivered = mailbox.getDeliveredIds();
      const waiting = mailbox.getDueMessages(delivered).filter((m) => !delivered.has(m.id)).length;
      return { status: ack.status, waiting };
    }) ?? null;
  } catch (err) {
    log.debug('FREN module: ack lookup failed', { runId: w.runId, sessionId: s.sessionId, err });
    return false;
  }
  if (!found) return false;
  if (found.waiting > 0) {
    // Found here; no need to look elsewhere. Reported once the queue is empty.
    Object.assign(w, { agentGroupId: s.agentGroupId, sessionId: s.sessionId });
    return true;
  }
  watches.delete(w.runId);
  frenLink.send({
    type: 'turn',
    runId: w.runId,
    status: found.status === 'completed' ? 'completed' : 'failed',
    sessionId: s.sessionId,
    agentGroupId: s.agentGroupId,
  });
  return true;
}

/** Every delivered message, tied to the run it answers. */
registerPostDeliveryHook((msg, session) => {
  if (!frenLink.isConnected()) return;
  const inReplyTo = bareId(typeof msg.inReplyTo === 'string' ? msg.inReplyTo : null);
  frenLink.send({
    type: 'provenance',
    messageId: msg.id,
    inReplyTo,
    kind: msg.kind,
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    platformId: msg.platformId ?? null,
    threadId: msg.threadId ?? null,
  });
  // A delivery for a watched run also tells us its session, so the watcher
  // no longer has to look everywhere.
  if (inReplyTo && watches.has(inReplyTo)) {
    watchTurn(inReplyTo, { agentGroupId: session.agent_group_id, sessionId: session.id });
  }
});

/** Core may ask to watch a run it started through the socket. */
frenLink.onFrame((frame) => {
  if (frame.type === 'watch' && typeof frame.runId === 'string') watchTurn(frame.runId);
});

onHostShutdown(() => {
  if (poller) clearInterval(poller);
  poller = null;
  watches.clear();
  frenLink.stop();
});

/** Test seam. */
export function _watchedRuns(): string[] {
  return [...watches.keys()];
}
