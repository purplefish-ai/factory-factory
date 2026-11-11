import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ApplicationServices } from '@/backend/app-context';
import { SessionEventBus } from '@/backend/services/session';
import type { SessionDeltaEvent, WebSocketMessage } from '@/shared/acp-protocol';
import { SessionReplayAssembler } from '@/shared/acp-protocol/protocol/replay-framing';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  attachChatTransport,
  ChatConnectionRegistry,
  detachChatTransport,
} from './chat-connection-registry';
import { frameSessionReplay } from './session-replay-framing';

class Viewer extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  maxBuffered = 0;
  frames: string[] = [];
  writes: { bytes: number; done: (error?: Error) => void }[] = [];
  close = vi.fn();
  terminate = vi.fn();
  send(frame: string, done: (error?: Error) => void) {
    const bytes = Buffer.byteLength(frame);
    this.frames.push(frame);
    this.bufferedAmount += bytes;
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
    this.writes.push({ bytes, done });
  }
  async flush(error?: Error) {
    const write = this.writes.shift();
    if (!write) {
      throw new Error('No pending write');
    }
    this.bufferedAmount -= write.bytes;
    write.done(error);
    await Promise.resolve();
  }
  socket() {
    return unsafeCoerce<WebSocket>(this);
  }
}
const registries: ChatConnectionRegistry[] = [];
afterEach(() => registries.splice(0).forEach(detachChatTransport));
function setup(limit = 32 * 1024 * 1024) {
  const registry = new ChatConnectionRegistry();
  registries.push(registry);
  const bus = new SessionEventBus();
  const log = vi.fn();
  attachChatTransport(
    unsafeCoerce<
      Pick<
        ApplicationServices,
        'configService' | 'createLogger' | 'sessionEventBus' | 'sessionFileLogger'
      >
    >({
      configService: {
        getDebugConfig: () => ({ chatWebSocket: false }),
        getWebSocketConfig: () => ({ maxFrameBytes: limit }),
      },
      createLogger: () => ({ error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
      sessionEventBus: bus,
      sessionFileLogger: { log },
    }),
    registry
  );
  const viewer = new Viewer();
  registry.register('v1', { ws: viewer.socket(), dbSessionId: 's1', workingDir: null });
  registry.expectReplay(viewer.socket(), 'load-1');
  return { registry, bus, log, viewer };
}
function batch(
  loadRequestId = 'load-1'
): Extract<WebSocketMessage, { type: 'session_replay_batch' }> {
  return {
    type: 'session_replay_batch',
    loadRequestId,
    replayEvents: [
      {
        type: 'assistant_text_delta',
        messageId: 'm1',
        order: 1,
        offset: 0,
        text: 'é'.repeat(1024 * 1024),
      },
    ],
  };
}
const delta: WebSocketMessage = {
  type: 'session_delta',
  data: { type: 'slash_commands', slashCommands: [] },
};

it('streams main replay chunks within backlog, then delivers dependent deltas and logs only successful writes', async () => {
  const test = setup();
  const replay = batch();
  for (const frame of frameSessionReplay(replay)) {
    test.bus.publishToSession('s1', frame.payload, frame.json);
  }
  test.registry.expectReplay(test.viewer.socket(), 'load-1');
  for (const frame of frameSessionReplay(replay)) {
    test.bus.publishToSession('s1', frame.payload, frame.json);
  }
  test.bus.publishToSession('s1', delta);
  expect(test.viewer.close).not.toHaveBeenCalled();
  expect(test.log).not.toHaveBeenCalled();
  for (let guard = 0; test.viewer.writes.length && guard < 100; guard++) {
    await test.viewer.flush();
  }
  expect(test.viewer.writes).toHaveLength(0);
  expect(test.viewer.maxBuffered).toBeLessThanOrEqual(1024 * 1024);
  const assembler = new SessionReplayAssembler();
  const received = test.viewer.frames
    .map((frame) => assembler.accept(JSON.parse(frame)))
    .filter((value) => value !== null);
  expect(received).toEqual([replay, delta]);
  expect(test.log).toHaveBeenCalledTimes(test.viewer.frames.length);
});

it('rejects a chunked replay over the configured budget with its correlated error and fences deltas', () => {
  const test = setup(1024 * 1024);
  for (const frame of frameSessionReplay(batch())) {
    test.bus.publishToSession('s1', frame.payload, frame.json);
  }
  test.bus.publishToSession('s1', delta);
  expect(test.viewer.frames).toHaveLength(1);
  expect(JSON.parse(test.viewer.frames[0]!)).toMatchObject({
    type: 'error',
    code: 413,
    loadRequestId: 'load-1',
  });
  expect(test.viewer.close).not.toHaveBeenCalled();
});

it('excludes foreign and duplicate correlated baselines from an active replay backlog', async () => {
  const test = setup();
  const replay = batch();
  for (const frame of frameSessionReplay(replay)) {
    test.bus.publishToSession('s1', frame.payload, frame.json);
  }
  for (let index = 0; index < 12; index++) {
    test.bus.publishToSession('s1', {
      type: 'session_replay_batch',
      loadRequestId: index % 2 ? 'another-viewer' : 'load-1',
      replayEvents: [{ type: 'task_notification', message: 'metadata'.repeat(20_000) }],
    });
  }
  test.bus.publishToSession('s1', delta);
  expect(test.viewer.close).not.toHaveBeenCalled();
  for (let guard = 0; test.viewer.writes.length && guard < 100; guard++) {
    await test.viewer.flush();
  }
  const assembler = new SessionReplayAssembler();
  expect(
    test.viewer.frames
      .map((frame) => assembler.accept(JSON.parse(frame)))
      .filter((value) => value !== null)
  ).toEqual([replay, delta]);
});

it.each([false, true])(
  'routes byte-fragmented metadata to its requester (over budget: %s)',
  async (overBudget) => {
    const test = setup(overBudget ? 1024 * 1024 : undefined);
    const replay = { ...batch(), permissionMode: 'metadata'.repeat(20_000) };
    const frames = [...frameSessionReplay(replay)];
    expect(frames[0]?.payload).toMatchObject({
      type: 'session_replay_chunk',
      chunk: expect.any(String),
    });
    for (const frame of frames) {
      test.bus.publishToSession('s1', frame.payload, frame.json);
    }
    test.bus.publishToSession('s1', delta);
    for (let guard = 0; test.viewer.writes.length && guard < 100; guard++) {
      await test.viewer.flush();
    }
    const assembler = new SessionReplayAssembler();
    const received = test.viewer.frames
      .map((frame) => assembler.accept(JSON.parse(frame)))
      .filter((value) => value !== null);
    if (overBudget) {
      expect(received).toEqual([
        expect.objectContaining({ type: 'error', code: 413, loadRequestId: 'load-1' }),
      ]);
    } else {
      expect(received).toEqual([replay, delta]);
    }
    expect(test.viewer.close).not.toHaveBeenCalled();
  }
);

it('settles an older concurrent request before a late oversized replay is filtered', () => {
  const test = setup(1024 * 1024);
  test.registry.expectReplay(test.viewer.socket(), 'load-2');
  test.bus.publishToSession('s1', batch('load-1'));
  test.bus.publishToSession('s1', {
    type: 'session_replay_batch',
    loadRequestId: 'load-2',
    replayEvents: [],
  });
  const frames = test.viewer.frames.map((frame) => JSON.parse(frame));
  expect(frames[0]).toMatchObject({ type: 'error', code: 409, loadRequestId: 'load-1' });
  expect(frames[1]).toMatchObject({ type: 'session_replay_batch', loadRequestId: 'load-2' });
  expect(test.viewer.close).not.toHaveBeenCalled();
});

it.each([
  ['legacy', undefined],
  ['legacy', new Error('write failed')],
  ['chunks', undefined],
  ['chunks', new Error('write failed')],
] as const)(
  'does not log a coalesced or failed %s write as delivered (%s)',
  async (variant, error) => {
    const test = setup();
    if (variant === 'legacy') {
      test.bus.publishToSession('s1', batch());
    } else {
      for (const frame of frameSessionReplay(batch())) {
        test.bus.publishToSession('s1', frame.payload, frame.json);
      }
    }
    test.registry.expectReplay(test.viewer.socket(), 'load-1');
    if (variant === 'legacy') {
      expect(test.registry.broadcastToSession('s1', batch())).toBe(0);
    } else {
      for (const frame of frameSessionReplay(batch())) {
        expect(test.registry.broadcastToSession('s1', frame.payload, undefined, frame.json)).toBe(
          0
        );
      }
    }
    expect(test.log).not.toHaveBeenCalled();
    await test.viewer.flush(error);
    expect(test.log).toHaveBeenCalledTimes(error ? 0 : 1);
    test.viewer.emit('close');
  }
);

it('retires a stalled replay when dependent backlog exceeds the budget and terminates by the deadline', () => {
  vi.useFakeTimers();
  try {
    const test = setup();
    for (const frame of frameSessionReplay(batch())) {
      test.bus.publishToSession('s1', frame.payload, frame.json);
    }
    const update: WebSocketMessage = {
      type: 'session_delta',
      data: {
        type: 'assistant_text_delta',
        messageId: 'm1',
        order: 1,
        offset: 0,
        text: 'x'.repeat(256 * 1024),
      },
    };
    for (let i = 0; i < 4; i++) {
      test.bus.publishToSession('s1', update);
    }
    expect(test.viewer.close).toHaveBeenCalledExactlyOnceWith(1013, expect.any(String));
    expect(test.viewer.frames).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(test.viewer.terminate).toHaveBeenCalledTimes(1);
    expect(test.viewer.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('fails closed on a mismatched replay sequence instead of allowing deltas after a missing baseline', () => {
  vi.useFakeTimers();
  try {
    const test = setup();
    const frames = [...frameSessionReplay(batch())];
    test.bus.publishToSession('s1', frames[0]!.payload, frames[0]!.json);
    const next = frames[1]?.payload;
    if (next?.type !== 'session_replay_chunk') {
      throw new Error('Expected chunks');
    }
    test.bus.publishToSession('s1', { ...next, index: next.index + 1 });
    test.bus.publishToSession('s1', delta);
    expect(test.viewer.close).toHaveBeenCalledExactlyOnceWith(1013, expect.any(String));
    expect(test.viewer.frames).toHaveLength(1);
    expect(test.log).not.toHaveBeenCalled();
    test.viewer.emit('close');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('delivers framed replay JSON verbatim, serializing each event once end to end', async () => {
  const test = setup();
  let serializations = 0;
  const replayEvents = Array.from({ length: 300 }, (_, order) => ({
    toJSON: () => {
      serializations++;
      return { type: 'task_notification', message: `event ${order} ${'é'.repeat(1000)}` };
    },
  }));
  // Counting events stand in for the events their toJSON returns.
  const frames = [
    ...frameSessionReplay({
      type: 'session_replay_batch',
      loadRequestId: 'load-1',
      replayEvents: unsafeCoerce<SessionDeltaEvent[]>(replayEvents),
    }),
  ];
  expect(frames.length).toBeGreaterThan(1);
  for (const frame of frames) {
    test.bus.publishToSession('s1', frame.payload, frame.json);
  }
  for (let guard = 0; test.viewer.writes.length && guard < 100; guard++) {
    await test.viewer.flush();
  }
  expect(test.viewer.frames).toEqual(frames.map((frame) => frame.json));
  expect(serializations).toBe(replayEvents.length);
});

it('sends a published serialization as-is and serializes other payloads itself', () => {
  const test = setup();
  const replay: WebSocketMessage = {
    type: 'session_replay_batch',
    loadRequestId: 'load-1',
    replayEvents: [],
  };
  const serialized = JSON.stringify(replay, null, 1);
  test.bus.publishToSession('s1', replay, serialized);
  test.bus.publishToSession('s1', delta);
  expect(test.viewer.frames).toEqual([serialized, JSON.stringify(delta)]);
});
