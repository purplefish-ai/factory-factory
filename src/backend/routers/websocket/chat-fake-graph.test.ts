import { describe, expect, it, vi } from 'vitest';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';
import { createChatMessageRouterForApplication } from './chat-message-router';

const stopped: SessionRuntimeState = {
  phase: 'idle',
  processState: 'stopped',
  activity: 'IDLE',
  updatedAt: '2026-10-27T00:00:00Z',
};

describe('chat router with complete fake application graphs', () => {
  it('loads through each graph and captures its overridden runtime without sharing delivery', async () => {
    const first = createFakeApplicationGraph('first');
    const second = createFakeApplicationGraph('second');
    const active: SessionRuntimeState = {
      ...stopped,
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
    };
    vi.mocked(first.services.sessionLifecycleService.getRuntimeSnapshot).mockReturnValue(stopped);
    vi.mocked(second.services.sessionLifecycleService.getRuntimeSnapshot).mockReturnValue(active);
    for (const [graph, loadRequestId] of [
      [first, 'first-load'],
      [second, 'second-load'],
    ] as const) {
      expect(
        await createChatMessageRouterForApplication(graph.services).handleMessage(
          'same-session',
          '/tmp',
          { type: 'load_session', loadRequestId }
        )
      ).toEqual({ replies: [] });
    }
    expect(first.services.sessionEventBus.publishToSession).toHaveBeenCalledExactlyOnceWith(
      'same-session',
      {
        type: 'session_replay_batch',
        loadRequestId: 'first-load',
        replayEvents: [{ type: 'session_runtime_snapshot', sessionRuntime: stopped }],
      }
    );
    expect(second.services.sessionEventBus.publishToSession).toHaveBeenCalledExactlyOnceWith(
      'same-session',
      {
        type: 'session_replay_batch',
        loadRequestId: 'second-load',
        replayEvents: [{ type: 'session_runtime_snapshot', sessionRuntime: active }],
      }
    );
    expect(first.services.sessionLoadService.completeLoad).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'same-session', loadRequestId: 'first-load' })
    );
    expect(second.services.sessionLoadService.completeLoad).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'same-session', loadRequestId: 'second-load' })
    );
  });

  it('provides a valid passive replay with no per-test load overrides', async () => {
    const graph = createFakeApplicationGraph();
    expect(
      await createChatMessageRouterForApplication(graph.services).handleMessage('default', '/tmp', {
        type: 'load_session',
      })
    ).toEqual({ replies: [] });
    expect(graph.services.sessionEventBus.publishToSession).toHaveBeenCalledExactlyOnceWith(
      'default',
      {
        type: 'session_replay_batch',
        replayEvents: [
          {
            type: 'session_runtime_snapshot',
            sessionRuntime: {
              phase: 'idle',
              processState: 'stopped',
              activity: 'IDLE',
              updatedAt: expect.any(String),
            },
          },
        ],
      }
    );
  });

  it('lets callers configure a load failure on one graph without affecting another graph', async () => {
    const first = createFakeApplicationGraph('first');
    const second = createFakeApplicationGraph('second');
    vi.mocked(first.services.sessionLoadService.prepareLoad).mockResolvedValueOnce({
      status: 'error',
      outcome: { replies: [{ type: 'error', error: { kind: 'session_not_found' } }] },
    });
    vi.mocked(second.services.sessionLifecycleService.getRuntimeSnapshot).mockReturnValue(stopped);
    expect(
      await createChatMessageRouterForApplication(first.services).handleMessage('missing', '/tmp', {
        type: 'load_session',
      })
    ).toEqual({ replies: [{ type: 'error', error: { kind: 'session_not_found' } }] });
    expect(first.services.sessionEventBus.publishToSession).not.toHaveBeenCalled();
    expect(first.services.sessionLoadService.completeLoad).not.toHaveBeenCalled();
    expect(
      await createChatMessageRouterForApplication(second.services).handleMessage(
        'present',
        '/tmp',
        { type: 'load_session' }
      )
    ).toEqual({ replies: [] });
    expect(second.services.sessionEventBus.publishToSession).toHaveBeenCalledOnce();
  });
});
