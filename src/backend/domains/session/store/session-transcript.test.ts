import { describe, expect, it, vi } from 'vitest';
import type { SessionStore } from './session-store.types';
import {
  appendClaudeEvent,
  buildTranscriptFromHistory,
  commitSentUserMessageWithOrder,
  injectCommittedUserMessage,
} from './session-transcript';

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
    transcript: [],
    queue: [],
    pendingInteractiveRequest: null,
    runtime: {
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-02-01T00:00:00.000Z',
    },
    nextOrder: 0,
    lastHydratedAt: null,
  };
}

describe('session-transcript', () => {
  it('creates stable fallback IDs for history entries without uuid', () => {
    const history = [
      { type: 'user' as const, content: 'hello', timestamp: '2026-02-01T00:00:00.000Z' },
      { type: 'assistant' as const, content: 'hi', timestamp: '2026-02-01T00:00:01.000Z' },
    ];

    const first = buildTranscriptFromHistory(history).map((entry) => entry.id);
    const second = buildTranscriptFromHistory(history).map((entry) => entry.id);

    expect(first).toEqual(second);
  });

  it('keeps nextOrder strictly above committed order', () => {
    const store = createStore();
    store.nextOrder = 1;

    commitSentUserMessageWithOrder(
      store,
      {
        id: 'u-1',
        text: 'hello',
        timestamp: '2026-02-01T00:00:00.000Z',
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      },
      5
    );

    expect(store.nextOrder).toBe(6);
    expect(store.transcript[0]?.order).toBe(5);
  });

  it('upserts duplicate tool_use content_block_start events by tool id', () => {
    const store = createStore();
    const onParityTrace = vi.fn();

    const firstOrder = appendClaudeEvent(
      store,
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
        },
      },
      {
        nowIso: () => '2026-02-01T00:00:00.000Z',
        onParityTrace,
      }
    );

    const secondOrder = appendClaudeEvent(
      store,
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'ls', description: 'List files' },
          },
        },
      },
      {
        nowIso: () => '2026-02-01T00:00:01.000Z',
        onParityTrace,
      }
    );

    expect(store.transcript).toHaveLength(1);
    expect(secondOrder).toBe(firstOrder);
    // Existing entry should be updated with enriched input
    const entry = store.transcript[0]!;
    const block = (entry.message as { event: { content_block: { input: unknown } } }).event
      .content_block;
    expect(block.input).toEqual({ command: 'ls', description: 'List files' });
    expect(onParityTrace).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'duplicate_tool_use_start_enriched' })
    );
  });

  it('injects committed user message with deterministic clock hooks', () => {
    const store = createStore();
    injectCommittedUserMessage(store, 'injected', {
      nowIso: () => '2026-02-01T00:00:00.000Z',
      nowMs: () => 1000,
    });

    expect(store.transcript[0]).toMatchObject({
      id: 'injected-1000',
      source: 'user',
      text: 'injected',
      timestamp: '2026-02-01T00:00:00.000Z',
      order: 0,
    });
    expect(store.nextOrder).toBe(1);
  });
});
