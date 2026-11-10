import { expect, it, vi } from 'vitest';
import type { WebSocketMessage } from '@/shared/acp-protocol';
import { frameSessionReplay, SessionReplayLimitError } from './session-replay-framing';

const { LIMIT } = vi.hoisted(() => ({ LIMIT: 1024 * 1024 }));

// A small total limit lets the boundary be tested without a 128 MiB replay.
vi.mock('@/shared/acp-protocol/protocol/replay-frame-schema', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MAX_REPLAY_BYTES: LIMIT,
}));

type ReplayBatch = Extract<WebSocketMessage, { type: 'session_replay_batch' }>;

/** A batch whose JSON is exactly `bytes` long, spread over several events. */
function batchOfBytes(bytes: number): ReplayBatch {
  const event = (text: string) => ({ type: 'task_notification' as const, message: text });
  const replayEvents = Array.from({ length: 8 }, () => event('x'.repeat(100_000)));
  const batch: ReplayBatch = { type: 'session_replay_batch', loadRequestId: 'limit', replayEvents };
  // The final event adds a comma and its own JSON around a two-byte-per-char text.
  const missing =
    bytes - Buffer.byteLength(JSON.stringify(batch)) - 1 - JSON.stringify(event('')).length;
  replayEvents.push(event('é'.repeat(Math.floor(missing / 2)) + 'x'.repeat(missing % 2)));
  return batch;
}

it('frames a replay of exactly the total limit and rejects one byte more before yielding', () => {
  const atLimit = batchOfBytes(LIMIT);
  expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(LIMIT);
  const frames = [...frameSessionReplay(atLimit)];
  expect(frames.length).toBeGreaterThan(1);
  expect(frames[0]?.payload).toMatchObject({ byteLength: LIMIT });

  const overLimit = batchOfBytes(LIMIT + 1);
  expect(Buffer.byteLength(JSON.stringify(overLimit))).toBe(LIMIT + 1);
  const replay = frameSessionReplay(overLimit);
  expect(() => replay.next()).toThrow(SessionReplayLimitError);
});
