import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SessionDeltaEvent, WebSocketMessage } from '@/shared/acp-protocol';
import {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_FRAME_BYTES,
  REPLAY_CHUNK_BYTES,
  type SessionReplayEnvelope,
} from '@/shared/acp-protocol/protocol/replay-frame-schema';
import { SessionReplayAssembler } from '@/shared/acp-protocol/protocol/replay-framing';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { frameSessionReplay } from './session-replay-framing';

type ReplayBatch = Extract<WebSocketMessage, { type: 'session_replay_batch' }>;
type ReplayChunk = Extract<WebSocketMessage, { type: 'session_replay_chunk' }>;
type EventFrame = Extract<ReplayChunk, { encoding: 'events' }>;

// Oracle: the framing before events were serialized once, verbatim. Its frames
// were serialized again by the transport.
function legacyFragmentBytes(
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

function legacyPackEvents(
  batch: ReplayBatch,
  envelope: SessionReplayEnvelope
): ReplayChunk[] | null {
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
      frames.push(...legacyFragmentBytes(Buffer.from(json), envelope, eventBytes));
    } else {
      frameBytes += eventBytes + (frame.replayEvents.length ? 1 : 0);
      frame.replayEvents.push(event);
    }
  }
  flush();
  return frames;
}

function* legacyFrameSessionReplay(batch: ReplayBatch): Generator<WebSocketMessage> {
  const bytes = Buffer.from(JSON.stringify(batch), 'utf8');
  if (bytes.length <= MAX_REPLAY_FRAME_BYTES) {
    yield batch;
    return;
  }
  if (bytes.length > MAX_REPLAY_BYTES) {
    throw new Error('Session replay exceeds the 128 MiB transport limit');
  }
  const envelope: SessionReplayEnvelope = {
    type: 'session_replay_chunk',
    replayId: randomUUID(),
    ...(batch.loadRequestId !== undefined && batch.loadRequestId.length <= 128
      ? { loadRequestId: batch.loadRequestId }
      : {}),
    index: MAX_REPLAY_BYTES,
    total: MAX_REPLAY_BYTES,
    byteLength: bytes.length,
  };
  const frames = legacyPackEvents(batch, envelope) ?? legacyFragmentBytes(bytes, envelope);
  for (const [index, part] of frames.entries()) {
    yield { ...part, index, total: frames.length };
  }
}

/** Replay ids are random per call; everything else on the wire must match. */
function withoutReplayId(json: string): string {
  return json.replace(/^\{"type":"session_replay_chunk","replayId":"[^"]+"/, '{"replayId":""');
}

function legacyWire(batch: ReplayBatch): string[] {
  return [...legacyFrameSessionReplay(batch)].map((frame) => JSON.stringify(frame));
}

function message(order: number, text: string) {
  return {
    type: 'agent_message' as const,
    messageId: `message-${order}`,
    order,
    data: { type: 'assistant' as const, text },
  };
}

const unicode = '👋 "quoted" \\ back\nslash é   \ud800 lone surrogate ';

const cases: [string, () => ReplayBatch][] = [
  ['an empty batch', () => ({ type: 'session_replay_batch', replayEvents: [] })],
  [
    'a small batch with unicode and extra metadata',
    () => ({
      type: 'session_replay_batch',
      loadRequestId: 'small',
      replayEvents: [message(1, unicode), message(2, 'plain')],
      sessionId: 'kept',
    }),
  ],
  [
    'a batch over the frame limit',
    () => ({
      type: 'session_replay_batch',
      loadRequestId: 'large',
      replayEvents: Array.from({ length: 1000 }, (_, order) => message(order, unicode.repeat(8))),
    }),
  ],
  [
    'events before, between and after events larger than a frame',
    () => ({
      type: 'session_replay_batch',
      replayEvents: [
        message(1, 'before'),
        message(2, unicode.repeat(12_000)),
        message(3, unicode.repeat(12_000)),
        message(4, 'between'),
        message(5, 'x'.repeat(MAX_REPLAY_FRAME_BYTES * 3)),
        ...Array.from({ length: 300 }, (_, order) => message(order + 6, unicode.repeat(4))),
      ],
      loadRequestId: 'fragments',
    }),
  ],
  [
    'metadata too large for an event frame',
    () => ({
      type: 'session_replay_batch',
      loadRequestId: 'metadata',
      permissionMode: unicode.repeat(4000),
      replayEvents: [message(1, 'after large metadata')],
    }),
  ],
  [
    'large metadata with omitted events',
    () => ({ type: 'session_replay_batch', loadRequestId: 'x'.repeat(150_000) }),
  ],
  [
    'an overlong load request id',
    () => ({
      type: 'session_replay_batch',
      loadRequestId: 'y'.repeat(129),
      replayEvents: Array.from({ length: 200 }, (_, order) => message(order, unicode.repeat(8))),
    }),
  ],
];

describe('frameSessionReplay single serialization', () => {
  it.each(cases)('matches the legacy wire frames for %s', (_name, build) => {
    const batch = build();
    const legacy = legacyWire(batch);
    const current = [...frameSessionReplay(batch)];
    for (const frame of current) {
      expect(frame.json).toBe(JSON.stringify(frame.payload));
    }
    expect(current.map((frame) => withoutReplayId(frame.json))).toEqual(
      legacy.map(withoutReplayId)
    );
    expect(current.map((frame) => JSON.parse(withoutReplayId(frame.json)))).toEqual(
      legacy.map((json) => JSON.parse(withoutReplayId(json)))
    );
    const assembler = new SessionReplayAssembler();
    let replay: unknown = null;
    for (const frame of current) {
      expect(Buffer.byteLength(frame.json)).toBeLessThanOrEqual(MAX_REPLAY_FRAME_BYTES);
      replay = assembler.accept(JSON.parse(frame.json));
    }
    expect(replay).toEqual(JSON.parse(JSON.stringify(batch)));
  });

  it('declares the byte length of the whole batch, as before', () => {
    const [, build] = cases[3]!;
    const batch = build();
    const [first] = [...frameSessionReplay(batch)];
    expect(first?.payload).toMatchObject({
      type: 'session_replay_chunk',
      byteLength: Buffer.byteLength(JSON.stringify(batch)),
    });
  });

  it('serializes each event once while framing', () => {
    const calls: number[] = [];
    const replayEvents = Array.from({ length: 400 }, (_, order) => ({
      toJSON: () => {
        calls.push(order);
        return message(order, unicode.repeat(order === 7 ? 10_000 : 8));
      },
    }));
    // Counting events stand in for the events their toJSON returns.
    const frames = [
      ...frameSessionReplay({
        type: 'session_replay_batch',
        loadRequestId: 'once',
        replayEvents: unsafeCoerce<SessionDeltaEvent[]>(replayEvents),
      }),
    ];
    expect(frames.length).toBeGreaterThan(1);
    expect(calls).toEqual(replayEvents.map((_, order) => order));
  });
});
