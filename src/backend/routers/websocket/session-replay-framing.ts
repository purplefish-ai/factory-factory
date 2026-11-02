import { randomUUID } from 'node:crypto';
import type { WebSocketMessage } from '@/shared/acp-protocol';
import {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_FRAME_BYTES,
  REPLAY_CHUNK_BYTES,
  type SessionReplayEnvelope,
} from '@/shared/acp-protocol/protocol/replay-frame-schema';

export class SessionReplayLimitError extends Error {}

type ReplayBatch = Extract<WebSocketMessage, { type: 'session_replay_batch' }>;
type ReplayChunk = Extract<WebSocketMessage, { type: 'session_replay_chunk' }>;
type EventFrame = Extract<ReplayChunk, { encoding: 'events' }>;

function fragmentBytes(
  bytes: Buffer,
  envelope: SessionReplayEnvelope,
  eventByteLength?: number
): ReplayChunk[] {
  const frames: ReplayChunk[] = [];
  for (let offset = 0; offset < bytes.length; offset += REPLAY_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + REPLAY_CHUNK_BYTES).toString('base64');
    frames.push(
      eventByteLength === undefined
        ? { ...envelope, chunk }
        : { ...envelope, encoding: 'event_fragment', eventByteLength, chunk }
    );
  }
  return frames;
}

function packEvents(batch: ReplayBatch, envelope: SessionReplayEnvelope): ReplayChunk[] | null {
  const header = { ...batch, replayEvents: [] };
  let frame: EventFrame = { ...envelope, encoding: 'events', batch: header, replayEvents: [] };
  let frameBytes = Buffer.byteLength(JSON.stringify(frame));
  if (frameBytes > MAX_REPLAY_FRAME_BYTES) {
    return null;
  }
  const frames: ReplayChunk[] = [];
  const flush = () => {
    if (frame.batch || frame.replayEvents.length) {
      frames.push(frame);
    }
    frame = { ...envelope, encoding: 'events', replayEvents: [] };
    frameBytes = Buffer.byteLength(JSON.stringify(frame));
  };
  for (const event of batch.replayEvents ?? []) {
    const json = JSON.stringify(event);
    const eventBytes = Buffer.byteLength(json);
    if (frameBytes + eventBytes + (frame.replayEvents.length ? 1 : 0) > MAX_REPLAY_FRAME_BYTES) {
      flush();
    }
    if (frameBytes + eventBytes > MAX_REPLAY_FRAME_BYTES) {
      frames.push(...fragmentBytes(Buffer.from(json), envelope, eventBytes));
    } else {
      frameBytes += eventBytes + (frame.replayEvents.length ? 1 : 0);
      frame.replayEvents.push(event);
    }
  }
  flush();
  return frames;
}

/** Keep ordinary events as JSON; fragment only an event too large for one frame. */
export function* frameSessionReplay(batch: ReplayBatch): Generator<WebSocketMessage> {
  const bytes = Buffer.from(JSON.stringify(batch), 'utf8');
  if (bytes.length <= MAX_REPLAY_FRAME_BYTES) {
    yield batch;
    return;
  }
  if (bytes.length > MAX_REPLAY_BYTES) {
    throw new SessionReplayLimitError('Session replay exceeds the 128 MiB transport limit');
  }
  // Reserve the largest possible index/total envelope before packing events.
  const envelope: SessionReplayEnvelope = {
    type: 'session_replay_chunk',
    replayId: randomUUID(),
    index: MAX_REPLAY_BYTES,
    total: MAX_REPLAY_BYTES,
    byteLength: bytes.length,
  };
  // An unusually large batch envelope itself must use the legacy byte stream.
  const frames = packEvents(batch, envelope) ?? fragmentBytes(bytes, envelope);
  for (const [index, part] of frames.entries()) {
    yield { ...part, index, total: frames.length };
  }
}
