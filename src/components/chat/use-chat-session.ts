/**
 * Chat session management hook.
 *
 * This hook handles:
 * - Session switching detection
 * - Settings loading on session change
 * - Tool input accumulator cleanup
 * - Loading state management
 *
 * Settings precedence (highest to lowest):
 * 1. User-modified settings during the session
 * 2. Stored session settings from sessionStorage
 * 3. Application defaults (DEFAULT_CHAT_SETTINGS)
 */

import { useEffect, useRef } from 'react';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/claude-types';
import { createDebugLogger } from '@/lib/debug';
import { loadAllSessionData } from './chat-persistence';
import type { ChatAction } from './chat-reducer';
import { clearToolInputAccumulator, type ToolInputAccumulatorState } from './streaming-utils';

const DEBUG_SESSION = false;
const debug = createDebugLogger(DEBUG_SESSION);

export interface UseChatSessionOptions {
  /** Database session ID */
  dbSessionId: string | null;
  /** Dispatch function from reducer */
  dispatch: React.Dispatch<ChatAction>;
  /** Tool input accumulator ref to clear on session switch */
  toolInputAccumulatorRef: React.MutableRefObject<ToolInputAccumulatorState>;
}

export interface UseChatSessionReturn {
  /** Loaded draft for the session */
  loadedDraft: string;
}

/**
 * Hook for managing chat session switching and settings loading.
 */
export function useChatSession(options: UseChatSessionOptions): UseChatSessionReturn {
  const { dbSessionId, dispatch, toolInputAccumulatorRef } = options;

  const prevDbSessionIdRef = useRef<string | null>(null);
  const loadedDraftRef = useRef<string>('');
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prevDbSessionId = prevDbSessionIdRef.current;
    const newDbSessionId = dbSessionId ?? null;

    // Update ref
    prevDbSessionIdRef.current = newDbSessionId;

    // If switching to a different session, reset local state
    if (prevDbSessionId !== null && prevDbSessionId !== newDbSessionId) {
      debug.log('Session switch detected', { from: prevDbSessionId, to: newDbSessionId });

      // Clear any existing loading timeout
      if (loadingTimeoutRef.current) {
        clearTimeout(loadingTimeoutRef.current);
        loadingTimeoutRef.current = null;
      }

      // Dispatch session switch to reset reducer state
      dispatch({ type: 'SESSION_SWITCH_START' });

      // Clear tool input accumulator
      clearToolInputAccumulator(toolInputAccumulatorRef.current);
    }

    // Load persisted data for the new session (queue comes from backend via session_snapshot)
    if (newDbSessionId) {
      const persistedData = loadAllSessionData(newDbSessionId);
      loadedDraftRef.current = persistedData.draft;
      dispatch({ type: 'SET_SETTINGS', payload: persistedData.settings });

      // Set loading state for initial load (when prevDbSessionId was null)
      // This prevents "No messages yet" flash while WebSocket connects and loads session
      // For session switches, SESSION_SWITCH_START already set loadingSession: true
      if (prevDbSessionId === null) {
        dispatch({ type: 'SESSION_LOADING_START' });

        // Safety timeout: if loading takes more than 10 seconds, clear the loading state
        // This prevents sessions from getting stuck in loading state forever
        loadingTimeoutRef.current = setTimeout(() => {
          debug.log('Loading timeout reached, clearing loading state');
          dispatch({ type: 'SESSION_LOADING_END' });
          loadingTimeoutRef.current = null;
        }, 10_000);
      }
    } else {
      loadedDraftRef.current = '';
      dispatch({ type: 'SET_SETTINGS', payload: DEFAULT_CHAT_SETTINGS });
    }

    // Cleanup timeout on unmount
    return () => {
      if (loadingTimeoutRef.current) {
        clearTimeout(loadingTimeoutRef.current);
      }
    };
  }, [dbSessionId, dispatch, toolInputAccumulatorRef]);

  return {
    loadedDraft: loadedDraftRef.current,
  };
}
