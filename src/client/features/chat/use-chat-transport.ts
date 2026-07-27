import { useCallback } from 'react';
import type { WebSocketMessage } from '@/lib/chat-protocol';
import { isWebSocketMessage, isWsAgentMessage } from '@/lib/chat-protocol';
import { createDebugLogger, DEBUG_CHAT_WS } from '@/lib/debug';
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

const DEBUG_CHAT_TRANSPORT = DEBUG_CHAT_WS;
const debug = createDebugLogger(DEBUG_CHAT_TRANSPORT);

// =============================================================================
// Types
// =============================================================================

export interface UseChatTransportOptions {
  dispatch: React.Dispatch<ChatAction>;
  stateRef: React.MutableRefObject<ChatState>;
  toolInputAccumulatorRef: React.MutableRefObject<ToolInputAccumulatorState>;
}

export interface UseChatTransportReturn {
  handleMessage: (data: unknown) => void;
}

/**
 * Handle Claude message with tool input streaming.
 * Expects a validated agent_message WebSocket message.
 */
function handleClaudeMessageWithStreaming(
  wsMessage: Extract<WebSocketMessage, { type: 'agent_message' }>,
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
  const { dispatch, toolInputAccumulatorRef } = options;

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

      // Handle Claude messages specially for tool input streaming
      if (isWsAgentMessage(wsMessage)) {
        handleClaudeMessageWithStreaming(wsMessage, toolInputAccumulatorRef, dispatch);
      }

      // Convert WebSocket message to action and dispatch
      const action = createActionFromWebSocketMessage(wsMessage);
      if (action) {
        dispatch(action);
      }
    },
    [dispatch, toolInputAccumulatorRef]
  );

  return { handleMessage };
}
