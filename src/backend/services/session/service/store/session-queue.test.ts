import { describe, expect, it } from 'vitest';
import { SERVICE_LIMITS } from '@/backend/services/constants';
import type { QueuedMessage } from '@/shared/acp-protocol';
import {
  clearPendingInteractiveRequest,
  clearPendingInteractiveRequestIfMatches,
  clearQueuedWork,
  enqueueMessage,
} from './session-queue';
import type { SessionStore } from './session-store.types';

function createStore(): SessionStore {
  return {
    sessionId: 's1',
    initialized: true,
    transcript: [],
    transcriptIdToIndex: new Map(),
    queue: [],
    recentRejections: [],
    pendingInteractiveRequest: null,
    runtime: {
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-02-01T00:00:00.000Z',
    },
    nextOrder: 0,
  };
}

function message(id: string, source?: QueuedMessage['source']): QueuedMessage {
  return {
    id,
    text: id,
    timestamp: '2026-02-01T00:00:00.000Z',
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
    ...(source ? { source } : {}),
  };
}

describe('session-queue', () => {
  it('enqueues and returns queue position', () => {
    const store = createStore();
    const result = enqueueMessage(store, {
      id: 'q1',
      text: 'queued',
      timestamp: '2026-02-01T00:00:00.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });

    expect(result).toEqual({ position: 0 });
    expect(store.queue).toHaveLength(1);
  });

  it('returns the insertion index for a human message placed ahead of PR events', () => {
    const store = createStore();
    enqueueMessage(store, message('human-1'));
    const prSource = {
      type: 'pr_event',
      request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 },
    } as const;
    expect(enqueueMessage(store, message('pr-1', prSource))).toEqual({ position: 1 });

    const result = enqueueMessage(store, message('human-2'));

    expect(store.queue.map((item) => item.id)).toEqual(['human-1', 'human-2', 'pr-1']);
    expect(result).toEqual({ position: 1 });
  });

  it('returns queue full error at service limit', () => {
    const store = createStore();
    store.queue = Array.from({ length: SERVICE_LIMITS.sessionStoreMaxQueueSize }, (_, index) => ({
      id: `q-${index}`,
      text: 'queued',
      timestamp: '2026-02-01T00:00:00.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    }));

    const result = enqueueMessage(store, {
      id: 'overflow',
      text: 'overflow',
      timestamp: '2026-02-01T00:00:00.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });

    expect(result).toEqual({
      error: `Queue full (max ${SERVICE_LIMITS.sessionStoreMaxQueueSize} messages)`,
    });
  });

  it('clears queued work and pending request together', () => {
    const store = createStore();
    store.queue.push({
      id: 'q1',
      text: 'queued',
      timestamp: '2026-02-01T00:00:00.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    store.pendingInteractiveRequest = {
      requestId: 'req-1',
      toolName: 'ExitPlanMode',
      toolUseId: 'tool-1',
      input: {},
      planContent: null,
      timestamp: '2026-02-01T00:00:00.000Z',
    };

    expect(clearQueuedWork(store)).toBe(true);
    expect(store.queue).toEqual([]);
    expect(store.pendingInteractiveRequest).toBeNull();
  });

  it('clears pending request only when request id matches', () => {
    const store = createStore();
    store.pendingInteractiveRequest = {
      requestId: 'req-1',
      toolName: 'ExitPlanMode',
      toolUseId: 'tool-1',
      input: {},
      planContent: null,
      timestamp: '2026-02-01T00:00:00.000Z',
    };

    expect(clearPendingInteractiveRequestIfMatches(store, 'other')).toBe(false);
    expect(store.pendingInteractiveRequest).not.toBeNull();

    expect(clearPendingInteractiveRequest(store)).toBe(true);
    expect(store.pendingInteractiveRequest).toBeNull();
  });
});
