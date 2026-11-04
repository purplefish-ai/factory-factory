import { describe, expect, it } from 'vitest';
import { type ChatMessage, DEFAULT_RENDERER_TRANSCRIPT_LIMIT } from '@/lib/chat-protocol';
import { chatReducer, createInitialChatState } from './index';

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
    expect(next.messages).toHaveLength(1501);
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
    ).toEqual({ status: 'loading', requestId: 'retry' });
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
