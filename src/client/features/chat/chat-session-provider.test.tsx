// @vitest-environment jsdom

import { act, createElement, type ReactNode, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ChatSessionProvider,
  type ChatSessionSummary,
  useChatSessionState,
  useChatSessionStore,
  useChatSessionSummary,
} from './chat-session-provider';

// A chat hook driven by an external stream: an update re-renders only the
// component that calls it, like a real streamed event.
const stream = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const noRequest: { type: string; request?: { requestId: string; toolName: string } } = {
    type: 'none',
  };
  const initial = {
    messages: [] as string[],
    connected: true,
    controlsHydrated: true,
    runtimeSessionId: 'session-a' as string | null,
    sessionRuntime: { phase: 'idle' },
    pendingRequest: noRequest,
    queuedMessages: [] as { id: string }[],
    sessionStatus: { phase: 'ready' },
    isRestartingSession: false,
    restartSession: vi.fn(),
    resumeQueuedMessages: vi.fn(),
  };
  let snapshot = initial;
  return {
    reset: () => {
      snapshot = { ...initial, restartSession: vi.fn(), resumeQueuedMessages: vi.fn() };
    },
    get: () => snapshot,
    update: (patch: Partial<typeof initial>) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock('./use-chat-websocket', () => ({
  useChatWebSocket: () => useSyncExternalStore(stream.subscribe, stream.get),
}));

const renders = { owner: 0, layout: 0, chat: 0 };
let summary: ChatSessionSummary | undefined;
let store: ReturnType<typeof useChatSessionStore> | undefined;
let chatMessages: unknown;

function Chat() {
  renders.chat += 1;
  chatMessages = useChatSessionState().messages;
  return null;
}

function Layout({ children }: { children: ReactNode }) {
  renders.layout += 1;
  return children;
}

function Owner() {
  renders.owner += 1;
  store = useChatSessionStore();
  summary = useChatSessionSummary(store);
  return (
    <ChatSessionProvider store={store} dbSessionId="session-a">
      <Layout>
        <Chat />
      </Layout>
    </ChatSessionProvider>
  );
}

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stream.reset();
  renders.owner = 0;
  renders.layout = 0;
  renders.chat = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root.render(createElement(Owner)));
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('re-renders only the session consumer for an update the summary does not include', async () => {
  const before = { ...renders };
  await act(() => stream.update({ messages: ['streamed'] }));
  expect(chatMessages).toEqual(['streamed']);
  expect(renders).toEqual({ ...before, chat: before.chat + 1 });
});

it('re-renders the summary subscriber when the summary changes', async () => {
  expect(summary).toMatchObject({ runtimeSessionId: 'session-a', queuedMessageCount: 0 });
  const before = { ...renders };
  await act(() =>
    stream.update({
      queuedMessages: [{ id: 'queued' }],
      pendingRequest: { type: 'question', request: { requestId: 'q', toolName: 'AskUser' } },
    })
  );
  expect(summary).toMatchObject({ queuedMessageCount: 1, pendingRequestType: 'user_question' });
  expect(renders.owner).toBe(before.owner + 1);
});

it('acts on the session the provider currently owns', async () => {
  const first = stream.get();
  store?.restartSession();
  expect(first.restartSession).toHaveBeenCalledOnce();

  const replacement = { restartSession: vi.fn(), resumeQueuedMessages: vi.fn() };
  await act(() => stream.update(replacement));
  store?.restartSession();
  store?.resumeQueuedMessages();
  expect(first.restartSession).toHaveBeenCalledOnce();
  expect(replacement.restartSession).toHaveBeenCalledOnce();
  expect(replacement.resumeQueuedMessages).toHaveBeenCalledOnce();
});
