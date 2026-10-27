/**
 * Chat session management hook.
 *
 * This hook handles:
 * - Session switching detection
 * - Settings loading on session change
 * - Tool input accumulator cleanup
 * - Loading state management
 *
 * Stored settings seed the composer while configuration loads. The settings
 * reducer adopts the initial server-confirmed model, then preserves explicit
 * current-session edits until a native configuration update confirms a value.
 */

import { useEffect, useRef } from 'react';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/chat-protocol';
import { createDebugLogger, DEBUG_CHAT_WS } from '@/lib/debug';
import { loadDraft, loadSettingsWithDefaults } from './chat-persistence';
import type { ChatAction } from './reducer';
import { clearToolInputAccumulator, type ToolInputAccumulatorState } from './streaming-utils';

const DEBUG_SESSION = DEBUG_CHAT_WS;
const debug = createDebugLogger(DEBUG_SESSION);

export interface UseChatSessionOptions {
  /** Database session ID */
  dbSessionId: string | null;
  /** Dispatch function from reducer */
  dispatch: React.Dispatch<ChatAction>;
  /** Tool input accumulator ref to clear on session switch */
  toolInputAccumulatorRef: React.MutableRefObject<ToolInputAccumulatorState>;
  /** Session runtime phase from state - used to clear loading timeout */
  sessionRuntimePhase: string;
}

export interface UseChatSessionReturn {
  /** Loaded draft for the session */
  loadedDraft: string;
}

/**
 * Hook for managing chat session switching and settings loading.
 */
export function useChatSession(options: UseChatSessionOptions): UseChatSessionReturn {
  const { dbSessionId, dispatch, toolInputAccumulatorRef, sessionRuntimePhase } = options;

  const prevDbSessionIdRef = useRef<string | null | undefined>(undefined);
  const loadedDraftRef = useRef<string>('');
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prevDbSessionId = prevDbSessionIdRef.current;
    const newDbSessionId = dbSessionId ?? null;

    // Update ref
    prevDbSessionIdRef.current = newDbSessionId;

    // If switching to a different session, reset local state
    if (prevDbSessionId !== undefined && prevDbSessionId !== newDbSessionId) {
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
      loadedDraftRef.current = loadDraft(newDbSessionId);
      dispatch({ type: 'SET_SETTINGS', payload: loadSettingsWithDefaults(newDbSessionId) });

      // Set loading state for the initial load.
      // This prevents "No messages yet" flash while WebSocket connects and loads session
      // For session switches, SESSION_SWITCH_START already set loadingSession: true
      if (prevDbSessionId === undefined) {
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

  // Clear loading timeout when session runtime phase transitions away from loading.
  // We track the previous phase to avoid clearing the timeout on mount when the
  // initial phase is 'idle' (before SESSION_LOADING_START has re-rendered).
  const prevRuntimePhaseRef = useRef(sessionRuntimePhase);
  useEffect(() => {
    const prevPhase = prevRuntimePhaseRef.current;
    prevRuntimePhaseRef.current = sessionRuntimePhase;

    if (prevPhase === 'loading' && sessionRuntimePhase !== 'loading' && loadingTimeoutRef.current) {
      debug.log('Session runtime phase changed from loading, clearing loading timeout');
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
  }, [sessionRuntimePhase]);

  return {
    loadedDraft: loadedDraftRef.current,
  };
}
