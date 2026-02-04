/**
 * Message State Service
 *
 * Manages unified message state for chat sessions using a state machine model.
 * This service tracks all messages (user and Claude) with their states, providing:
 * - Unified message storage per session
 * - State transitions with validation
 * - State change notifications via domain events
 *
 * User message flow:
 *   PENDING → SENT → ACCEPTED → DISPATCHED → COMMITTED
 *                        ↘ REJECTED/FAILED/CANCELLED
 *
 * Claude message flow:
 *   STREAMING → COMPLETE
 */

import { EventEmitter } from 'node:events';
import {
  type ChatMessage,
  type HistoryMessage,
  isUserMessage,
  MessageState,
  type MessageWithState,
  type QueuedMessage,
  type SessionStatus,
  type UserMessageWithState,
} from '@/shared/claude';
import { createLogger } from './logger.service';
import { MessageEventStore } from './message-event-store';
import { isValidTransition, MessageStateMachine } from './message-state-machine';

const logger = createLogger('message-state-service');

// =============================================================================
// MessageStateService Class
// =============================================================================

export type MessageStateEvent =
  | {
      type: 'message_state_changed';
      sessionId: string;
      data: {
        id: string;
        newState: MessageState;
        queuePosition?: number;
        errorMessage?: string;
        userMessage?: {
          text: string;
          timestamp: string;
          attachments?: UserMessageWithState['attachments'];
          settings: UserMessageWithState['settings'];
          order: number;
        };
      };
    }
  | {
      type: 'messages_snapshot';
      sessionId: string;
      data: {
        messages: ChatMessage[];
        sessionStatus: SessionStatus;
        pendingInteractiveRequest?: {
          requestId: string;
          toolName: string;
          input: Record<string, unknown>;
          planContent?: string | null;
          timestamp: string;
        } | null;
      };
    };

class MessageStateService {
  private stateMachine = new MessageStateMachine();
  private eventStore = new MessageEventStore();
  private emitter = new EventEmitter();

  onEvent(listener: (event: MessageStateEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }

  hasEventListener(listener: (event: MessageStateEvent) => void): boolean {
    return this.emitter.listeners('event').includes(listener);
  }

  /**
   * Allocate and return the next order number for a session.
   * Used for messages created outside the normal message state flow
   * (e.g., MESSAGE_USED_AS_RESPONSE).
   */
  allocateOrder(sessionId: string): number {
    return this.stateMachine.allocateOrder(sessionId);
  }

  /**
   * Create a new user message from a QueuedMessage.
   * Starts in ACCEPTED state (backend has received it).
   */
  createUserMessage(sessionId: string, msg: QueuedMessage): UserMessageWithState {
    const messageWithState = this.stateMachine.createUserMessage(sessionId, msg);

    logger.info('User message created', {
      sessionId,
      messageId: msg.id,
      state: messageWithState.state,
      queuePosition: messageWithState.queuePosition,
      order: messageWithState.order,
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
  ): UserMessageWithState {
    const messageWithState = this.stateMachine.createRejectedMessage(
      sessionId,
      messageId,
      errorMessage,
      text
    );

    logger.info('User message rejected', {
      sessionId,
      messageId,
      errorMessage,
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
    const message = this.stateMachine.getMessage(sessionId, messageId);

    if (!message) {
      logger.warn('Message not found for state update', { sessionId, messageId, newState });
      return false;
    }

    // Validate state transition using the string value
    if (!isValidTransition(message.type, message.state as MessageState, newState)) {
      logger.warn('Invalid state transition', {
        sessionId,
        messageId,
        currentState: message.state,
        newState,
        messageType: message.type,
      });
      return false;
    }

    const updateResult = this.stateMachine.updateState(sessionId, messageId, newState, metadata);
    if (!updateResult.ok) {
      if (updateResult.reason === 'non_user') {
        logger.error('Unexpected state update for non-user message', {
          sessionId,
          messageId,
          messageType: message.type,
        });
      }
      return false;
    }

    logger.info('Message state updated', {
      sessionId,
      messageId,
      oldState: updateResult.oldState,
      newState,
    });

    this.emitStateChange(sessionId, updateResult.message);
    return true;
  }

  /**
   * Get a specific message.
   */
  getMessage(sessionId: string, messageId: string): MessageWithState | undefined {
    return this.stateMachine.getMessage(sessionId, messageId);
  }

  /**
   * Get all messages for a session, ordered by their assigned order.
   * Filters out terminal error states (REJECTED, FAILED, CANCELLED) since these
   * messages were never successfully processed and shouldn't appear in snapshots.
   */
  getAllMessages(sessionId: string): MessageWithState[] {
    return this.stateMachine.getAllMessages(sessionId);
  }

  /**
   * Remove a message from the session.
   */
  removeMessage(sessionId: string, messageId: string): boolean {
    const removed = this.stateMachine.removeMessage(sessionId, messageId);
    if (removed) {
      logger.info('Message removed', { sessionId, messageId });
    }
    return removed;
  }

  /**
   * Clear all messages for a session.
   */
  clearSession(sessionId: string): void {
    const messageCount = this.stateMachine.getMessageCount(sessionId);
    if (messageCount > 0) {
      logger.info('Session messages cleared', {
        sessionId,
        clearedCount: messageCount,
      });
    }
    this.stateMachine.clearSession(sessionId);
    this.eventStore.clearSession(sessionId);
  }

  /**
   * Inject a synthetic user message that appears as already committed.
   * Used for auto-generated prompts (e.g., GitHub issue content) that should
   * appear in the chat history as if the user sent them.
   */
  injectCommittedUserMessage(
    sessionId: string,
    text: string,
    options?: { messageId?: string }
  ): void {
    const messageId = options?.messageId ?? `injected-${Date.now()}`;
    const timestamp = new Date().toISOString();

    // Create a QueuedMessage structure
    const queuedMessage: QueuedMessage = {
      id: messageId,
      text,
      timestamp,
      settings: {
        selectedModel: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    };

    // Create the user message (starts in ACCEPTED state)
    const message = this.stateMachine.createUserMessage(sessionId, queuedMessage);

    // Transition through states to COMMITTED
    this.stateMachine.updateState(sessionId, messageId, MessageState.DISPATCHED);
    this.stateMachine.updateState(sessionId, messageId, MessageState.COMMITTED);

    logger.info('Injected committed user message', {
      sessionId,
      messageId,
      textLength: text.length,
    });

    // Emit state change so the UI knows about this message
    this.emitStateChange(sessionId, {
      ...message,
      state: MessageState.COMMITTED,
    });
  }

  // =============================================================================
  // Event Storage for Replay
  // =============================================================================

  /**
   * Store a raw WebSocket event for replay on reconnect.
   * Called by chatEventForwarderService for every event sent to WebSocket.
   */
  storeEvent(sessionId: string, event: { type: string; data?: unknown }): void {
    this.eventStore.storeEvent(sessionId, event);
  }

  /**
   * Get all stored events for a session (for replay on reconnect).
   */
  getStoredEvents(sessionId: string): Array<{ type: string; data?: unknown }> {
    return this.eventStore.getStoredEvents(sessionId);
  }

  /**
   * Clear stored events for a session (called when session is loaded from JSONL).
   */
  clearStoredEvents(sessionId: string): void {
    this.eventStore.clearSession(sessionId);
  }

  /**
   * Clear ALL sessions. Used for test isolation to reset singleton state.
   */
  clearAllSessions(): void {
    const sessionCount = this.stateMachine.getSessionCount();
    this.stateMachine.clearAllSessions();
    this.eventStore.clearAllSessions();
    // Test isolation: ensure no lingering domain listeners.
    this.emitter.removeAllListeners('event');
    if (sessionCount && sessionCount > 0) {
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
    const existingCount = this.stateMachine.getMessageCount(sessionId);
    if (existingCount > 0) {
      logger.info('Skipping history load - session already has messages', {
        sessionId,
        existingCount,
      });
      return;
    }

    this.stateMachine.loadFromHistory(sessionId, history);

    logger.info('Loaded messages from history', {
      sessionId,
      messageCount: this.stateMachine.getMessageCount(sessionId),
    });
  }

  /**
   * Ensure history is loaded, preserving queued (ACCEPTED) messages if present.
   *
   * This is used when starting a new cloud process to rebuild ordering from
   * JSONL history while keeping any queued user messages that haven't been
   * dispatched yet.
   *
   * Returns true when history was reloaded, false when existing non-queued
   * messages indicate history is already present.
   */
  ensureHistoryLoaded(sessionId: string, history: HistoryMessage[]): boolean {
    const existingMessages = this.getAllMessages(sessionId);
    const queuedMessages: QueuedMessage[] = [];
    let hasNonQueuedMessages = false;

    for (const message of existingMessages) {
      if (isUserMessage(message) && message.state === MessageState.ACCEPTED) {
        queuedMessages.push({
          id: message.id,
          text: message.text,
          timestamp: message.timestamp,
          attachments: message.attachments,
          settings: message.settings ?? {
            selectedModel: null,
            thinkingEnabled: false,
            planModeEnabled: false,
          },
        });
        continue;
      }

      hasNonQueuedMessages = true;
      break;
    }

    if (hasNonQueuedMessages) {
      logger.info('Skipping history load - session already has non-queued messages', {
        sessionId,
        existingCount: existingMessages.length,
      });
      return false;
    }

    this.clearSession(sessionId);
    this.stateMachine.loadFromHistory(sessionId, history);
    for (const queuedMessage of queuedMessages) {
      this.stateMachine.createUserMessage(sessionId, queuedMessage);
    }

    logger.info('Loaded messages from history with queued preservation', {
      sessionId,
      historyCount: history.length,
      queuedCount: queuedMessages.length,
      messageCount: this.stateMachine.getMessageCount(sessionId),
    });

    return true;
  }

  /**
   * Check if a message exists in a session.
   */
  hasMessage(sessionId: string, messageId: string): boolean {
    return this.stateMachine.hasMessage(sessionId, messageId);
  }

  /**
   * Get count of messages in a session.
   */
  getMessageCount(sessionId: string): number {
    return this.stateMachine.getMessageCount(sessionId);
  }

  /**
   * Emit a full messages snapshot event for a session.
   * Used on initial connect and reconnect to synchronize client state.
   *
   * Flattens user messages and Claude chatMessages into a single ChatMessage[]
   * array, so frontend receives messages in the exact format it uses.
   *
   * @param sessionId - The database session ID
   * @param sessionStatus - Current session lifecycle status (idle, loading, starting, ready, running, stopping)
   * @param pendingInteractiveRequest - Optional pending interactive request awaiting user response.
   *   If present, the frontend will display the appropriate UI (permission dialog or question form).
   *   Structure includes:
   *   - requestId: Unique identifier for the request
   *   - toolName: The tool requesting interaction (e.g., 'AskUserQuestion', 'ExitPlanMode')
   *   - input: Tool-specific input parameters
   *   - planContent: Optional markdown content for ExitPlanMode requests
   *   - timestamp: When the request was created
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
    const allMessages = this.getAllMessages(sessionId);

    // Flatten to ChatMessage[] - user messages become ChatMessages,
    // Claude messages expand their chatMessages array
    const chatMessages: ChatMessage[] = [];
    for (const msg of allMessages) {
      if (isUserMessage(msg)) {
        chatMessages.push({
          id: msg.id,
          source: 'user',
          text: msg.text,
          timestamp: msg.timestamp,
          attachments: msg.attachments,
          order: msg.order,
        });
      } else {
        // Claude message - add all its chatMessages (they already have order from history load)
        chatMessages.push(...msg.chatMessages);
      }
    }

    this.emitter.emit('event', {
      type: 'messages_snapshot',
      sessionId,
      data: {
        messages: chatMessages,
        sessionStatus,
        pendingInteractiveRequest,
      },
    } satisfies MessageStateEvent);

    // After sending snapshot, send MESSAGE_STATE_CHANGED events for any queued messages
    // (messages in ACCEPTED state). This allows the frontend to repopulate its queuedMessages
    // Map so queued messages are styled correctly (e.g., opacity-50).
    for (const msg of allMessages) {
      if (isUserMessage(msg) && msg.state === MessageState.ACCEPTED) {
        this.emitStateChange(sessionId, msg);
      }
    }

    logger.info('Messages snapshot sent', {
      sessionId,
      messageCount: chatMessages.length,
    });
  }

  /**
   * Compute the session status based on client state and queued messages.
   *
   * @param sessionId - The database session ID
   * @param isClientRunning - Whether the Claude client is currently running
   * @returns SessionStatus with appropriate phase:
   *   - 'running' if client is running
   *   - 'starting' if client is NOT running but there are queued messages waiting
   *   - 'ready' otherwise
   */
  computeSessionStatus(sessionId: string, isClientRunning: boolean): SessionStatus {
    if (isClientRunning) {
      return { phase: 'running' };
    }

    // Check if there are messages waiting to be dispatched
    const queuedCount = this.stateMachine.getQueuedMessageCount(sessionId);
    if (queuedCount > 0) {
      return { phase: 'starting' };
    }

    return { phase: 'ready' };
  }

  /**
   * Emit a state change event to all connections for a session.
   * For user messages in ACCEPTED state, includes full message content so
   * clients can add the message without needing optimistic updates.
   */
  private emitStateChange(sessionId: string, message: MessageWithState): void {
    // Extract user-specific fields only if this is a user message
    const queuePosition = isUserMessage(message) ? message.queuePosition : undefined;
    const errorMessage = isUserMessage(message) ? message.errorMessage : undefined;

    // For ACCEPTED user messages, include full content so frontend can add the message
    const userMessage =
      isUserMessage(message) && message.state === MessageState.ACCEPTED
        ? {
            text: message.text,
            timestamp: message.timestamp,
            attachments: message.attachments,
            settings: message.settings,
            order: message.order,
          }
        : undefined;

    this.emitter.emit('event', {
      type: 'message_state_changed',
      sessionId,
      data: {
        id: message.id,
        newState: message.state as MessageState,
        queuePosition,
        errorMessage,
        userMessage,
      },
    } satisfies MessageStateEvent);
  }
}

// Export singleton instance
export const messageStateService = new MessageStateService();
