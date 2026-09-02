/**
 * The link to FREN Core: one Unix-socket connection, newline-delimited JSON,
 * both directions.
 *
 * FREN overlay file. This host is spawned by FREN Core, which listens on the
 * socket named in FREN_CORE_SOCKET before spawning; this side connects out,
 * says hello with the token Core gave it, and reconnects with backoff for as
 * long as the host lives. The channel adapter (src/channels/fren.ts) and the
 * fren module (src/modules/fren/index.ts) both speak through here, so there
 * is exactly one connection and one place that knows the wire format.
 *
 * Frames this side sends:
 *   hello       { token, adapter, version }
 *   deliver     { id, platformId, threadId, kind, content, files? }   → awaits { type:'ack', id, ok, error? }
 *   typing      { platformId, threadId, on, status? }
 *   provenance  { inReplyTo, seq, kind, sessionId, agentGroupId, platformId, threadId }
 *   turn        { runId, status, sessionId }
 *   pong        {}
 * Frames Core sends:
 *   welcome     {}
 *   inbound     { id, platformId, threadId, text, sender, senderId, timestamp }
 *   action      { questionId, value, userId }
 *   watch       { runId }
 *   ack         { id, ok, error? }
 *   ping        {}
 */
import net from 'net';

import { log } from '../../log.js';

export const PROTOCOL_VERSION = 1;
const BACKOFF_MS = [500, 1000, 2000, 5000, 10000];
const ACK_TIMEOUT_MS = 15_000;

export type Frame = Record<string, unknown> & { type: string };

type Listener = (frame: Frame) => void;

interface PendingAck {
  resolve: (frame: Frame) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class FrenLink {
  private socket: net.Socket | null = null;
  private connected = false;
  private closed = false;
  private attempt = 0;
  private buffer = '';
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<string, PendingAck>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private seq = 0;

  /** Where Core listens; absent means this host was not started by FREN Core. */
  socketPath(): string | null {
    return (process.env.FREN_CORE_SOCKET ?? '').trim() || null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Start connecting, and keep at it. Idempotent. */
  start(): void {
    if (this.socket || this.closed) return;
    const sock = this.socketPath();
    if (!sock) {
      log.warn('FREN link: FREN_CORE_SOCKET is not set; the fren channel stays offline');
      return;
    }
    this.connect(sock);
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('FREN link closed'));
      this.pending.delete(id);
    }
    if (this.socket) {
      try { this.socket.end(); } catch { /* best effort */ }
      this.socket = null;
    }
    this.connected = false;
  }

  onFrame(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Fire and forget. Returns false when there is no connection. */
  send(frame: Frame): boolean {
    if (!this.socket || !this.connected) return false;
    try {
      this.socket.write(JSON.stringify(frame) + '\n');
      return true;
    } catch (err) {
      log.warn('FREN link: write failed', { err });
      return false;
    }
  }

  /** Send and wait for Core's ack. Rejects when disconnected, so NanoClaw retries. */
  request(frame: Frame): Promise<Frame> {
    if (!this.socket || !this.connected) return Promise.reject(new Error('FREN Core is not connected'));
    this.seq += 1;
    const id = `f${Date.now().toString(36)}-${this.seq}`;
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('FREN Core did not acknowledge in time'));
      }, ACK_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ ...frame, id })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('FREN Core is not connected'));
      }
    });
  }

  private connect(sock: string): void {
    const socket = net.createConnection(sock);
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      this.attempt = 0;
      this.connected = true;
      this.buffer = '';
      this.send({
        type: 'hello',
        token: (process.env.FREN_RUNTIME_TOKEN ?? '').trim(),
        adapter: 'fren',
        version: PROTOCOL_VERSION,
      });
      log.info('FREN link connected', { sock });
    });
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.receive(line);
      }
    });
    const drop = (why: string) => {
      if (this.socket !== socket) return;
      const was = this.connected;
      this.connected = false;
      this.socket = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`FREN Core disconnected (${why})`));
        this.pending.delete(id);
      }
      if (was) log.warn('FREN link disconnected', { why });
      if (this.closed) return;
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt += 1;
      this.reconnectTimer = setTimeout(() => this.connect(sock), delay);
    };
    socket.on('error', (err) => drop(err.message));
    socket.on('close', () => drop('closed'));
  }

  private receive(line: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(line) as Frame;
    } catch {
      log.warn('FREN link: ignoring a line that is not JSON');
      return;
    }
    if (!frame || typeof frame.type !== 'string') return;
    if (frame.type === 'ping') {
      this.send({ type: 'pong' });
      return;
    }
    if (frame.type === 'ack' && typeof frame.id === 'string') {
      const p = this.pending.get(frame.id);
      if (p) {
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve(frame);
      }
      return;
    }
    for (const fn of [...this.listeners]) {
      try {
        fn(frame);
      } catch (err) {
        log.error('FREN link: a listener threw', { type: frame.type, err });
      }
    }
  }
}

/** The one link. Created at import; connected when the channel adapter sets up. */
export const frenLink = new FrenLink();
