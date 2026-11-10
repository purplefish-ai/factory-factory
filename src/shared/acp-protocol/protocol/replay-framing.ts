import { z } from 'zod';
import {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_FRAME_BYTES,
  SessionReplayBatchSchema,
  SessionReplayChunkSchema,
  type SessionReplayChunk,
} from './replay-frame-schema';

export {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_FRAME_BYTES,
  REPLAY_CHUNK_BYTES,
} from './replay-frame-schema';
const MAX_REPLAY_AGE_MS = 30_000;

type PendingReplay = {
  id: string;
  total: number;
  byteLength: number;
  next: number;
  received: number;
  startedAt: number;
  parts: Uint8Array[];
  batch: NonNullable<Extract<SessionReplayChunk, { encoding: 'events' }>['batch']> | null;
  eventBytes: number;
  eventReceived: number;
};
const encoder = new TextEncoder();
function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}
function decodeJson(parts: Uint8Array[], length: number): unknown {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return z.unknown().parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

/**
 * Reassemble privately, publishing only a complete batch to existing hydration guards.
 * `onInvalidFrame` hears about malformed or oversized replay data; chunks that
 * merely belong to an abandoned or superseded replay are dropped silently.
 */
export class SessionReplayAssembler {
  private pending: PendingReplay | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onInvalidFrame: (error: unknown) => void = () => undefined) {}

  reset(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    this.pending = null;
  }

  accept(data: unknown, now = Date.now()): unknown | null {
    const type = typeof data === 'object' && data !== null && 'type' in data ? data.type : null;
    if (type !== 'session_replay_chunk') {
      if (type === 'session_replay_batch') {
        this.reset();
        if (jsonBytes(data) > MAX_REPLAY_FRAME_BYTES) {
          this.onInvalidFrame(new Error('Unframed replay batch exceeds its byte limit'));
          return null;
        }
      }
      return data;
    }
    try {
      return this.acceptChunk(data, now);
    } catch (error) {
      this.reset();
      this.onInvalidFrame(error);
      return null;
    }
  }

  private startReplay(frame: SessionReplayChunk, now: number): void {
    this.reset();
    const batch = frame.encoding === 'events' ? (frame.batch ?? null) : null;
    if (frame.encoding !== undefined && batch?.replayEvents.length !== 0) {
      throw new Error('Replay must start with an empty batch envelope');
    }
    this.timeout = setTimeout(() => this.reset(), MAX_REPLAY_AGE_MS);
    this.timeout.unref?.();
    this.pending = {
      id: frame.replayId,
      total: frame.total,
      byteLength: frame.byteLength,
      next: 0,
      received: batch ? jsonBytes(batch) : 0,
      startedAt: now,
      parts: [],
      batch,
      eventBytes: 0,
      eventReceived: 0,
    };
  }

  private appendEvents(
    pending: PendingReplay,
    frame: Extract<SessionReplayChunk, { encoding: 'events' }>
  ): void {
    const batch = pending.batch;
    if (!batch || pending.eventReceived || (frame.index !== 0 && frame.batch)) {
      throw new Error('Unexpected replay event frame');
    }
    for (const event of frame.replayEvents) {
      pending.received += jsonBytes(event) + (batch.replayEvents.length ? 1 : 0);
      batch.replayEvents.push(event);
    }
  }

  private appendFragment(
    pending: PendingReplay,
    frame: Extract<SessionReplayChunk, { encoding: 'event_fragment' }>
  ): void {
    const batch = pending.batch;
    if (!batch) {
      throw new Error('Event fragment requires a batch envelope');
    }
    if (!pending.eventReceived) {
      pending.eventBytes = frame.eventByteLength;
      pending.received += batch.replayEvents.length ? 1 : 0;
    }
    const decoded = Uint8Array.from(atob(frame.chunk), (char) => char.charCodeAt(0));
    if (
      frame.eventByteLength !== pending.eventBytes ||
      pending.eventReceived + decoded.length > pending.eventBytes
    ) {
      throw new Error('Mismatched event fragment length');
    }
    pending.eventReceived += decoded.length;
    pending.received += decoded.length;
    pending.parts.push(decoded);
    if (pending.eventReceived === pending.eventBytes) {
      batch.replayEvents.push(decodeJson(pending.parts, pending.eventBytes));
      pending.parts = [];
      pending.eventBytes = 0;
      pending.eventReceived = 0;
    }
  }

  private appendFrame(pending: PendingReplay, frame: SessionReplayChunk): void {
    if (frame.encoding === 'events') {
      this.appendEvents(pending, frame);
    } else if (frame.encoding === 'event_fragment') {
      this.appendFragment(pending, frame);
    } else {
      const decoded = Uint8Array.from(atob(frame.chunk), (char) => char.charCodeAt(0));
      pending.received += decoded.length;
      pending.parts.push(decoded);
    }
    if (pending.received > pending.byteLength || pending.received > MAX_REPLAY_BYTES) {
      throw new Error('Replay exceeds its byte limit');
    }
  }

  private acceptChunk(data: unknown, now: number): unknown | null {
    const frame = SessionReplayChunkSchema.parse(data);
    if (jsonBytes(data) > MAX_REPLAY_FRAME_BYTES) {
      throw new Error('Replay frame exceeds its byte limit');
    }
    if (frame.index === 0) {
      this.startReplay(frame, now);
    }
    const pending = this.pending;
    if (
      !pending ||
      pending.id !== frame.replayId ||
      pending.total !== frame.total ||
      pending.byteLength !== frame.byteLength ||
      pending.next !== frame.index ||
      frame.index >= frame.total ||
      now - pending.startedAt > MAX_REPLAY_AGE_MS ||
      (pending.batch !== null) !== (frame.encoding !== undefined)
    ) {
      // Reconnects and superseding loads strand the rest of an older sequence.
      this.reset();
      return null;
    }
    this.appendFrame(pending, frame);
    pending.next++;
    if (pending.next < pending.total) {
      return null;
    }
    this.reset();
    if (pending.received !== pending.byteLength || pending.eventReceived) {
      throw new Error('Replay ended before its declared byte length');
    }
    return SessionReplayBatchSchema.parse(
      pending.batch ?? decodeJson(pending.parts, pending.received)
    );
  }
}
