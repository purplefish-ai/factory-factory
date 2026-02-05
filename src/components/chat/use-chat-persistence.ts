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

  // Update ref when sessionId changes
  useEffect(() => {
    dbSessionIdRef.current = dbSessionId;
  }, [dbSessionId]);

  // Update draft state when initial draft changes (session switch)
  useEffect(() => {
    setInputDraftState(initialDraft);
  }, [initialDraft]);

  /**
   * Set input draft and persist to sessionStorage (debounced).
   */
  const setInputDraft = useCallback((draft: string) => {
    setInputDraftState(draft);

    // Debounce sessionStorage write to avoid blocking main thread on every keystroke
    if (persistDraftDebounced.current) {
      clearTimeout(persistDraftDebounced.current);
    }
    persistDraftDebounced.current = setTimeout(() => {
      persistDraft(dbSessionIdRef.current, draft);
    }, 300);
  }, []);

  /**
   * Clear draft from storage and state.
   */
  const clearInputDraft = useCallback(() => {
    setInputDraftState('');
    clearDraft(dbSessionIdRef.current);
  }, []);

  // Clean up pending debounced persist on unmount
  useEffect(() => {
    return () => {
      if (persistDraftDebounced.current) {
        clearTimeout(persistDraftDebounced.current);
      }
    };
  }, []);

  return {
    inputDraft,
    setInputDraft,
    clearInputDraft,
  };
}
