import {
  type ClaudeMessage,
  type ClaudeMessageWithState,
  type HistoryMessage,
  isUserMessage,
  MessageState,
  type MessageWithState,
  type QueuedMessage,
  type UserMessageState,
  type UserMessageWithState,
} from '@/shared/claude';

/**
 * Valid state transitions for user messages.
 * Maps each UserMessageState to the states it can transition to.
 */
const USER_STATE_TRANSITIONS: Record<UserMessageState, UserMessageState[]> = {
  PENDING: ['SENT'],
  SENT: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['COMMITTED', 'FAILED'],
  COMMITTED: [],
  REJECTED: [],
  FAILED: [],
  CANCELLED: [],
};

const USER_STATES = new Set<UserMessageState>(
  Object.keys(USER_STATE_TRANSITIONS) as UserMessageState[]
);

function isValidUserTransition(from: UserMessageState, to: UserMessageState): boolean {
  return USER_STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isValidTransition(
  messageType: 'user' | 'claude',
  from: MessageState,
  to: MessageState
): boolean {
  if (messageType === 'claude') {
    return false;
  }

  if (!(USER_STATES.has(from as UserMessageState) && USER_STATES.has(to as UserMessageState))) {
    return false;
  }
  return isValidUserTransition(from as UserMessageState, to as UserMessageState);
}

type UpdateStateResult =
  | {
      ok: true;
      message: UserMessageWithState;
      oldState: UserMessageState;
    }
  | {
      ok: false;
      reason: 'not_found' | 'invalid_transition' | 'non_user';
      currentState?: MessageState;
    };

/**
 * Pure message state machine and storage (no WebSocket emission).
 */
export class MessageStateMachine {
  /**
   * Messages indexed by session ID, then by message ID.
   * Map<sessionId, Map<messageId, MessageWithState>>
   */
  private sessionMessages = new Map<string, Map<string, MessageWithState>>();

  /**
   * Next order number for each session. Monotonically increasing.
   * Map<sessionId, nextOrder>
   */
  private sessionOrderCounters = new Map<string, number>();

  private getOrCreateSessionMap(sessionId: string): Map<string, MessageWithState> {
    let messages = this.sessionMessages.get(sessionId);
    if (!messages) {
      messages = new Map();
      this.sessionMessages.set(sessionId, messages);
    }
    return messages;
  }

  private getNextOrder(sessionId: string): number {
    const current = this.sessionOrderCounters.get(sessionId) ?? 0;
    this.sessionOrderCounters.set(sessionId, current + 1);
    return current;
  }

  allocateOrder(sessionId: string): number {
    return this.getNextOrder(sessionId);
  }

  createUserMessage(sessionId: string, msg: QueuedMessage): UserMessageWithState {
    const messages = this.getOrCreateSessionMap(sessionId);
    const queuePosition = this.getQueuedMessageCount(sessionId);

    const messageWithState: UserMessageWithState = {
      id: msg.id,
      type: 'user',
      state: MessageState.ACCEPTED,
      timestamp: msg.timestamp,
      text: msg.text,
      attachments: msg.attachments,
      queuePosition,
      settings: msg.settings,
      // Order is assigned when message transitions to DISPATCHED
      order: undefined,
    };

    messages.set(msg.id, messageWithState);
    return messageWithState;
  }

  createRejectedMessage(
    sessionId: string,
    messageId: string,
    errorMessage: string,
    text?: string
  ): UserMessageWithState {
    const messages = this.getOrCreateSessionMap(sessionId);

    const messageWithState: UserMessageWithState = {
      id: messageId,
      type: 'user',
      state: MessageState.REJECTED,
      timestamp: new Date().toISOString(),
      text: text ?? '',
      errorMessage,
      // Rejected messages don't get an order since they never appear in transcript
      order: undefined,
    };

    messages.set(messageId, messageWithState);
    return messageWithState;
  }

  updateState(
    sessionId: string,
    messageId: string,
    newState: MessageState,
    metadata?: { queuePosition?: number; errorMessage?: string }
  ): UpdateStateResult {
    const messages = this.sessionMessages.get(sessionId);
    const message = messages?.get(messageId);

    if (!message) {
      return { ok: false, reason: 'not_found' };
    }

    if (!isValidTransition(message.type, message.state as MessageState, newState)) {
      return {
        ok: false,
        reason: 'invalid_transition',
        currentState: message.state as MessageState,
      };
    }

    if (!isUserMessage(message)) {
      return { ok: false, reason: 'non_user', currentState: message.state as MessageState };
    }

    const oldState = message.state;
    message.state = newState as UserMessageState;
    if (metadata?.queuePosition !== undefined) {
      message.queuePosition = metadata.queuePosition;
    }
    if (metadata?.errorMessage !== undefined) {
      message.errorMessage = metadata.errorMessage;
    }

    // Assign order when transitioning to DISPATCHED (message is sent to agent)
    // This ensures queued messages appear in transcript at dispatch time, not queue time
    if (newState === MessageState.DISPATCHED && message.order === undefined) {
      message.order = this.getNextOrder(sessionId);
    }

    return { ok: true, message, oldState };
  }

  getMessage(sessionId: string, messageId: string): MessageWithState | undefined {
    return this.sessionMessages.get(sessionId)?.get(messageId);
  }

  getAllMessages(sessionId: string): MessageWithState[] {
    const messages = this.sessionMessages.get(sessionId);
    if (!messages) {
      return [];
    }

    const terminalErrorStates: Set<string> = new Set(['REJECTED', 'FAILED', 'CANCELLED']);

    return Array.from(messages.values())
      .filter((msg) => !terminalErrorStates.has(msg.state))
      .sort((a, b) => {
        // Messages without order (queued) sort to the end
        // Use a large base value plus queuePosition to maintain queue order
        const BASE_ORDER = 1_000_000_000;
        const aOrder = a.order ?? BASE_ORDER + (isUserMessage(a) ? (a.queuePosition ?? 0) : 0);
        const bOrder = b.order ?? BASE_ORDER + (isUserMessage(b) ? (b.queuePosition ?? 0) : 0);
        return aOrder - bOrder;
      });
  }

  removeMessage(sessionId: string, messageId: string): boolean {
    const messages = this.sessionMessages.get(sessionId);
    if (!messages) {
      return false;
    }
    return messages.delete(messageId);
  }

  clearSession(sessionId: string): void {
    this.sessionMessages.delete(sessionId);
    this.sessionOrderCounters.delete(sessionId);
  }

  clearAllSessions(): void {
    this.sessionMessages.clear();
    this.sessionOrderCounters.clear();
  }

  loadFromHistory(sessionId: string, history: HistoryMessage[]): void {
    const existingMessages = this.sessionMessages.get(sessionId);
    if (existingMessages && existingMessages.size > 0) {
      return;
    }

    this.sessionMessages.delete(sessionId);
    this.sessionOrderCounters.delete(sessionId);
    const messages = this.getOrCreateSessionMap(sessionId);

    for (const historyMsg of history) {
      const messageId =
        historyMsg.uuid ||
        `history-${historyMsg.timestamp}-${Math.random().toString(36).slice(2, 9)}`;

      const order = this.getNextOrder(sessionId);

      if (historyMsg.type === 'user') {
        const messageWithState: UserMessageWithState = {
          id: messageId,
          type: 'user',
          state: MessageState.COMMITTED,
          timestamp: historyMsg.timestamp,
          text: historyMsg.content,
          order,
        };
        messages.set(messageId, messageWithState);
      } else if (
        historyMsg.type === 'assistant' ||
        historyMsg.type === 'tool_use' ||
        historyMsg.type === 'tool_result' ||
        historyMsg.type === 'thinking'
      ) {
        const claudeMessage = this.historyToClaudeMessage(historyMsg);
        const messageWithState: ClaudeMessageWithState = {
          id: messageId,
          type: 'claude',
          state: MessageState.COMPLETE,
          timestamp: historyMsg.timestamp,
          chatMessages: [
            {
              id: `${messageId}-0`,
              source: 'claude',
              message: claudeMessage,
              timestamp: historyMsg.timestamp,
              order,
            },
          ],
          order,
        };
        messages.set(messageId, messageWithState);
      }
    }
  }

  hasMessage(sessionId: string, messageId: string): boolean {
    return this.sessionMessages.get(sessionId)?.has(messageId) ?? false;
  }

  getMessageCount(sessionId: string): number {
    return this.sessionMessages.get(sessionId)?.size ?? 0;
  }

  getSessionCount(): number {
    return this.sessionMessages.size;
  }

  getQueuedMessageCount(sessionId: string): number {
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

  private historyToClaudeMessage(msg: HistoryMessage): ClaudeMessage {
    switch (msg.type) {
      case 'tool_use':
        if (msg.toolName && msg.toolId) {
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
        break;

      case 'tool_result':
        if (msg.toolId) {
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
        break;

      case 'thinking':
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

    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: msg.content,
      },
    };
  }
}
