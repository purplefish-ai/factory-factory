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
type ReplayHeader = NonNullable<Extract<ReplayChunk, { encoding: 'events' }>['batch']>;

/** A replay wire frame with its JSON; `json` is exactly `JSON.stringify(payload)`. */
export interface SerializedReplayFrame {
  payload: WebSocketMessage;
  json: string;
}

/** A batch whose events were each serialized exactly once. */
interface SerializedBatch {
  /** UTF-8 length of `JSON.stringify(batch)`. */
  byteLength: number;
  /** `{ ...batch, replayEvents: [] }` and its JSON. */
  header: ReplayHeader;
  headerJson: string;
  /** Builds `JSON.stringify(batch)` from the serialized pieces. */
  fullJson: () => string;
  events: readonly unknown[];
  eventJson: readonly string[];
  eventBytes: readonly number[];
}

function serializeEvent(event: unknown): string {
  // Like JSON arrays, encode a value that has no JSON form as null.
  const json: string | undefined = JSON.stringify(event);
  return json ?? 'null';
}

function serializeBatch(batch: ReplayBatch): SerializedBatch {
  const header: ReplayHeader = { ...batch, replayEvents: [] };
  const events = batch.replayEvents;
  if (events === undefined) {
    const json = JSON.stringify(batch);
    return {
      byteLength: Buffer.byteLength(json),
      header,
      headerJson: JSON.stringify(header),
      fullJson: () => json,
      events: [],
      eventJson: [],
      eventBytes: [],
    };
  }
  // Serialize the metadata around a unique placeholder, keeping its key order,
  // so each event's JSON can be spliced in without serializing it again.
  const placeholder = `replay-events-${randomUUID()}`;
  const placeholderJson = JSON.stringify(placeholder);
  const shell = JSON.stringify({ ...batch, replayEvents: placeholder });
  const at = shell.indexOf(placeholderJson);
  const before = shell.slice(0, at);
  const after = shell.slice(at + placeholderJson.length);
  const eventJson = Array.from(events, serializeEvent);
  const eventBytes = eventJson.map((json) => Buffer.byteLength(json));
  // Metadata, brackets, events and the commas between them.
  let byteLength = Buffer.byteLength(before) + Buffer.byteLength(after) + 2;
  for (const bytes of eventBytes) {
    byteLength += bytes;
  }
  byteLength += Math.max(0, events.length - 1);
  return {
    byteLength,
    header,
    headerJson: `${before}[]${after}`,
    fullJson: () => `${before}[${eventJson.join(',')}]${after}`,
    events,
    eventJson,
    eventBytes,
  };
}

/** Equals `JSON.stringify({ ...envelope, encoding: 'events', batch?, replayEvents })`. */
function eventFrameJson(
  envelope: SessionReplayEnvelope,
  headerJson: string | undefined,
  eventJson: readonly string[]
): string {
  const head = JSON.stringify({ ...envelope, encoding: 'events' }).slice(0, -1);
  const batch = headerJson === undefined ? '' : `,"batch":${headerJson}`;
  return `${head}${batch},"replayEvents":[${eventJson.join(',')}]}`;
}

/** A frame awaiting its final index and total; event frames hold an event range. */
type PackedFrame =
  | { encoding: 'events'; header: boolean; start: number; end: number }
  | { encoding: 'bytes'; frame: ReplayChunk };

function fragmentBytes(
  bytes: Buffer,
  envelope: SessionReplayEnvelope,
  eventByteLength?: number
): PackedFrame[] {
  const frames: PackedFrame[] = [];
  for (let offset = 0; offset < bytes.length; offset += REPLAY_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + REPLAY_CHUNK_BYTES).toString('base64');
    frames.push({
      encoding: 'bytes',
      frame:
        eventByteLength === undefined
          ? { ...envelope, chunk }
          : { ...envelope, encoding: 'event_fragment', eventByteLength, chunk },
    });
  }
  return frames;
}

function packEvents(
  serialized: SerializedBatch,
  envelope: SessionReplayEnvelope
): PackedFrame[] | null {
  const { eventBytes, eventJson } = serialized;
  let frame: Extract<PackedFrame, { encoding: 'events' }> = {
    encoding: 'events',
    header: true,
    start: 0,
    end: 0,
  };
  let frameBytes = Buffer.byteLength(eventFrameJson(envelope, serialized.headerJson, []));
  if (frameBytes > MAX_REPLAY_FRAME_BYTES) {
    return null;
  }
  const emptyFrameBytes = Buffer.byteLength(eventFrameJson(envelope, undefined, []));
  const frames: PackedFrame[] = [];
  const flush = (next: number) => {
    if (frame.header || frame.end > frame.start) {
      frames.push(frame);
    }
    frame = { encoding: 'events', header: false, start: next, end: next };
    frameBytes = emptyFrameBytes;
  };
  for (const [index, bytes] of eventBytes.entries()) {
    if (frameBytes + bytes + (frame.end > frame.start ? 1 : 0) > MAX_REPLAY_FRAME_BYTES) {
      flush(index);
    }
    if (frameBytes + bytes > MAX_REPLAY_FRAME_BYTES) {
      // Only an event too large for an empty frame reaches this branch.
      frames.push(...fragmentBytes(Buffer.from(eventJson[index] ?? 'null'), envelope, bytes));
      frame.start = index + 1;
      frame.end = index + 1;
    } else {
      frameBytes += bytes + (frame.end > frame.start ? 1 : 0);
      frame.end = index + 1;
    }
  }
  flush(eventBytes.length);
  return frames;
}

function finishFrame(
  packed: PackedFrame,
  serialized: SerializedBatch,
  envelope: SessionReplayEnvelope
): SerializedReplayFrame {
  if (packed.encoding === 'bytes') {
    const payload = { ...packed.frame, index: envelope.index, total: envelope.total };
    return { payload, json: JSON.stringify(payload) };
  }
  const payload: ReplayChunk = {
    ...envelope,
    encoding: 'events',
    ...(packed.header ? { batch: serialized.header } : {}),
    replayEvents: serialized.events.slice(packed.start, packed.end),
  };
  const json = eventFrameJson(
    envelope,
    packed.header ? serialized.headerJson : undefined,
    serialized.eventJson.slice(packed.start, packed.end)
  );
  return { payload, json };
}

/**
 * Keep ordinary events as JSON; fragment only an event too large for one frame.
 * Each event is serialized once, and every frame carries its wire JSON so
 * delivery does not serialize it again. All frames are packed before the first
 * is yielded, so an over-limit replay throws before anything is published.
 */
export function* frameSessionReplay(batch: ReplayBatch): Generator<SerializedReplayFrame> {
  const serialized = serializeBatch(batch);
  if (serialized.byteLength <= MAX_REPLAY_FRAME_BYTES) {
    yield { payload: batch, json: serialized.fullJson() };
    return;
  }
  if (serialized.byteLength > MAX_REPLAY_BYTES) {
    throw new SessionReplayLimitError('Session replay exceeds the 128 MiB transport limit');
  }
  // Reserve the largest possible index/total envelope before packing events.
  const envelope: SessionReplayEnvelope = {
    type: 'session_replay_chunk',
    replayId: randomUUID(),
    ...(batch.loadRequestId !== undefined && batch.loadRequestId.length <= 128
      ? { loadRequestId: batch.loadRequestId }
      : {}),
    index: MAX_REPLAY_BYTES,
    total: MAX_REPLAY_BYTES,
    byteLength: serialized.byteLength,
  };
  // An unusually large batch envelope itself must use the legacy byte stream.
  const frames =
    packEvents(serialized, envelope) ??
    fragmentBytes(Buffer.from(serialized.fullJson(), 'utf8'), envelope);
  for (const [index, packed] of frames.entries()) {
    yield finishFrame(packed, serialized, { ...envelope, index, total: frames.length });
  }
}
