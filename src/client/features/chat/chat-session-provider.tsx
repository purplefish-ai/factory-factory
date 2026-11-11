import {
  createContext,
  type ReactNode,
  use,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PendingRequestType } from '@/shared/pending-request-types';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { getChatPendingRequestType } from './pending-request-type';
import { createInitialChatState } from './reducer';
import { type UseChatWebSocketReturn, useChatWebSocket } from './use-chat-websocket';

/**
 * What layout outside the chat shows about the selected session: tab status,
 * the close guard, targeted controls and the header's running state. It changes
 * a few times per turn, not on every streamed event.
 */
export interface ChatSessionSummary {
  connected: boolean;
  controlsHydrated: boolean;
  /** The session the chat state was hydrated for; see `UseChatWebSocketReturn`. */
  runtimeSessionId: string | null;
  sessionRuntime: SessionRuntimeState;
  /** The open request without lifecycle precedence; consumers apply it. */
  pendingRequestType: PendingRequestType | null;
  queuedMessageCount: number;
  loadingSession: boolean;
  isRestartingSession: boolean;
}

/**
 * Holds the summary outside React state so the workspace layout subscribes to
 * it, and not to the stream. The store is stable for its owner's lifetime.
 */
export interface ChatSessionStore {
  getSummary: () => ChatSessionSummary;
  subscribe: (listener: () => void) => () => void;
  /** Called by `ChatSessionProvider` after each render of the session. */
  publish: (session: UseChatWebSocketReturn) => void;
  /** Act on the provider's current session; stable, so safe for memoized props. */
  restartSession: () => void;
  resumeQueuedMessages: () => void;
}

const initialChatState = createInitialChatState();
const INITIAL_SUMMARY: ChatSessionSummary = {
  connected: false,
  controlsHydrated: false,
  runtimeSessionId: initialChatState.hydratedSessionId,
  sessionRuntime: initialChatState.sessionRuntime,
  pendingRequestType: getChatPendingRequestType(initialChatState.pendingRequest),
  queuedMessageCount: initialChatState.queuedMessages.size,
  loadingSession: initialChatState.sessionStatus.phase === 'loading',
  isRestartingSession: false,
};

function summarize(session: UseChatWebSocketReturn): ChatSessionSummary {
  return {
    connected: session.connected,
    controlsHydrated: session.controlsHydrated,
    runtimeSessionId: session.runtimeSessionId,
    sessionRuntime: session.sessionRuntime,
    pendingRequestType: getChatPendingRequestType(session.pendingRequest),
    queuedMessageCount: session.queuedMessages.length,
    loadingSession: session.sessionStatus.phase === 'loading',
    isRestartingSession: session.isRestartingSession,
  };
}

function sameSummary(a: ChatSessionSummary, b: ChatSessionSummary): boolean {
  return (
    a.connected === b.connected &&
    a.controlsHydrated === b.controlsHydrated &&
    a.runtimeSessionId === b.runtimeSessionId &&
    a.sessionRuntime === b.sessionRuntime &&
    a.pendingRequestType === b.pendingRequestType &&
    a.queuedMessageCount === b.queuedMessageCount &&
    a.loadingSession === b.loadingSession &&
    a.isRestartingSession === b.isRestartingSession
  );
}

function createChatSessionStore(): ChatSessionStore {
  let summary = INITIAL_SUMMARY;
  let session: UseChatWebSocketReturn | null = null;
  const listeners = new Set<() => void>();
  return {
    getSummary: () => summary,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (next) => {
      session = next;
      const nextSummary = summarize(next);
      if (sameSummary(summary, nextSummary)) {
        return;
      }
      summary = nextSummary;
      for (const listener of listeners) {
        listener();
      }
    },
    restartSession: () => session?.restartSession(),
    resumeQueuedMessages: () => session?.resumeQueuedMessages(),
  };
}

/** Creates the store a `ChatSessionProvider` publishes to. */
export function useChatSessionStore(): ChatSessionStore {
  const [store] = useState(createChatSessionStore);
  return store;
}

/** Re-renders only when the summary changes, not on streamed events. */
export function useChatSessionSummary(store: ChatSessionStore): ChatSessionSummary {
  return useSyncExternalStore(store.subscribe, store.getSummary);
}

const ChatSessionContext = createContext<UseChatWebSocketReturn | null>(null);

/**
 * Owns the chat session for `dbSessionId`: its connection and state. The full
 * session reaches `useChatSessionState` consumers through context; the store
 * receives the summary.
 *
 * Wrap layout that must not re-render on streamed events, created by a parent
 * that does not re-render on them either: a session update renders this
 * provider, and React skips the unchanged `children` element down to the
 * context consumers. The summary is published in a layout effect, so a parent
 * subscribed to it updates before paint.
 */
export function ChatSessionProvider({
  store,
  dbSessionId,
  children,
}: {
  store: ChatSessionStore;
  dbSessionId: string | null;
  children: ReactNode;
}) {
  const session = useChatWebSocket({ dbSessionId });
  useLayoutEffect(() => store.publish(session));
  return <ChatSessionContext value={session}>{children}</ChatSessionContext>;
}

/** The provider's full session; re-renders on every session update. */
export function useChatSessionState(): UseChatWebSocketReturn {
  const session = use(ChatSessionContext);
  if (!session) {
    throw new Error('useChatSessionState must be used inside ChatSessionProvider');
  }
  return session;
}
