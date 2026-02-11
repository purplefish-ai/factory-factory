import { useCallback } from 'react';
import type { WebSocketMessage } from '@/lib/claude-types';
import { isWebSocketMessage, isWsClaudeMessage } from '@/lib/claude-types';
import { createDebugLogger } from '@/lib/debug';
import type { ChatAction, ChatState } from './reducer';
import { createActionFromWebSocketMessage } from './reducer';
import {
  clearToolInputAccumulator,
  handleToolInputStreaming,
  type ToolInputAccumulatorState,
} from './streaming-utils';

// =============================================================================
// Debug Logging
// =============================================================================

const DEBUG_CHAT_TRANSPORT = false;
const debug = createDebugLogger(DEBUG_CHAT_TRANSPORT);

// =============================================================================
// Types
// =============================================================================

export interface UseChatTransportOptions {
  dispatch: React.Dispatch<ChatAction>;
  stateRef: React.MutableRefObject<ChatState>;
  toolInputAccumulatorRef: React.MutableRefObject<ToolInputAccumulatorState>;
  rewindTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}

export interface UseChatTransportReturn {
  handleMessage: (data: unknown) => void;
}

/**
 * Handle Claude message with tool input streaming.
 * Expects a validated claude_message WebSocket message.
 */
function handleClaudeMessageWithStreaming(
  wsMessage: Extract<WebSocketMessage, { type: 'claude_message' }>,
  toolInputAccumulatorRef: React.MutableRefObject<ToolInputAccumulatorState>,
  dispatch: React.Dispatch<ChatAction>
): void {
  const claudeMsg = wsMessage.data;

  // Handle tool input streaming before the main action
  const toolInputAction = handleToolInputStreaming(claudeMsg, toolInputAccumulatorRef);
  if (toolInputAction) {
    dispatch(toolInputAction);
    // Don't return - still need to dispatch the main action for content_block_start
  }
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useChatTransport(options: UseChatTransportOptions): UseChatTransportReturn {
  const { dispatch, stateRef, toolInputAccumulatorRef, rewindTimeoutRef } = options;

  /**
   * Clears the rewind timeout if the response matches the current rewind request.
   * Validates userMessageId to prevent stale responses from clearing the timeout.
   */
  const clearRewindTimeoutIfMatching = useCallback(
    (wsMessage: WebSocketMessage) => {
      if (wsMessage.type !== 'rewind_files_preview' && wsMessage.type !== 'rewind_files_error') {
        return;
      }
      const currentUserMessageId = stateRef.current.rewindPreview?.userMessageId;
      const responseUserMessageId = wsMessage.userMessageId;
      // Only clear timeout if this response is for the current rewind request
      if (
        rewindTimeoutRef.current &&
        (!responseUserMessageId || responseUserMessageId === currentUserMessageId)
      ) {
        clearTimeout(rewindTimeoutRef.current);
        rewindTimeoutRef.current = null;
      }
    },
    [rewindTimeoutRef, stateRef]
  );

  const handleMessage = useCallback(
    (data: unknown) => {
      // Validate incoming data is a WebSocket message
      if (!isWebSocketMessage(data)) {
        debug.log('Received invalid WebSocket message:', data);
        return;
      }
      const wsMessage = data;

      // session_delta wraps an inner websocket event from the SessionStore stream
      if (wsMessage.type === 'session_delta' && isWebSocketMessage(wsMessage.data)) {
        handleMessage(wsMessage.data);
        return;
      }

      if (wsMessage.type === 'session_snapshot' || wsMessage.type === 'session_replay_batch') {
        clearToolInputAccumulator(toolInputAccumulatorRef.current);
      }

      // Handle workspace notification requests
      if (wsMessage.type === 'workspace_notification_request') {
        // Dispatch custom event for WorkspaceNotificationManager
        window.dispatchEvent(
          new CustomEvent('workspace-notification-request', {
            detail: {
              workspaceId: wsMessage.workspaceId,
              workspaceName: wsMessage.workspaceName,
              sessionCount: wsMessage.sessionCount,
              finishedAt: wsMessage.finishedAt,
            },
          })
        );
        return;
      }

      // Clear rewind timeout when we receive rewind response for the current request
      clearRewindTimeoutIfMatching(wsMessage);

      // Handle Claude messages specially for tool input streaming
      if (isWsClaudeMessage(wsMessage)) {
        handleClaudeMessageWithStreaming(wsMessage, toolInputAccumulatorRef, dispatch);
      }

      // Convert WebSocket message to action and dispatch
      const action = createActionFromWebSocketMessage(wsMessage);
      if (action) {
        dispatch(action);
      }
    },
    [clearRewindTimeoutIfMatching, dispatch, toolInputAccumulatorRef]
  );

  return { handleMessage };
}
