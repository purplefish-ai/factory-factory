// @vitest-environment jsdom
import { act, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/chat-protocol';
import { chatReducer, createInitialChatState, type ChatAction, type ChatState } from './reducer';
import { useTranscriptHistory, type TranscriptHistoryControls } from './use-transcript-history';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const first: ChatMessage = {
  id: 'first',
  source: 'user',
  text: 'First',
  order: 1000,
  timestamp: '2026-11-04T00:00:00Z',
};
let root: Root;
let container: HTMLDivElement;
let history: TranscriptHistoryControls;
let state: ChatState;
let dispatch: React.Dispatch<ChatAction>;
let resolvePage: (value: { messages: ChatMessage[]; hasMore: boolean }) => void;
let rejectPage: (error: Error) => void;
const fetchPage = vi.fn(
  (_input: { sessionId: string; beforeMessageId: string }, _signal: AbortSignal) =>
    new Promise<{ messages: ChatMessage[]; hasMore: boolean }>((resolve, reject) => {
      resolvePage = resolve;
      rejectPage = reject;
    })
);

function Probe({ sessionId = 's', enabled = true }: { sessionId?: string; enabled?: boolean }) {
  [state, dispatch] = useReducer(chatReducer, undefined, () =>
    createInitialChatState({ messages: [first] })
  );
  history = useTranscriptHistory({
    sessionId,
    enabled,
    messages: state.messages,
    history: state.transcriptHistory,
    dispatch,
    fetchPage,
  });
  return null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  fetchPage.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

it('fetches only on demand, deduplicates synchronous triggers, then advances the cursor', async () => {
  await act(() => root.render(<Probe />));
  expect(fetchPage).not.toHaveBeenCalled();
  await act(() => {
    history.loadOlder();
    history.loadOlder();
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(fetchPage.mock.calls[0]?.[0]).toEqual({ sessionId: 's', beforeMessageId: 'first' });
  expect(history.status).toBe('loading');
  const older = { ...first, id: 'older', order: 0 };
  await act(async () => resolvePage({ messages: [older], hasMore: true }));
  expect(state.messages.map((message) => message.id)).toEqual(['older', 'first']);
  await act(() => history.loadOlder());
  expect(fetchPage.mock.calls[1]?.[0].beforeMessageId).toBe('older');
  await act(async () => resolvePage({ messages: [], hasMore: false }));
  await act(() => history.loadOlder());
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(history.status).toBe('complete');
});

it('retains visible messages on failure and retries the same cursor', async () => {
  await act(() => root.render(<Probe />));
  await act(() => history.loadOlder());
  await act(async () => rejectPage(new Error('Offline')));
  expect(history.status).toBe('error');
  expect(history.error).toBe('Offline');
  expect(state.messages).toEqual([first]);
  await act(() => history.loadOlder());
  expect(fetchPage).toHaveBeenCalledTimes(2);
  await act(async () => resolvePage({ messages: [], hasMore: false }));
});

it('cancels in-flight work on a session switch and ignores late completion', async () => {
  await act(() => root.render(<Probe />));
  await act(() => history.loadOlder());
  const signal = fetchPage.mock.calls[0]?.[1];
  await act(() => {
    dispatch({ type: 'SESSION_SWITCH_START' });
    root.render(<Probe sessionId="other" />);
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => resolvePage({ messages: [{ ...first, id: 'stale' }], hasMore: false }));
  expect(state.messages).toEqual([]);
});

it('does not fetch while hydration or the connection is unavailable', async () => {
  await act(() => root.render(<Probe enabled={false} />));
  await act(() => history.loadOlder());
  expect(fetchPage).not.toHaveBeenCalled();
});

it('leaves interrupted requests retryable after the connection returns', async () => {
  await act(() => root.render(<Probe />));
  await act(() => history.loadOlder());
  await act(() => root.render(<Probe enabled={false} />));
  expect(history.status).toBe('error');
  expect(fetchPage.mock.calls[0]?.[1].aborted).toBe(true);
  await act(() => root.render(<Probe />));
  await act(() => history.loadOlder());
  expect(fetchPage).toHaveBeenCalledTimes(2);
  await act(async () => resolvePage({ messages: [], hasMore: false }));
  expect(history.status).toBe('complete');
});
