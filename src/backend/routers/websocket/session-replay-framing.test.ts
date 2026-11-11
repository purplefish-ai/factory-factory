import { expect, it, vi } from 'vitest';
import { MessageState, type WebSocketMessage } from '@/shared/acp-protocol';
import { SessionReplayChunkSchema } from '@/shared/acp-protocol/protocol/replay-frame-schema';
import {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_FRAME_BYTES,
  SessionReplayAssembler,
} from '@/shared/acp-protocol/protocol/replay-framing';
import { frameSessionReplay } from './session-replay-framing';

function framePayloads(batch: Extract<WebSocketMessage, { type: 'session_replay_batch' }>) {
  return [...frameSessionReplay(batch)].map((frame) => frame.payload);
}

function largeBatch(): Extract<WebSocketMessage, { type: 'session_replay_batch' }> {
  return {
    type: 'session_replay_batch',
    loadRequestId: 'current-load',
    replayEvents: [
      {
        type: 'agent_message',
        messageId: 'original-id',
        order: 42,
        data: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'original-call',
                content: '👋\\"\n'.repeat(100_000),
              },
            ],
          },
        },
      },
      { type: 'message_state_changed', id: 'original-user', newState: MessageState.COMMITTED },
    ],
  };
}

it('bounds UTF8 frames and reconstructs the complete atomic batch, identities and order', () => {
  const batch = largeBatch();
  const frames = framePayloads(batch);
  expect(frames.length).toBeGreaterThan(1);
  expect(
    frames.every((frame) => Buffer.byteLength(JSON.stringify(frame)) <= MAX_REPLAY_FRAME_BYTES)
  ).toBe(true);
  const assembler = new SessionReplayAssembler();
  for (const frame of frames.slice(0, -1)) {
    expect(assembler.accept(frame)).toBeNull();
  }
  expect(assembler.accept(frames.at(-1))).toEqual(batch);
});

it('keeps small legacy batches unchanged', () => {
  const batch = { type: 'session_replay_batch', replayEvents: [] } as const;
  expect(framePayloads({ ...batch, replayEvents: [] })).toEqual([batch]);
});

it('reports malformed replay frames but not chunks stranded by a superseded replay', () => {
  const frames = framePayloads(largeBatch());
  const onInvalidFrame = vi.fn();
  const assembler = new SessionReplayAssembler(onInvalidFrame);
  expect(assembler.accept(frames[1])).toBeNull();
  assembler.accept(frames[0]);
  expect(assembler.accept(frames[2])).toBeNull();
  expect(onInvalidFrame).not.toHaveBeenCalled();

  expect(assembler.accept({ ...frames[0], replayId: '' })).toBeNull();
  expect(onInvalidFrame).toHaveBeenCalledOnce();
  expect(assembler.accept({ type: 'session_replay_chunk', index: 0 })).toBeNull();
  expect(onInvalidFrame).toHaveBeenCalledTimes(2);
});

it('drops interrupted, reordered, expired and oversized batches and accepts a fresh replay', () => {
  const frames = framePayloads(largeBatch());
  const assembler = new SessionReplayAssembler();
  expect(assembler.accept(frames[0], 0)).toBeNull();
  expect(assembler.accept(frames[2], 1)).toBeNull();
  expect(assembler.accept(frames[1], 2)).toBeNull();
  assembler.accept(frames[0], 0);
  expect(assembler.accept(frames[1], 30_001)).toBeNull();
  assembler.accept(frames[0]);
  assembler.reset(); // reconnect or session replacement
  expect(assembler.accept(frames[1])).toBeNull();
  expect(assembler.accept({ ...frames[0], byteLength: MAX_REPLAY_BYTES + 1 })).toBeNull();
  const firstFragment = frames.findIndex(
    (frame) => frame.type === 'session_replay_chunk' && frame.encoding === 'event_fragment'
  );
  expect(firstFragment).toBeGreaterThan(0);
  for (const frame of frames.slice(0, firstFragment)) {
    expect(assembler.accept(frame)).toBeNull();
  }
  const fragment = frames[firstFragment]!;
  expect(SessionReplayChunkSchema.safeParse(fragment).success).toBe(true);
  expect(assembler.accept({ ...fragment, chunk: 'invalid base64' })).toBeNull();
  let replay: unknown;
  for (const frame of frames) {
    replay = assembler.accept(frame);
  }
  expect(replay).toEqual(largeBatch());
});

it('releases an incomplete replay after the timeout', () => {
  vi.useFakeTimers();
  try {
    const frames = framePayloads(largeBatch());
    const assembler = new SessionReplayAssembler();
    assembler.accept(frames[0]);
    vi.advanceTimersByTime(30_000);
    expect(assembler.accept(frames[1])).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('rejects a complete sequence with a mismatched declared byte length', () => {
  const frames = framePayloads(largeBatch());
  const assembler = new SessionReplayAssembler();
  let replay: unknown;
  for (const frame of frames) {
    expect(frame.type).toBe('session_replay_chunk');
    if (frame.type === 'session_replay_chunk') {
      replay = assembler.accept({ ...frame, byteLength: frame.byteLength + 1 });
    }
  }
  expect(replay).toBeNull();
});

function ordinaryBatch(): Extract<WebSocketMessage, { type: 'session_replay_batch' }> {
  // Framing preserves envelope keys outside the declared contract.
  const batch = {
    type: 'session_replay_batch' as const,
    loadRequestId: 'ordinary-load',
    sessionId: 'preserved-session',
    dbSessionId: 'preserved-db-session',
    replayEvents: Array.from({ length: 1000 }, (_, order) => ({
      type: 'agent_message' as const,
      messageId: `message-${order}`,
      order,
      data: {
        type: 'assistant' as const,
        text: 'ordinary 👋 text with "quotes" and newline\n'.repeat(20),
      },
    })),
  };
  return batch;
}

it('keeps ordinary event frames close to original JSON bandwidth and preserves all metadata', () => {
  const batch = ordinaryBatch();
  const frames = framePayloads(batch);
  const originalBytes = Buffer.byteLength(JSON.stringify(batch));
  const frameBytes = frames.map((frame) => Buffer.byteLength(JSON.stringify(frame)));
  expect(frames.length).toBeGreaterThan(1);
  expect(Math.max(...frameBytes)).toBeLessThanOrEqual(MAX_REPLAY_FRAME_BYTES);
  expect(frameBytes.reduce((sum, size) => sum + size, 0)).toBeLessThan(originalBytes * 1.02);
  const assembler = new SessionReplayAssembler();
  for (const frame of frames.slice(0, -1)) {
    expect(assembler.accept(frame)).toBeNull();
  }
  expect(assembler.accept(frames.at(-1))).toEqual(batch);
});

it('preserves normal events around adjacent oversized UTF8 events atomically', () => {
  const batch = ordinaryBatch();
  batch.replayEvents?.splice(3, 0, largeBatch().replayEvents![0]!, largeBatch().replayEvents![0]!);
  const frames = framePayloads(batch);
  const assembler = new SessionReplayAssembler();
  for (const frame of frames.slice(0, -1)) {
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(MAX_REPLAY_FRAME_BYTES);
    expect(assembler.accept(frame)).toBeNull();
  }
  expect(assembler.accept(frames.at(-1))).toEqual(batch);
});

it('fragments the envelope when unusually large metadata cannot fit in a JSON event frame', () => {
  const batch = { ...largeBatch(), loadRequestId: '👋\\"\n'.repeat(40_000) };
  const assembler = new SessionReplayAssembler();
  const frames = framePayloads(batch);
  for (const frame of frames.slice(0, -1)) {
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(MAX_REPLAY_FRAME_BYTES);
    expect(assembler.accept(frame)).toBeNull();
  }
  expect(assembler.accept(frames.at(-1))).toEqual(batch);
});

it('rejects oversized JSON envelopes and resets before accepting another replay', () => {
  const frames = framePayloads(ordinaryBatch());
  const assembler = new SessionReplayAssembler();
  const batch = ordinaryBatch();
  const oversized = {
    type: 'session_replay_chunk',
    replayId: 'oversized-json',
    index: 0,
    total: 1,
    byteLength: Buffer.byteLength(JSON.stringify(batch)),
    encoding: 'events',
    batch: { ...batch, replayEvents: [] },
    replayEvents: batch.replayEvents,
  };
  expect(SessionReplayChunkSchema.safeParse(oversized).success).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(MAX_REPLAY_FRAME_BYTES);
  expect(assembler.accept(oversized)).toBeNull();
  for (const frame of frames.slice(1)) {
    expect(assembler.accept(frame)).toBeNull();
  }
  for (const frame of frames.slice(0, -1)) {
    expect(assembler.accept(frame)).toBeNull();
  }
  expect(assembler.accept(frames.at(-1))).toEqual(ordinaryBatch());
});

it('rejects corrupt event fragments without publishing any of the surrounding events', () => {
  const frames = framePayloads(largeBatch());
  const firstFragment = frames.findIndex(
    (frame) => frame.type === 'session_replay_chunk' && frame.encoding === 'event_fragment'
  );
  expect(firstFragment).toBeGreaterThan(0);
  const assembler = new SessionReplayAssembler();
  for (const [index, frame] of frames.entries()) {
    expect(
      assembler.accept(index === firstFragment ? { ...frame, chunk: '////' } : frame)
    ).toBeNull();
  }
});

it('invalidates an interrupted replay when a complete legacy batch replaces it', () => {
  const frames = framePayloads(ordinaryBatch());
  const assembler = new SessionReplayAssembler();
  expect(assembler.accept(frames[0])).toBeNull();
  const replacement = { type: 'session_replay_batch', replayEvents: [] };
  expect(assembler.accept(replacement)).toEqual(replacement);
  for (const frame of frames.slice(1)) {
    expect(assembler.accept(frame)).toBeNull();
  }
});

it('preserves a legacy batch with omitted events and oversized metadata', () => {
  const batch = { type: 'session_replay_batch' as const, loadRequestId: 'x'.repeat(150_000) };
  const frames = framePayloads(batch);
  const assembler = new SessionReplayAssembler();
  for (const frame of frames.slice(0, -1)) {
    expect(assembler.accept(frame)).toBeNull();
  }
  expect(assembler.accept(frames.at(-1))).toEqual(batch);
});

it('rejects incomplete or mixed wire variants in both the producer contract and receiver', () => {
  type ReplayChunk = Extract<WebSocketMessage, { type: 'session_replay_chunk' }>;
  const envelope = {
    type: 'session_replay_chunk' as const,
    replayId: 'invalid-variant',
    index: 0,
    total: 1,
    byteLength: 1,
  };
  // @ts-expect-error Fragment frames require the complete event byte length.
  const missingLength: ReplayChunk = { ...envelope, encoding: 'event_fragment', chunk: 'YQ==' };
  // @ts-expect-error JSON event frames cannot carry base64 payloads.
  const mixedEvents: ReplayChunk = {
    ...envelope,
    encoding: 'events',
    replayEvents: [],
    chunk: 'YQ==',
  };
  // @ts-expect-error Legacy base64 frames require their payload.
  const missingLegacyPayload: ReplayChunk = { ...envelope };
  const assembler = new SessionReplayAssembler();
  for (const frame of [missingLength, mixedEvents, missingLegacyPayload]) {
    expect(SessionReplayChunkSchema.safeParse(frame).success).toBe(false);
    expect(assembler.accept(frame)).toBeNull();
  }
});

it('rejects oversized direct legacy batches and resets interrupted assembly', () => {
  const frames = framePayloads(ordinaryBatch());
  const assembler = new SessionReplayAssembler();
  expect(assembler.accept(frames[0])).toBeNull();
  const oversized = ordinaryBatch();
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(MAX_REPLAY_FRAME_BYTES);
  expect(assembler.accept(oversized)).toBeNull();
  for (const frame of frames.slice(1)) {
    expect(assembler.accept(frame)).toBeNull();
  }
  for (const frame of frames.slice(0, -1)) {
    expect(assembler.accept(frame)).toBeNull();
  }
  expect(assembler.accept(frames.at(-1))).toEqual(ordinaryBatch());
});

it('measures each received event once while still bounding frames and the replay total', () => {
  let measured = 0;
  const counted = (event: unknown) => ({
    toJSON: () => {
      measured++;
      return event;
    },
  });
  const batch = ordinaryBatch();
  const frames = framePayloads(batch).map((frame) =>
    frame.type === 'session_replay_chunk' && frame.encoding === 'events'
      ? { ...frame, replayEvents: frame.replayEvents.map(counted) }
      : frame
  );
  const assembler = new SessionReplayAssembler();
  let replay: unknown = null;
  for (const frame of frames) {
    replay = assembler.accept(frame);
  }
  expect(measured).toBe(batch.replayEvents!.length);
  expect(JSON.parse(JSON.stringify(replay))).toEqual(batch);

  // The frame bound still counts every event byte.
  const [first] = framePayloads(batch);
  const overfull =
    first?.type === 'session_replay_chunk' && first.encoding === 'events'
      ? { ...first, replayEvents: batch.replayEvents }
      : null;
  const onInvalidFrame = vi.fn();
  expect(new SessionReplayAssembler(onInvalidFrame).accept(overfull)).toBeNull();
  expect(onInvalidFrame).toHaveBeenCalledWith(new Error('Replay frame exceeds its byte limit'));
});
