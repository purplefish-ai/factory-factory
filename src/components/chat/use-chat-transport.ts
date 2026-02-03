'use client';

import { useCallback } from 'react';
import type {
  ClaudeMessage,
  ClaudeStreamEvent,
  InputJsonDelta,
  WebSocketMessage,
} from '@/lib/claude-types';
import { isStreamEventMessage, isWebSocketMessage, isWsClaudeMessage } from '@/lib/claude-types';
import { createDebugLogger } from '@/lib/debug';
import type { ChatAction, ChatState } from './chat-reducer';
import { createActionFromWebSocketMessage } from './chat-reducer';

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
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>;
  rewindTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}

export interface UseChatTransportReturn {
  handleMessage: (data: unknown) => void;
}

// =============================================================================
// Streaming Helpers
// =============================================================================

/**
 * Get stream event data from a Claude message.
 * Returns the event if the message is a stream_event type, null otherwise.
 */
function getStreamEvent(claudeMsg: ClaudeMessage): ClaudeStreamEvent | null {
  if (!isStreamEventMessage(claudeMsg)) {
    return null;
  }
  return claudeMsg.event;
}

/**
 * Handle tool_use block start - initialize accumulator.
 */
function handleToolUseStart(
  event: ClaudeStreamEvent,
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>
): void {
  if (event.type !== 'content_block_start') {
    return;
  }
  const block = event.content_block;
  if (block.type === 'tool_use' && block.id) {
    const toolUseId = block.id;
    toolInputAccumulatorRef.current.set(toolUseId, '');
    debug.log('Tool use started:', toolUseId, block.name);
  }
}

/**
 * Handle tool input JSON delta - accumulate and try to parse.
 * Returns a TOOL_INPUT_UPDATE action if valid JSON was accumulated, null otherwise.
 */
function handleToolInputDelta(
  event: ClaudeStreamEvent,
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>
): ChatAction | null {
  if (event.type !== 'content_block_delta') {
    return null;
  }

  // Cast delta to check for input_json_delta
  const delta = event.delta as InputJsonDelta | typeof event.delta;
  if (delta.type !== 'input_json_delta' || !('partial_json' in delta)) {
    return null;
  }

  const accumulatorEntries = Array.from(toolInputAccumulatorRef.current.entries());
  if (accumulatorEntries.length === 0) {
    return null;
  }

  // Get the last (most recent) tool_use_id
  const [toolUseId, currentJson] = accumulatorEntries[accumulatorEntries.length - 1];
  const newJson = currentJson + delta.partial_json;
  toolInputAccumulatorRef.current.set(toolUseId, newJson);

  // Try to parse the accumulated JSON and create update action
  try {
    const parsedInput = JSON.parse(newJson) as Record<string, unknown>;
    debug.log('Tool input updated:', toolUseId, Object.keys(parsedInput));
    return { type: 'TOOL_INPUT_UPDATE', payload: { toolUseId, input: parsedInput } };
  } catch {
    // JSON not complete yet, that's expected during streaming
    return null;
  }
}

/**
 * Handle tool input accumulation from stream events.
 * Returns a TOOL_INPUT_UPDATE action if input was accumulated, null otherwise.
 */
export function handleToolInputStreaming(
  claudeMsg: ClaudeMessage,
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>
): ChatAction | null {
  const event = getStreamEvent(claudeMsg);
  if (!event) {
    return null;
  }

  // Initialize accumulator for tool_use start events
  handleToolUseStart(event, toolInputAccumulatorRef);

  // Handle input JSON deltas
  return handleToolInputDelta(event, toolInputAccumulatorRef);
}

/**
 * Handle thinking delta stream events (extended thinking mode).
 * Returns a THINKING_DELTA action for thinking deltas, THINKING_CLEAR for message_start, null otherwise.
 */
export function handleThinkingStreaming(claudeMsg: ClaudeMessage): ChatAction | null {
  const event = getStreamEvent(claudeMsg);
  if (!event) {
    return null;
  }

  // Clear thinking on new message start
  if (event.type === 'message_start') {
    return { type: 'THINKING_CLEAR' };
  }

  // Accumulate thinking delta
  if (event.type === 'content_block_delta') {
    const delta = event.delta;
    if (delta.type === 'thinking_delta') {
      return { type: 'THINKING_DELTA', payload: { thinking: delta.thinking } };
    }
  }

  return null;
}

/**
 * Handle Claude message with tool input streaming.
 * Expects a validated claude_message WebSocket message.
 */
function handleClaudeMessageWithStreaming(
  wsMessage: WebSocketMessage & { type: 'claude_message'; data: ClaudeMessage },
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>,
  dispatch: React.Dispatch<ChatAction>
): void {
  const claudeMsg = wsMessage.data;

  // Handle tool input streaming before the main action
  const toolInputAction = handleToolInputStreaming(claudeMsg, toolInputAccumulatorRef);
  if (toolInputAction) {
    dispatch(toolInputAction);
    // Don't return - still need to dispatch the main action for content_block_start
  }

  // Handle thinking streaming (extended thinking mode)
  const thinkingAction = handleThinkingStreaming(claudeMsg);
  if (thinkingAction) {
    dispatch(thinkingAction);
    // Don't return - THINKING_CLEAR also needs the main action to process
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
