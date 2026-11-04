import { describe, expect, it } from 'vitest';
import { type ChatMessage, DEFAULT_RENDERER_TRANSCRIPT_LIMIT } from '@/lib/chat-protocol';
import { chatReducer, createInitialChatState, createActionFromWebSocketMessage } from './index';

const message = (order: number, text = `${order}`): ChatMessage => ({
  id: `m-${order}`,
  source: 'user',
  text,
  order,
  timestamp: '2026-11-04T00:00:00Z',
});

describe('older transcript history', () => {
  it('prepends without trimming or replacing newer live messages and preserves live state', () => {
    const state = createInitialChatState({
      messages: Array.from({ length: DEFAULT_RENDERER_TRANSCRIPT_LIMIT }, (_, index) =>
        message(index + 500)
      ),
      latestThinking: 'live thought',
    });
    const loading = chatReducer(state, {
      type: 'TRANSCRIPT_HISTORY_START',
      requestId: 'r',
      beforeMessageId: 'm-500',
    });
    const live = chatReducer(loading, { type: 'WS_ERROR', payload: { message: 'live error' } });
    const next = chatReducer(live, {
      type: 'TRANSCRIPT_HISTORY_LOADED',
      requestId: 'r',
      messages: [
        ...Array.from({ length: 500 }, (_, index) => message(index)),
        message(500, 'stale'),
      ],
      hasMore: false,
    });
    // 1,500 unique persisted entries plus the local live error.
    expect(next.messages).toHaveLength(1501);
    expect(next.messages.at(-1)).toBe(live.messages.at(-1));
    expect(next.messages[0]?.id).toBe('m-0');
    expect(next.messages.find((entry) => entry.id === 'm-500')?.text).toBe('500');
    expect(next.latestThinking).toBe(live.latestThinking);
    expect(next.sessionRuntime).toBe(live.sessionRuntime);
    expect(next.transcriptHistory.status).toBe('complete');
  });

  it('ignores responses from another request or an earlier session', () => {
    const loading = chatReducer(createInitialChatState(), {
      type: 'TRANSCRIPT_HISTORY_START',
      requestId: 'r',
      beforeMessageId: 'm-500',
    });
    expect(
      chatReducer(loading, {
        type: 'TRANSCRIPT_HISTORY_LOADED',
        requestId: 'other',
        messages: [message(0)],
        hasMore: false,
      })
    ).toBe(loading);
    const switched = chatReducer(loading, { type: 'SESSION_SWITCH_START' });
    expect(switched.rendererTranscriptLimit).toBeUndefined();
    expect(
      chatReducer(switched, {
        type: 'TRANSCRIPT_HISTORY_LOADED',
        requestId: 'r',
        messages: [message(0)],
        hasMore: false,
      })
    ).toBe(switched);
  });

  it('keeps messages on failure and permits retry', () => {
    const loading = chatReducer(createInitialChatState({ messages: [message(1)] }), {
      type: 'TRANSCRIPT_HISTORY_START',
      requestId: 'r',
      beforeMessageId: 'm-500',
    });
    const failed = chatReducer(loading, {
      type: 'TRANSCRIPT_HISTORY_FAILED',
      requestId: 'r',
      error: 'Offline',
    });
    expect(failed.messages).toBe(loading.messages);
    expect(failed.transcriptHistory).toEqual({ status: 'error', error: 'Offline' });
    expect(
      chatReducer(failed, {
        type: 'TRANSCRIPT_HISTORY_START',
        requestId: 'retry',
        beforeMessageId: 'm-500',
      }).transcriptHistory
    ).toMatchObject({ status: 'loading', requestId: 'retry' });
  });
});

it('resets browsing and fences outstanding requests on a new replay baseline', () => {
  const loading = chatReducer(createInitialChatState({ messages: [message(500)] }), {
    type: 'TRANSCRIPT_HISTORY_START',
    requestId: 'r',
    beforeMessageId: 'm-500',
  });
  const replayed = chatReducer(loading, {
    type: 'SESSION_REPLAY_BATCH',
    payload: { replayEvents: [] },
  });
  expect(replayed.rendererTranscriptLimit).toBeUndefined();
  expect(replayed.transcriptPageBoundaries.size).toBe(0);
  expect(replayed.transcriptHistory).toEqual({ status: 'idle' });
  expect(
    chatReducer(replayed, {
      type: 'TRANSCRIPT_HISTORY_LOADED',
      requestId: 'r',
      messages: [message(0)],
      hasMore: false,
    })
  ).toBe(replayed);
});

it('retains older pages on live snapshots while applying authoritative tail edits and removals', () => {
  const retained = createInitialChatState({
    sessionStatus: { phase: 'ready' },
    messages: [message(0), message(1), message(500), message(501)],
    rendererTranscriptLimit: null,
    transcriptPageBoundaries: new Set(['m-500']),
    transcriptHistory: { status: 'complete' },
  });
  const next = chatReducer(retained, {
    type: 'SESSION_SNAPSHOT',
    payload: {
      messages: [message(500, 'updated')],
      queuedMessages: [],
      sessionRuntime: retained.sessionRuntime,
      removedMessageIds: ['m-0'],
    },
  });
  expect(next.messages.map((entry) => [entry.id, entry.text])).toEqual([
    ['m-1', '1'],
    ['m-500', 'updated'],
  ]);
  expect(next.transcriptHistory).toBe(retained.transcriptHistory);
  expect(next.rendererTranscriptLimit).toBeNull();
  expect(next.transcriptPageBoundaries).toBe(retained.transcriptPageBoundaries);
  const hydrated = chatReducer(next, {
    type: 'SESSION_SNAPSHOT',
    payload: {
      messages: [message(500)],
      queuedMessages: [],
      sessionRuntime: next.sessionRuntime,
      isHydration: true,
    },
  });
  expect(hydrated.messages.map((entry) => entry.id)).toEqual(['m-500']);
  expect(hydrated.transcriptPageBoundaries.size).toBe(0);
});

it('restores the previous retention limit and boundaries after failed paging', () => {
  const initial = createInitialChatState({ messages: [message(500)], rendererTranscriptLimit: 20 });
  const loading = chatReducer(initial, {
    type: 'TRANSCRIPT_HISTORY_START',
    requestId: 'r',
    beforeMessageId: 'm-500',
  });
  const failed = chatReducer(loading, {
    type: 'TRANSCRIPT_HISTORY_FAILED',
    requestId: 'r',
    error: 'Offline',
  });
  expect(failed.rendererTranscriptLimit).toBe(20);
  expect(failed.transcriptPageBoundaries).toBe(initial.transcriptPageBoundaries);
  expect(failed.messages).toBe(loading.messages);
});

it('does not resurrect a removed entry from a page that was already in flight', () => {
  const initial = createInitialChatState({
    sessionStatus: { phase: 'ready' },
    messages: [message(500)],
  });
  const loading = chatReducer(initial, {
    type: 'TRANSCRIPT_HISTORY_START',
    requestId: 'r',
    beforeMessageId: 'm-500',
  });
  const removed = chatReducer(loading, {
    type: 'SESSION_SNAPSHOT',
    payload: {
      messages: [message(500)],
      queuedMessages: [],
      sessionRuntime: loading.sessionRuntime,
      removedMessageIds: ['m-1'],
    },
  });
  const next = chatReducer(removed, {
    type: 'TRANSCRIPT_HISTORY_LOADED',
    requestId: 'r',
    messages: [message(0), message(1)],
    hasMore: false,
  });
  expect(next.messages.map((entry) => entry.id)).toEqual(['m-0', 'm-500']);
});

it('drops all retained provider rows when the provider identity is replaced', () => {
  const local = { ...message(600), id: 'local-stop' };
  const retained = createInitialChatState({
    messages: [message(0), message(500), local],
    rendererTranscriptLimit: null,
    transcriptPageBoundaries: new Set(['m-500']),
  });
  const action = createActionFromWebSocketMessage({
    type: 'session_snapshot',
    messages: [local],
    queuedMessages: [],
    sessionRuntime: retained.sessionRuntime,
    resetTranscript: true,
  });
  if (!action) {
    throw new Error('Expected a reset snapshot action');
  }
  const next = chatReducer(retained, action);
  expect(next.messages).toEqual([local]);
  expect(next.transcriptPageBoundaries.size).toBe(0);
});
