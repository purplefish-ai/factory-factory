import { useCallback } from 'react';
import { dispatchSubagentChange } from '@/client/lib/subagent-events';
import type { WebSocketMessage } from '@/lib/chat-protocol';
import type { ChatAction, ChatState } from './reducer';
import { createActionFromWebSocketMessage } from './reducer';
import {
  clearToolInputAccumulator,
  handleToolInputStreaming,
  type ToolInputAccumulatorState,
} from './streaming-utils';

// =============================================================================
// Types
// =============================================================================

export interface UseChatTransportOptions {
  dispatch: React.Dispatch<ChatAction>;
  stateRef: React.MutableRefObject<ChatState>;
  toolInputAccumulatorRef: React.MutableRefObject<ToolInputAccumulatorState>;
}

export interface UseChatTransportReturn {
  /** Handles a frame already validated by `parseChatServerMessage`. */
  handleMessage: (message: WebSocketMessage) => void;
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

function dispatchEphemeralBrowserEvent(wsMessage: WebSocketMessage): boolean {
  if (wsMessage.type === 'subagents_changed') {
    dispatchSubagentChange({
      sessionId: wsMessage.sessionId,
      subagentId: wsMessage.subagentId,
      change: wsMessage.change,
    });
    return true;
  }

  if (wsMessage.type === 'workspace_notification_request') {
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
    return true;
  }

  return false;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useChatTransport(options: UseChatTransportOptions): UseChatTransportReturn {
  const { dispatch, toolInputAccumulatorRef } = options;

  const handleMessage = useCallback(
    (wsMessage: WebSocketMessage) => {
      // session_delta wraps an inner websocket event from the SessionStore stream
      if (wsMessage.type === 'session_delta') {
        handleMessage(wsMessage.data);
        return;
      }

      if (wsMessage.type === 'session_snapshot' || wsMessage.type === 'session_replay_batch') {
        clearToolInputAccumulator(toolInputAccumulatorRef.current);
      }

      if (dispatchEphemeralBrowserEvent(wsMessage)) {
        return;
      }

      // Handle Claude messages specially for tool input streaming
      if (wsMessage.type === 'agent_message') {
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
