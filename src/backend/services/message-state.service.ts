/**
 * Message State Service
 *
 * Manages unified message state for chat sessions using a state machine model.
 * This service tracks all messages (user and Claude) with their states, providing:
 * - Unified message storage per session
 * - State transitions with validation
 * - State change notifications via WebSocket
 *
 * User message flow:
 *   PENDING → SENT → ACCEPTED → DISPATCHED → COMMITTED
 *                        ↘ REJECTED/FAILED/CANCELLED
 *
 * Claude message flow:
 *   STREAMING → COMPLETE
 */

import {
  type ClaudeMessage,
  type HistoryMessage,
  MessageState,
  type MessageWithState,
  type QueuedMessage,
  type SessionStatus,
} from '@/lib/claude-types';
import { chatConnectionService } from './chat-connection.service';
import { createLogger } from './logger.service';

const logger = createLogger('message-state-service');

// =============================================================================
// State Transition Validation
// =============================================================================

/**
 * Valid state transitions for user messages.
 */
const USER_STATE_TRANSITIONS: Record<MessageState, MessageState[]> = {
  [MessageState.PENDING]: [MessageState.SENT],
  [MessageState.SENT]: [MessageState.ACCEPTED, MessageState.REJECTED],
  [MessageState.ACCEPTED]: [MessageState.DISPATCHED, MessageState.CANCELLED],
  [MessageState.DISPATCHED]: [MessageState.COMMITTED, MessageState.FAILED],
  [MessageState.COMMITTED]: [],
  [MessageState.REJECTED]: [],
  [MessageState.FAILED]: [],
  [MessageState.CANCELLED]: [],
  [MessageState.STREAMING]: [],
  [MessageState.COMPLETE]: [],
};

/**
 * Valid state transitions for Claude messages.
 */
const CLAUDE_STATE_TRANSITIONS: Record<MessageState, MessageState[]> = {
  [MessageState.STREAMING]: [MessageState.COMPLETE],
  [MessageState.COMPLETE]: [],
  // User states not applicable to Claude messages
  [MessageState.PENDING]: [],
  [MessageState.SENT]: [],
  [MessageState.ACCEPTED]: [],
  [MessageState.DISPATCHED]: [],
  [MessageState.COMMITTED]: [],
  [MessageState.REJECTED]: [],
  [MessageState.FAILED]: [],
  [MessageState.CANCELLED]: [],
};

/**
 * Check if a state transition is valid.
 */
function isValidTransition(
  messageType: 'user' | 'claude',
  currentState: MessageState,
  newState: MessageState
): boolean {
  const transitions = messageType === 'user' ? USER_STATE_TRANSITIONS : CLAUDE_STATE_TRANSITIONS;
  return transitions[currentState]?.includes(newState) ?? false;
}

// =============================================================================
// MessageStateService Class
// =============================================================================

class MessageStateService {
  /**
   * Messages indexed by session ID, then by message ID.
   * Map<sessionId, Map<messageId, MessageWithState>>
   */
  private sessionMessages = new Map<string, Map<string, MessageWithState>>();

  /**
   * Get or create the message map for a session.
   */
  private getOrCreateSessionMap(sessionId: string): Map<string, MessageWithState> {
    let messages = this.sessionMessages.get(sessionId);
    if (!messages) {
      messages = new Map();
      this.sessionMessages.set(sessionId, messages);
    }
    return messages;
  }

  /**
   * Create a new user message from a QueuedMessage.
   * Starts in ACCEPTED state (backend has received it).
   */
  createUserMessage(sessionId: string, msg: QueuedMessage): MessageWithState {
    const messages = this.getOrCreateSessionMap(sessionId);

    // Queue position = count of ACCEPTED user messages (messages waiting in queue)
    const queuePosition = this.getQueuedMessageCount(sessionId);

    const messageWithState: MessageWithState = {
      id: msg.id,
      type: 'user',
      state: MessageState.ACCEPTED,
      timestamp: msg.timestamp,
      text: msg.text,
      attachments: msg.attachments,
      queuePosition,
      settings: msg.settings,
    };

    messages.set(msg.id, messageWithState);

    logger.info('User message created', {
      sessionId,
      messageId: msg.id,
      state: messageWithState.state,
      queuePosition,
    });

    this.emitStateChange(sessionId, messageWithState);
    return messageWithState;
  }

  /**
   * Create a rejected user message.
   * Used when a message is rejected before being accepted (e.g., queue validation failure).
   * Starts directly in REJECTED state.
   */
  createRejectedMessage(
    sessionId: string,
    messageId: string,
    errorMessage: string,
    text?: string
  ): MessageWithState {
    const messages = this.getOrCreateSessionMap(sessionId);

    const messageWithState: MessageWithState = {
      id: messageId,
      type: 'user',
      state: MessageState.REJECTED,
      timestamp: new Date().toISOString(),
      text,
      errorMessage,
    };

    messages.set(messageId, messageWithState);

    logger.info('User message rejected', {
      sessionId,
      messageId,
      errorMessage,
    });

    this.emitStateChange(sessionId, messageWithState);
    return messageWithState;
  }

  /**
   * Get count of user messages in ACCEPTED state (waiting in queue).
   */
  private getQueuedMessageCount(sessionId: string): number {
    const messages = this.sessionMessages.get(sessionId);
    if (!messages) {
      return 0;
    }

    let count = 0;
    for (const msg of messages.values()) {
      if (msg.type === 'user' && msg.state === MessageState.ACCEPTED) {
        count++;
      }
    }
    return count;
  }

  /**
   * Create a new Claude message.
   * Starts in STREAMING state.
   */
  createClaudeMessage(
    sessionId: string,
    messageId: string,
    content?: ClaudeMessage
  ): MessageWithState {
    const messages = this.getOrCreateSessionMap(sessionId);

    const messageWithState: MessageWithState = {
      id: messageId,
      type: 'claude',
      state: MessageState.STREAMING,
      timestamp: new Date().toISOString(),
      content,
    };

    messages.set(messageId, messageWithState);

    logger.info('Claude message created', {
      sessionId,
      messageId,
      state: messageWithState.state,
    });

    this.emitStateChange(sessionId, messageWithState);
    return messageWithState;
  }

  /**
   * Update the state of an existing message.
   * Validates state transitions and emits state change events.
   */
  updateState(
    sessionId: string,
    messageId: string,
    newState: MessageState,
    metadata?: { queuePosition?: number; errorMessage?: string }
  ): boolean {
    const messages = this.sessionMessages.get(sessionId);
    const message = messages?.get(messageId);

    if (!message) {
      logger.warn('Message not found for state update', { sessionId, messageId, newState });
      return false;
    }

    // Validate state transition
    if (!isValidTransition(message.type, message.state, newState)) {
      logger.warn('Invalid state transition', {
        sessionId,
        messageId,
        currentState: message.state,
        newState,
        messageType: message.type,
      });
      return false;
    }

    const oldState = message.state;
    message.state = newState;

    // Update metadata if provided
    if (metadata?.queuePosition !== undefined) {
      message.queuePosition = metadata.queuePosition;
    }
    if (metadata?.errorMessage !== undefined) {
      message.errorMessage = metadata.errorMessage;
    }

    logger.info('Message state updated', {
      sessionId,
      messageId,
      oldState,
      newState,
    });

    this.emitStateChange(sessionId, message);
    return true;
  }

  /**
   * Update Claude message content (for streaming updates).
   */
  updateClaudeContent(sessionId: string, messageId: string, content: ClaudeMessage): boolean {
    const messages = this.sessionMessages.get(sessionId);
    const message = messages?.get(messageId);

    if (!message || message.type !== 'claude') {
      return false;
    }

    message.content = content;
    // Don't emit state change for content updates - this would be too noisy
    return true;
  }

  /**
   * Get a specific message.
   */
  getMessage(sessionId: string, messageId: string): MessageWithState | undefined {
    return this.sessionMessages.get(sessionId)?.get(messageId);
  }

  /**
   * Get all messages for a session, ordered by timestamp.
   */
  getAllMessages(sessionId: string): MessageWithState[] {
    const messages = this.sessionMessages.get(sessionId);
    if (!messages) {
      return [];
    }

    return Array.from(messages.values()).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  /**
   * Remove a message from the session.
   */
  removeMessage(sessionId: string, messageId: string): boolean {
    const messages = this.sessionMessages.get(sessionId);
    if (!messages) {
      return false;
    }

    const removed = messages.delete(messageId);
    if (removed) {
      logger.info('Message removed', { sessionId, messageId });
    }
    return removed;
  }

  /**
   * Clear all messages for a session.
   */
  clearSession(sessionId: string): void {
    const messages = this.sessionMessages.get(sessionId);
    if (messages && messages.size > 0) {
      logger.info('Session messages cleared', {
        sessionId,
        clearedCount: messages.size,
      });
    }
    this.sessionMessages.delete(sessionId);
  }

  /**
   * Clear ALL sessions. Used for test isolation to reset singleton state.
   */
  clearAllSessions(): void {
    const sessionCount = this.sessionMessages.size;
    this.sessionMessages.clear();
    if (sessionCount > 0) {
      logger.info('All sessions cleared', { clearedCount: sessionCount });
    }
  }

  /**
   * Load messages from JSONL history (used on cold start/reconnect).
   * Converts HistoryMessage[] to MessageWithState[] with COMMITTED/COMPLETE states.
   * Does not emit state change events - this is for restoring existing state.
   *
   * Race condition protection:
   * If the session already has messages, we skip loading to avoid overwriting
   * fresh state (user messages, streaming responses) with stale history.
   *
   * Why this is safe: The check (existingMessages.size > 0) and the subsequent
   * return happen synchronously with no await points in between. Since JavaScript
   * is single-threaded and only yields at await/callback boundaries, no other
   * code can modify the session's messages between the check and the return.
   * Therefore, if another caller adds messages after our check, we've already
   * returned and won't overwrite their state.
   */
  loadFromHistory(sessionId: string, history: HistoryMessage[]): void {
    const existingMessages = this.sessionMessages.get(sessionId);
    if (existingMessages && existingMessages.size > 0) {
      logger.info('Skipping history load - session already has messages', {
        sessionId,
        existingCount: existingMessages.size,
      });
      return;
    }

    // Clear any existing messages for this session (handles empty map case)
    this.sessionMessages.delete(sessionId);
    const messages = this.getOrCreateSessionMap(sessionId);

    for (const historyMsg of history) {
      const messageId =
        historyMsg.uuid ||
        `history-${historyMsg.timestamp}-${Math.random().toString(36).slice(2, 9)}`;

      if (historyMsg.type === 'user') {
        // User text message - already committed
        const messageWithState: MessageWithState = {
          id: messageId,
          type: 'user',
          state: MessageState.COMMITTED,
          timestamp: historyMsg.timestamp,
          text: historyMsg.content,
        };
        messages.set(messageId, messageWithState);
      } else if (
        historyMsg.type === 'assistant' ||
        historyMsg.type === 'tool_use' ||
        historyMsg.type === 'tool_result' ||
        historyMsg.type === 'thinking'
      ) {
        // Claude messages - already complete
        const messageWithState: MessageWithState = {
          id: messageId,
          type: 'claude',
          state: MessageState.COMPLETE,
          timestamp: historyMsg.timestamp,
          // Store minimal content representation for history messages
          content: this.historyToClaudeMessage(historyMsg),
        };
        messages.set(messageId, messageWithState);
      }
    }

    logger.info('Loaded messages from history', {
      sessionId,
      messageCount: messages.size,
    });
  }

  /**
   * Convert a HistoryMessage to a ClaudeMessage for storage.
   */
  private historyToClaudeMessage(msg: HistoryMessage): ClaudeMessage {
    if (msg.type === 'tool_use' && msg.toolName && msg.toolId) {
      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: msg.toolId,
              name: msg.toolName,
              input: msg.toolInput ?? {},
            },
          ],
        },
      };
    }

    if (msg.type === 'tool_result' && msg.toolId) {
      return {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolId,
              content: msg.content,
              is_error: msg.isError,
            },
          ],
        },
      };
    }

    if (msg.type === 'thinking') {
      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: msg.content,
            },
          ],
        },
      };
    }

    // Default: assistant text message
    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: msg.content,
      },
    };
  }

  /**
   * Check if a message exists in a session.
   */
  hasMessage(sessionId: string, messageId: string): boolean {
    return this.sessionMessages.get(sessionId)?.has(messageId) ?? false;
  }

  /**
   * Get count of messages in a session.
   */
  getMessageCount(sessionId: string): number {
    return this.sessionMessages.get(sessionId)?.size ?? 0;
  }

  /**
   * Send a full messages snapshot to all connections for a session.
   * Used on initial connect and reconnect.
   */
  sendSnapshot(
    sessionId: string,
    sessionStatus: SessionStatus,
    pendingInteractiveRequest?: {
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      planContent?: string | null;
      timestamp: string;
    } | null
  ): void {
    const messages = this.getAllMessages(sessionId);

    chatConnectionService.forwardToSession(sessionId, {
      type: 'messages_snapshot',
      allMessages: messages,
      sessionStatus,
      pendingInteractiveRequest,
    });

    logger.info('Messages snapshot sent', {
      sessionId,
      messageCount: messages.length,
    });
  }

  /**
   * Emit a state change event to all connections for a session.
   */
  private emitStateChange(sessionId: string, message: MessageWithState): void {
    chatConnectionService.forwardToSession(sessionId, {
      type: 'message_state_changed',
      id: message.id,
      newState: message.state,
      queuePosition: message.queuePosition,
      errorMessage: message.errorMessage,
    });
  }
}

// Export singleton instance
export const messageStateService = new MessageStateService();
