/**
 * Chat persistence hook for managing draft input state.
 *
 * This hook handles:
 * - Input draft state management
 * - Debounced persistence to sessionStorage
 * - Cleanup on unmount
 *
 * Note: Chat settings persistence is handled directly in use-chat-state
 * as it's tightly coupled with the settings reducer action.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clearDraft, persistDraft } from './chat-persistence';

export interface UseChatPersistenceOptions {
  /** Database session ID for persistence key */
  dbSessionId: string | null;
  /** Initial draft value to set */
  initialDraft: string;
}

export interface UseChatPersistenceReturn {
  /** Current input draft */
  inputDraft: string;
  /** Set input draft and persist to storage (debounced) */
  setInputDraft: (draft: string) => void;
  /** Clear draft from storage */
  clearInputDraft: () => void;
}

/**
 * Hook for managing chat input draft with persistence.
 */
export function useChatPersistence(options: UseChatPersistenceOptions): UseChatPersistenceReturn {
  const { dbSessionId, initialDraft } = options;

  const [inputDraft, setInputDraftState] = useState(initialDraft);
  const dbSessionIdRef = useRef<string | null>(dbSessionId ?? null);
  const persistDraftDebounced = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingDraftRef = useRef<{ sessionId: string | null; draft: string } | undefined>(
    undefined
  );

  // Reset the composer for each session even when their stored drafts match.
  useEffect(() => {
    dbSessionIdRef.current = dbSessionId;
    setInputDraftState(initialDraft);
  }, [dbSessionId, initialDraft]);

  /**
   * Set input draft and persist to sessionStorage (debounced).
   */
  const setInputDraft = useCallback((draft: string) => {
    setInputDraftState(draft);
    const sessionId = dbSessionIdRef.current;

    // Debounce sessionStorage write to avoid blocking main thread on every keystroke
    if (persistDraftDebounced.current) {
      clearTimeout(persistDraftDebounced.current);
    }
    pendingDraftRef.current = { sessionId, draft };
    persistDraftDebounced.current = setTimeout(() => {
      persistDraft(sessionId, draft);
      pendingDraftRef.current = undefined;
      persistDraftDebounced.current = undefined;
    }, 300);
  }, []);

  /**
   * Clear draft from storage and state.
   */
  const clearInputDraft = useCallback(() => {
    setInputDraftState('');
    if (persistDraftDebounced.current) {
      clearTimeout(persistDraftDebounced.current);
      persistDraftDebounced.current = undefined;
    }
    pendingDraftRef.current = undefined;
    clearDraft(dbSessionIdRef.current);
  }, []);

  // Flush the outgoing draft before the next session loads its own storage,
  // including switches made before the debounce completes.
  useEffect(() => {
    return () => {
      if (persistDraftDebounced.current) {
        clearTimeout(persistDraftDebounced.current);
        persistDraftDebounced.current = undefined;
      }
      const pending = pendingDraftRef.current;
      if (pending && pending.sessionId === dbSessionId) {
        persistDraft(dbSessionId, pending.draft);
        pendingDraftRef.current = undefined;
      }
    };
  }, [dbSessionId]);

  return {
    inputDraft,
    setInputDraft,
    clearInputDraft,
  };
}
