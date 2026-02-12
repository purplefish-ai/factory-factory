import { describe, expect, it } from 'vitest';
import { buildReplayEvents, buildSnapshotMessages } from './session-replay-builder';
import type { SessionStore } from './session-store.types';

function createStore(): SessionStore {
  return {
    sessionId: 's1',
    initialized: true,
    hydratePromise: null,
    hydratingKey: null,
    hydratedKey: null,
    hydrateGeneration: 0,
    lastKnownProjectPath: null,
    lastKnownClaudeSessionId: null,
    transcript: [
      {
        id: 'u1',
        source: 'user',
        text: 'hello',
        timestamp: '2026-02-01T00:00:00.000Z',
        order: 0,
      },
      {
        id: 'c1',
        source: 'claude',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
          timestamp: '2026-02-01T00:00:01.000Z',
        },
        timestamp: '2026-02-01T00:00:01.000Z',
        order: 1,
      },
    ],
    queue: [
      {
        id: 'q1',
        text: 'queued',
        timestamp: '2026-02-01T00:00:02.000Z',
        settings: {
          selectedModel: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      },
    ],
    pendingInteractiveRequest: {
      requestId: 'req-1',
      toolName: 'ExitPlanMode',
      toolUseId: 'tool-1',
      input: { reason: 'x' },
      planContent: 'x',
      timestamp: '2026-02-01T00:00:03.000Z',
    },
    runtime: {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      updatedAt: '2026-02-01T00:00:04.000Z',
    },
    nextOrder: 2,
    lastHydratedAt: null,
  };
}

describe('session-replay-builder', () => {
  it('builds snapshot with transcript and queued messages', () => {
    const snapshot = buildSnapshotMessages(createStore());

    expect(snapshot).toHaveLength(3);
    expect(snapshot.map((message) => message.id)).toEqual(['u1', 'c1', 'q1']);
  });

  it('builds replay events with runtime, transcript, queue, and pending request', () => {
    const replayEvents = buildReplayEvents(createStore());

    expect(replayEvents[0]).toMatchObject({ type: 'session_runtime_snapshot' });
    expect(replayEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message_state_changed',
          id: 'u1',
          newState: 'ACCEPTED',
        }),
        expect.objectContaining({
          type: 'message_state_changed',
          id: 'u1',
          newState: 'COMMITTED',
        }),
        expect.objectContaining({
          type: 'agent_message',
          order: 1,
        }),
        expect.objectContaining({
          type: 'message_state_changed',
          id: 'q1',
          queuePosition: 0,
        }),
        expect.objectContaining({
          type: 'permission_request',
          requestId: 'req-1',
          toolName: 'ExitPlanMode',
        }),
      ])
    );
  });
});
