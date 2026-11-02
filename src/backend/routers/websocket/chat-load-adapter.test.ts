import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import type { SessionLoadService } from '@/backend/services/session';
import { SessionEventBus } from '@/backend/services/session';
import { ChatConnectionRegistry } from './chat-connection-registry';
import { executeSessionLoad } from './chat-load-adapter';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const runtime = {
  phase: 'idle',
  processState: 'stopped',
  activity: 'IDLE',
  updatedAt: '2026-10-27T12:00:00.000Z',
} as const;

function setup() {
  const calls: unknown[] = [];
  const bus = new SessionEventBus();
  bus.on('session_outbound', (event) => {
    calls.push(event);
  });
  const service: Pick<SessionLoadService, 'prepareLoad' | 'captureReplay' | 'completeLoad'> = {
    prepareLoad: async (input) => ({
      status: 'ready',
      ...input,
      provider: 'CODEX',
      worktreePath: null,
    }),
    captureReplay: () => ({
      replayEvents: [{ type: 'session_runtime_snapshot', sessionRuntime: runtime }],
      sessionRuntime: runtime,
    }),
    completeLoad: ({ sessionId }) => {
      bus.publishToSession(sessionId, {
        type: 'session_delta',
        data: { type: 'session_runtime_updated', sessionRuntime: runtime },
      });
      calls.push('configuration');
      bus.publishToSession(sessionId, {
        type: 'session_delta',
        data: { type: 'slash_commands', slashCommands: [] },
      });
      calls.push('activation');
      return Promise.resolve();
    },
  };
  const deps = {
    loadService: service,
    eventBus: bus,
    fileLogger: { log: () => undefined },
  };
  return { calls, deps };
}

describe('executeSessionLoad', () => {
  it('frames correlated replay before runtime, configuration, and initial activation', async () => {
    const test = setup();
    expect(
      await executeSessionLoad({ sessionId: 's1', loadRequestId: 'load-1' }, test.deps)
    ).toEqual({ replies: [] });
    expect(test.calls).toEqual([
      {
        sessionId: 's1',
        payload: {
          type: 'session_replay_batch',
          loadRequestId: 'load-1',
          replayEvents: [{ type: 'session_runtime_snapshot', sessionRuntime: runtime }],
        },
      },
      {
        sessionId: 's1',
        payload: {
          type: 'session_delta',
          data: { type: 'session_runtime_updated', sessionRuntime: runtime },
        },
      },
      'configuration',
      {
        sessionId: 's1',
        payload: { type: 'session_delta', data: { type: 'slash_commands', slashCommands: [] } },
      },
      'activation',
    ]);
  });

  it('returns missing-session outcomes without replay, runtime, or activation', async () => {
    const test = setup();
    test.deps.loadService.prepareLoad = async () => ({
      status: 'error',
      outcome: { replies: [{ type: 'error', error: { kind: 'session_not_found' } }] },
    });
    expect(await executeSessionLoad({ sessionId: 'missing' }, test.deps)).toEqual({
      replies: [{ type: 'error', error: { kind: 'session_not_found' } }],
    });
    expect(test.calls).toEqual([]);
  });

  it('keeps concurrent replay correlations independent while an earlier configuration load is pending', async () => {
    const test = setup();
    const firstConfig = createDeferred<void>();
    test.deps.loadService.completeLoad = ({ sessionId, loadRequestId }) => {
      test.deps.eventBus.publishToSession(sessionId, {
        type: 'session_delta',
        data: { type: 'session_runtime_updated', sessionRuntime: runtime },
      });
      return loadRequestId === 'first' ? firstConfig.promise : Promise.resolve();
    };
    const first = executeSessionLoad({ sessionId: 's1', loadRequestId: 'first' }, test.deps);
    await Promise.resolve();
    await executeSessionLoad({ sessionId: 's1', loadRequestId: 'second' }, test.deps);
    expect(test.calls).toEqual([
      {
        sessionId: 's1',
        payload: {
          type: 'session_replay_batch',
          loadRequestId: 'first',
          replayEvents: [{ type: 'session_runtime_snapshot', sessionRuntime: runtime }],
        },
      },
      {
        sessionId: 's1',
        payload: {
          type: 'session_delta',
          data: { type: 'session_runtime_updated', sessionRuntime: runtime },
        },
      },
      {
        sessionId: 's1',
        payload: {
          type: 'session_replay_batch',
          loadRequestId: 'second',
          replayEvents: [{ type: 'session_runtime_snapshot', sessionRuntime: runtime }],
        },
      },
      {
        sessionId: 's1',
        payload: {
          type: 'session_delta',
          data: { type: 'session_runtime_updated', sessionRuntime: runtime },
        },
      },
    ]);
    firstConfig.resolve();
    await first;
  });
  it.each(['closed', 'throws', 'congested'] as const)(
    'continues application completion and other-viewer delivery when requester is %s after preparation',
    async (failure) => {
      const test = setup();
      const requesterFrames: string[] = [];
      const viewerFrames: string[] = [];
      const requester = Object.assign(new EventEmitter(), {
        bufferedAmount: failure === 'congested' ? 1024 * 1024 : 0,
        close: () => requester.emit('close'),
        terminate: () => undefined,
        readyState: WS_READY_STATE.OPEN as number,
        send(payload: string) {
          if (failure === 'throws') {
            throw new Error('disconnected');
          }
          requesterFrames.push(payload);
        },
      });
      const viewer = {
        readyState: WS_READY_STATE.OPEN,
        send: (payload: string) => viewerFrames.push(payload),
      };
      const registry = new ChatConnectionRegistry();
      registry.register('requester', {
        ws: requester as unknown as WebSocket,
        dbSessionId: 's1',
        workingDir: null,
      });
      registry.register('viewer', {
        ws: viewer as unknown as WebSocket,
        dbSessionId: 's1',
        workingDir: null,
      });
      test.deps.eventBus.on('session_outbound', ({ sessionId, payload }) =>
        registry.broadcastToSession(sessionId, payload)
      );
      const prepare = test.deps.loadService.prepareLoad;
      test.deps.loadService.prepareLoad = async (input) => {
        const result = await prepare(input);
        if (failure === 'closed') {
          requester.readyState = WS_READY_STATE.CLOSED;
        }
        return result;
      };
      await expect(
        executeSessionLoad({ sessionId: 's1', loadRequestId: 'load-disconnect' }, test.deps)
      ).resolves.toEqual({ replies: [] });
      expect(requesterFrames).toEqual([]);
      expect(viewerFrames.map((frame) => JSON.parse(frame))).toEqual([
        {
          type: 'session_replay_batch',
          loadRequestId: 'load-disconnect',
          replayEvents: [{ type: 'session_runtime_snapshot', sessionRuntime: runtime }],
        },
        {
          type: 'session_delta',
          data: { type: 'session_runtime_updated', sessionRuntime: runtime },
        },
        { type: 'session_delta', data: { type: 'slash_commands', slashCommands: [] } },
      ]);
      expect(test.calls.at(-1)).toBe('activation');
      registry.clear();
    }
  );
  it('loads a large correlated replay and completes application work before a pressured viewer reconnects', async () => {
    const test = setup();
    const registry = new ChatConnectionRegistry();
    const replayText = 'x'.repeat(2 * 1024 * 1024);
    test.deps.loadService.captureReplay = () => ({
      replayEvents: [
        {
          type: 'assistant_text_delta',
          messageId: 'history',
          order: 1,
          offset: 0,
          text: replayText,
        },
      ],
      sessionRuntime: runtime,
    });
    test.deps.eventBus.on('session_outbound', ({ sessionId, payload }) =>
      registry.broadcastToSession(sessionId, payload)
    );
    const connect = () => {
      const frames: unknown[] = [];
      const ws = Object.assign(new EventEmitter(), {
        readyState: WS_READY_STATE.OPEN,
        bufferedAmount: 0,
        close: () => ws.emit('close'),
        terminate: () => undefined,
        send: (payload: string) => {
          frames.push(JSON.parse(payload));
          ws.bufferedAmount += Buffer.byteLength(payload);
        },
      });
      registry.register('requester', {
        ws: ws as unknown as WebSocket,
        dbSessionId: 's1',
        workingDir: null,
      });
      return { ws, frames };
    };
    const first = connect();
    registry.expectReplay(first.ws as unknown as WebSocket, 'first');
    await executeSessionLoad({ sessionId: 's1', loadRequestId: 'first' }, test.deps);
    expect(first.frames).toHaveLength(3);
    expect(first.frames[0]).toMatchObject({
      type: 'session_replay_batch',
      loadRequestId: 'first',
      replayEvents: [{ type: 'assistant_text_delta', text: replayText }],
    });
    await executeSessionLoad({ sessionId: 's1', loadRequestId: 'first' }, test.deps);
    expect(first.frames).toHaveLength(5);
    first.ws.bufferedAmount += 1024 * 1024;
    registry.broadcastToSession('s1', {
      type: 'session_delta',
      data: { type: 'slash_commands', slashCommands: [] },
    });
    expect(first.frames).toHaveLength(5);
    const second = connect();
    registry.expectReplay(second.ws as unknown as WebSocket, 'second');
    await executeSessionLoad({ sessionId: 's1', loadRequestId: 'second' }, test.deps);
    expect(second.frames).toHaveLength(3);
    expect(second.frames[0]).toMatchObject({
      type: 'session_replay_batch',
      loadRequestId: 'second',
    });
    expect(test.calls.at(-1)).toBe('activation');
    second.ws.emit('close');
    registry.clear();
  });

  it('does not yield between replay capture and publication when a live update is queued', async () => {
    const test = setup();
    const capture = test.deps.loadService.captureReplay;
    test.deps.loadService.captureReplay = (prepared) => {
      const replay = capture(prepared);
      queueMicrotask(() =>
        test.deps.eventBus.publishToSession('s1', {
          type: 'session_delta',
          data: {
            type: 'assistant_text_delta',
            messageId: 'live-text',
            order: 1,
            offset: 0,
            text: 'Still streaming',
          },
        })
      );
      return replay;
    };
    await executeSessionLoad({ sessionId: 's1', loadRequestId: 'load-live' }, test.deps);
    const events = test.calls.filter(
      (event): event is { sessionId: string; payload: { type: string; data?: { type: string } } } =>
        typeof event === 'object' && event !== null
    );
    expect(events[0]?.payload).toMatchObject({
      type: 'session_replay_batch',
      loadRequestId: 'load-live',
    });
    expect(events.at(-1)?.payload).toMatchObject({
      type: 'session_delta',
      data: { type: 'assistant_text_delta', text: 'Still streaming' },
    });
  });
});
