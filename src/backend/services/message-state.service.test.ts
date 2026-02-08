/**
 * Tests for the MessageStateService.
 *
 * Tests the message state machine that manages unified message state for chat sessions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { HistoryMessage, QueuedMessage } from '@/shared/claude';
import { isClaudeMessage, isUserMessage, MessageState } from '@/shared/claude';
import { type MessageStateEvent, messageStateService } from './message-state.service';

// =============================================================================
// Test Helpers
// =============================================================================

function createTestQueuedMessage(id: string, text = 'Test message'): QueuedMessage {
  return {
    id,
    text,
    settings: {
      selectedModel: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
    timestamp: new Date().toISOString(),
  };
}

function createTestHistoryMessage(
  type: HistoryMessage['type'],
  content: string,
  uuid?: string
): HistoryMessage {
  return {
    type,
    content,
    timestamp: new Date().toISOString(),
    uuid,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('MessageStateService', () => {
  // Clear ALL sessions between tests to ensure isolation
  beforeEach(() => {
    messageStateService.clearAllSessions();
  });

  function collectEvents(): { events: MessageStateEvent[]; unsubscribe: () => void } {
    const events: MessageStateEvent[] = [];
    const unsubscribe = messageStateService.onEvent((event) => {
      events.push(event);
    });
    return { events, unsubscribe };
  }

  // ---------------------------------------------------------------------------
  // createUserMessage
  // ---------------------------------------------------------------------------

  describe('createUserMessage', () => {
    it('should create a user message in ACCEPTED state', () => {
      const msg = createTestQueuedMessage('msg-1');
      const result = messageStateService.createUserMessage('session-1', msg);

      expect(result.id).toBe('msg-1');
      expect(result.type).toBe('user');
      expect(result.state).toBe(MessageState.ACCEPTED);
      expect(result.text).toBe('Test message');
    });

    it('should assign queue position 0 for first message', () => {
      const msg = createTestQueuedMessage('msg-1');
      const result = messageStateService.createUserMessage('session-1', msg);

      expect(result.queuePosition).toBe(0);
    });

    it('should increment queue position for subsequent ACCEPTED messages', () => {
      const msg1 = createTestQueuedMessage('msg-1');
      const msg2 = createTestQueuedMessage('msg-2');
      const msg3 = createTestQueuedMessage('msg-3');

      const result1 = messageStateService.createUserMessage('session-1', msg1);
      const result2 = messageStateService.createUserMessage('session-1', msg2);
      const result3 = messageStateService.createUserMessage('session-1', msg3);

      expect(result1.queuePosition).toBe(0);
      expect(result2.queuePosition).toBe(1);
      expect(result3.queuePosition).toBe(2);
    });

    it('should not count dispatched messages in queue position', () => {
      const msg1 = createTestQueuedMessage('msg-1');
      const msg2 = createTestQueuedMessage('msg-2');

      messageStateService.createUserMessage('session-1', msg1);
      messageStateService.updateState('session-1', 'msg-1', MessageState.DISPATCHED);

      const result2 = messageStateService.createUserMessage('session-1', msg2);

      // msg-1 is DISPATCHED, so msg-2 should have queue position 0
      expect(result2.queuePosition).toBe(0);
    });

    it('should preserve attachments', () => {
      const msg: QueuedMessage = {
        id: 'msg-with-attachment',
        text: 'Check this image',
        attachments: [
          { id: 'att-1', name: 'image.png', type: 'image/png', size: 1024, data: 'base64data' },
        ],
        settings: { selectedModel: 'opus', thinkingEnabled: true, planModeEnabled: false },
        timestamp: new Date().toISOString(),
      };

      const result = messageStateService.createUserMessage('session-1', msg);

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments?.[0]?.name).toBe('image.png');
    });

    it('should emit state change event with full message content', () => {
      const { events, unsubscribe } = collectEvents();
      const msg = createTestQueuedMessage('msg-1');
      messageStateService.createUserMessage('session-1', msg);
      unsubscribe();

      expect(events).toEqual([
        {
          type: 'message_state_changed',
          sessionId: 'session-1',
          data: {
            id: 'msg-1',
            newState: MessageState.ACCEPTED,
            queuePosition: 0,
            errorMessage: undefined,
            // For ACCEPTED state, includes full user message content but no order yet
            userMessage: {
              text: msg.text,
              timestamp: msg.timestamp,
              attachments: msg.attachments,
              settings: msg.settings,
              order: undefined,
            },
          },
        },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // updateState
  // ---------------------------------------------------------------------------

  describe('updateState', () => {
    it('should allow valid user message state transitions', () => {
      const msg = createTestQueuedMessage('msg-1');
      messageStateService.createUserMessage('session-1', msg);

      // ACCEPTED -> DISPATCHED
      const result1 = messageStateService.updateState(
        'session-1',
        'msg-1',
        MessageState.DISPATCHED
      );
      expect(result1).toBe(true);
      expect(messageStateService.getMessage('session-1', 'msg-1')?.state).toBe(
        MessageState.DISPATCHED
      );

      // DISPATCHED -> COMMITTED
      const result2 = messageStateService.updateState('session-1', 'msg-1', MessageState.COMMITTED);
      expect(result2).toBe(true);
      expect(messageStateService.getMessage('session-1', 'msg-1')?.state).toBe(
        MessageState.COMMITTED
      );
    });

    it('should allow ACCEPTED -> CANCELLED transition', () => {
      const msg = createTestQueuedMessage('msg-1');
      messageStateService.createUserMessage('session-1', msg);

      const result = messageStateService.updateState('session-1', 'msg-1', MessageState.CANCELLED);
      expect(result).toBe(true);
      expect(messageStateService.getMessage('session-1', 'msg-1')?.state).toBe(
        MessageState.CANCELLED
      );
    });

    it('should allow DISPATCHED -> FAILED transition', () => {
      const msg = createTestQueuedMessage('msg-1');
      messageStateService.createUserMessage('session-1', msg);
      messageStateService.updateState('session-1', 'msg-1', MessageState.DISPATCHED);

      const result = messageStateService.updateState('session-1', 'msg-1', MessageState.FAILED, {
        errorMessage: 'Something went wrong',
      });

      expect(result).toBe(true);
      const updatedMsg = messageStateService.getMessage('session-1', 'msg-1');
      expect(updatedMsg?.state).toBe(MessageState.FAILED);
      expect(updatedMsg && isUserMessage(updatedMsg) ? updatedMsg.errorMessage : undefined).toBe(
        'Something went wrong'
      );
    });

    it('should reject invalid state transitions', () => {
      const msg = createTestQueuedMessage('msg-1');
      messageStateService.createUserMessage('session-1', msg);

      // ACCEPTED -> COMMITTED is invalid (must go through DISPATCHED)
      const result = messageStateService.updateState('session-1', 'msg-1', MessageState.COMMITTED);
      expect(result).toBe(false);
      expect(messageStateService.getMessage('session-1', 'msg-1')?.state).toBe(
        MessageState.ACCEPTED
      );
    });

    it('should return false for non-existent message', () => {
      const result = messageStateService.updateState(
        'session-1',
        'non-existent',
        MessageState.DISPATCHED
      );
      expect(result).toBe(false);
    });

    it('should emit state change event on success', () => {
      const msg = createTestQueuedMessage('msg-1');
      messageStateService.createUserMessage('session-1', msg);
      const { events, unsubscribe } = collectEvents();

      messageStateService.updateState('session-1', 'msg-1', MessageState.DISPATCHED);
      unsubscribe();

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.type).toBe('message_state_changed');
      expect(event.sessionId).toBe('session-1');
      if (event.type !== 'message_state_changed') {
        expect.fail('Expected message_state_changed event');
      }
      expect(event.data.id).toBe('msg-1');
      expect(event.data.newState).toBe(MessageState.DISPATCHED);
      // When transitioning to DISPATCHED, userMessage should include the newly assigned order
      expect(event.data.userMessage).toBeDefined();
      expect(event.data.userMessage!.order).toBe(0);
      expect(event.data.userMessage!.text).toBe('Test message');
    });
  });

  // ---------------------------------------------------------------------------
  // getMessage
  // ---------------------------------------------------------------------------

  describe('getMessage', () => {
    it('should return message by ID', () => {
      const msg = createTestQueuedMessage('msg-1');
      messageStateService.createUserMessage('session-1', msg);

      const result = messageStateService.getMessage('session-1', 'msg-1');

      expect(result).toBeDefined();
      expect(result?.id).toBe('msg-1');
    });

    it('should return undefined for non-existent message', () => {
      const result = messageStateService.getMessage('session-1', 'non-existent');
      expect(result).toBeUndefined();
    });

    it('should return undefined for non-existent session', () => {
      const result = messageStateService.getMessage('non-existent-session', 'msg-1');
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getAllMessages
  // ---------------------------------------------------------------------------

  describe('getAllMessages', () => {
    it('should return empty array for non-existent session', () => {
      const result = messageStateService.getAllMessages('non-existent');
      expect(result).toEqual([]);
    });

    it('should return messages sorted by order (dispatch order)', () => {
      // Create messages - order is determined by when they are dispatched, not when created
      const msg1 = createTestQueuedMessage('msg-1');
      const msg2 = createTestQueuedMessage('msg-2');
      const msg3 = createTestQueuedMessage('msg-3');

      // Add in specific order
      messageStateService.createUserMessage('session-1', msg1);
      messageStateService.createUserMessage('session-1', msg2);
      messageStateService.createUserMessage('session-1', msg3);

      // Dispatch in order - this assigns their order values
      messageStateService.updateState('session-1', 'msg-1', MessageState.DISPATCHED);
      messageStateService.updateState('session-1', 'msg-2', MessageState.DISPATCHED);
      messageStateService.updateState('session-1', 'msg-3', MessageState.DISPATCHED);

      const result = messageStateService.getAllMessages('session-1');

      expect(result).toHaveLength(3);
      expect(result[0]!.id).toBe('msg-1');
      expect(result[0]!.order).toBe(0);
      expect(result[1]!.id).toBe('msg-2');
      expect(result[1]!.order).toBe(1);
      expect(result[2]!.id).toBe('msg-3');
      expect(result[2]!.order).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // removeMessage
  // ---------------------------------------------------------------------------

  describe('removeMessage', () => {
    it('should remove message and return true', () => {
      const msg = createTestQueuedMessage('msg-1');
      messageStateService.createUserMessage('session-1', msg);

      const result = messageStateService.removeMessage('session-1', 'msg-1');

      expect(result).toBe(true);
      expect(messageStateService.getMessage('session-1', 'msg-1')).toBeUndefined();
    });

    it('should return false for non-existent message', () => {
      const result = messageStateService.removeMessage('session-1', 'non-existent');
      expect(result).toBe(false);
    });

    it('should return false for non-existent session', () => {
      const result = messageStateService.removeMessage('non-existent', 'msg-1');
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // clearSession
  // ---------------------------------------------------------------------------

  describe('clearSession', () => {
    it('should remove all messages for a session', () => {
      messageStateService.createUserMessage('session-1', createTestQueuedMessage('msg-1'));
      messageStateService.createUserMessage('session-1', createTestQueuedMessage('msg-2'));
      messageStateService.createUserMessage('session-1', createTestQueuedMessage('msg-3'));

      messageStateService.clearSession('session-1');

      expect(messageStateService.getMessageCount('session-1')).toBe(0);
      expect(messageStateService.getAllMessages('session-1')).toEqual([]);
    });

    it('should not affect other sessions', () => {
      messageStateService.createUserMessage('session-1', createTestQueuedMessage('msg-1'));
      messageStateService.createUserMessage('session-2', createTestQueuedMessage('msg-2'));

      messageStateService.clearSession('session-1');

      expect(messageStateService.getMessageCount('session-1')).toBe(0);
      expect(messageStateService.getMessageCount('session-2')).toBe(1);
    });

    it('should handle clearing non-existent session gracefully', () => {
      expect(() => messageStateService.clearSession('non-existent')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // loadFromHistory
  // ---------------------------------------------------------------------------

  describe('loadFromHistory', () => {
    it('should load user messages from history as COMMITTED', () => {
      const history: HistoryMessage[] = [createTestHistoryMessage('user', 'Hello', 'uuid-1')];

      messageStateService.loadFromHistory('session-1', history);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('user');
      expect(messages[0]!.state).toBe(MessageState.COMMITTED);
      expect(isUserMessage(messages[0]!) ? messages[0]!.text : undefined).toBe('Hello');
    });

    it('should load assistant messages from history as COMPLETE', () => {
      const history: HistoryMessage[] = [
        createTestHistoryMessage('assistant', 'Hi there!', 'uuid-1'),
      ];

      messageStateService.loadFromHistory('session-1', history);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('claude');
      expect(messages[0]!.state).toBe(MessageState.COMPLETE);
    });

    it('should handle tool_use messages', () => {
      const history: HistoryMessage[] = [
        {
          type: 'tool_use',
          content: '{}',
          timestamp: new Date().toISOString(),
          uuid: 'uuid-1',
          toolName: 'Read',
          toolId: 'tool-123',
          toolInput: { file_path: '/test.txt' },
        },
      ];

      messageStateService.loadFromHistory('session-1', history);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('claude');
      const claudeMsg = messages[0]!;
      // Now stored as chatMessages (ChatMessage[])
      if (isClaudeMessage(claudeMsg)) {
        expect(claudeMsg.chatMessages).toHaveLength(1);
        const innerMessage = claudeMsg.chatMessages[0]!.message?.message;
        expect(innerMessage?.content).toEqual([
          { type: 'tool_use', id: 'tool-123', name: 'Read', input: { file_path: '/test.txt' } },
        ]);
      } else {
        expect.fail('Expected Claude message');
      }
    });

    it('should handle tool_result messages', () => {
      const history: HistoryMessage[] = [
        {
          type: 'tool_result',
          content: 'File contents here',
          timestamp: new Date().toISOString(),
          uuid: 'uuid-1',
          toolId: 'tool-123',
          isError: false,
        },
      ];

      messageStateService.loadFromHistory('session-1', history);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('claude');
      const claudeMsg = messages[0]!;
      // Now stored as chatMessages (ChatMessage[])
      if (isClaudeMessage(claudeMsg)) {
        expect(claudeMsg.chatMessages).toHaveLength(1);
        const innerMessage = claudeMsg.chatMessages[0]!.message?.message;
        expect(innerMessage?.content).toEqual([
          {
            type: 'tool_result',
            tool_use_id: 'tool-123',
            content: 'File contents here',
            is_error: false,
          },
        ]);
      } else {
        expect.fail('Expected Claude message');
      }
    });

    it('should handle thinking messages', () => {
      const history: HistoryMessage[] = [
        createTestHistoryMessage('thinking', 'Let me think about this...', 'uuid-1'),
      ];

      messageStateService.loadFromHistory('session-1', history);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('claude');
      const claudeMsg = messages[0]!;
      // Now stored as chatMessages (ChatMessage[])
      if (isClaudeMessage(claudeMsg)) {
        expect(claudeMsg.chatMessages).toHaveLength(1);
        const innerMessage = claudeMsg.chatMessages[0]!.message?.message;
        expect(innerMessage?.content).toEqual([
          { type: 'thinking', thinking: 'Let me think about this...' },
        ]);
      } else {
        expect.fail('Expected Claude message');
      }
    });

    it('should skip loading if session already has messages (race condition protection)', () => {
      // Create some existing messages
      messageStateService.createUserMessage(
        'session-1',
        createTestQueuedMessage('msg-1', 'Existing message')
      );

      // Try to load history - should be skipped due to race condition protection
      const history: HistoryMessage[] = [
        createTestHistoryMessage('user', 'From history', 'uuid-1'),
      ];
      messageStateService.loadFromHistory('session-1', history);

      // Should still have the original message, NOT the history
      // This protects against race conditions where messages are added after the empty check
      // but before history load completes
      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(isUserMessage(messages[0]!) ? messages[0]!.text : undefined).toBe('Existing message');
    });

    it('should load history when session is empty', () => {
      // Session is empty - history should load
      const history: HistoryMessage[] = [
        createTestHistoryMessage('user', 'From history', 'uuid-1'),
      ];
      messageStateService.loadFromHistory('session-1', history);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(isUserMessage(messages[0]!) ? messages[0]!.text : undefined).toBe('From history');
    });

    it('should not emit state change events (for cold load)', () => {
      const { events, unsubscribe } = collectEvents();
      const history: HistoryMessage[] = [
        createTestHistoryMessage('user', 'Hello', 'uuid-1'),
        createTestHistoryMessage('assistant', 'Hi!', 'uuid-2'),
      ];

      messageStateService.loadFromHistory('session-1', history);
      unsubscribe();

      // No state change events should be emitted during history load
      expect(events).toEqual([]);
    });

    it('should generate IDs for messages without UUIDs', () => {
      const history: HistoryMessage[] = [
        { type: 'user', content: 'No UUID', timestamp: new Date().toISOString() },
      ];

      messageStateService.loadFromHistory('session-1', history);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.id).toMatch(/^history-/);
    });

    it('should handle concurrent loadFromHistory calls safely', async () => {
      // Simulate 10 concurrent calls - only the first should succeed
      const history: HistoryMessage[] = [
        createTestHistoryMessage('user', 'From history', 'uuid-1'),
      ];

      // Launch 10 concurrent loads
      const promises = Array.from({ length: 10 }, () =>
        Promise.resolve().then(() => messageStateService.loadFromHistory('session-1', history))
      );

      await Promise.all(promises);

      // Only one history should have loaded (not 10 duplicates)
      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(isUserMessage(messages[0]!) ? messages[0]!.text : undefined).toBe('From history');
    });
  });

  // ---------------------------------------------------------------------------
  // ensureHistoryLoaded
  // ---------------------------------------------------------------------------

  describe('ensureHistoryLoaded', () => {
    it('should reload history and preserve queued messages', () => {
      messageStateService.createUserMessage('session-1', createTestQueuedMessage('queued-1'));

      const history: HistoryMessage[] = [
        createTestHistoryMessage('user', 'From history', 'uuid-1'),
      ];

      const didLoad = messageStateService.ensureHistoryLoaded('session-1', history);

      expect(didLoad).toBe(true);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(2);
      expect(isUserMessage(messages[0]!) ? messages[0]!.text : undefined).toBe('From history');
      expect(isUserMessage(messages[1]!) ? messages[1]!.text : undefined).toBe('Test message');
    });

    it('should skip reload if non-queued messages already exist', () => {
      const history: HistoryMessage[] = [
        createTestHistoryMessage('user', 'Existing history', 'uuid-1'),
      ];

      messageStateService.loadFromHistory('session-1', history);

      const didLoad = messageStateService.ensureHistoryLoaded('session-1', [
        createTestHistoryMessage('user', 'New history', 'uuid-2'),
      ]);

      expect(didLoad).toBe(false);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(isUserMessage(messages[0]!) ? messages[0]!.text : undefined).toBe('Existing history');
    });
  });

  // ---------------------------------------------------------------------------
  // hasMessage
  // ---------------------------------------------------------------------------

  describe('hasMessage', () => {
    it('should return true for existing message', () => {
      const msg = createTestQueuedMessage('msg-1');
      messageStateService.createUserMessage('session-1', msg);

      expect(messageStateService.hasMessage('session-1', 'msg-1')).toBe(true);
    });

    it('should return false for non-existent message', () => {
      expect(messageStateService.hasMessage('session-1', 'non-existent')).toBe(false);
    });

    it('should return false for non-existent session', () => {
      expect(messageStateService.hasMessage('non-existent', 'msg-1')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getMessageCount
  // ---------------------------------------------------------------------------

  describe('getMessageCount', () => {
    it('should return 0 for non-existent session', () => {
      expect(messageStateService.getMessageCount('non-existent')).toBe(0);
    });

    it('should return correct count', () => {
      expect(messageStateService.getMessageCount('session-1')).toBe(0);

      messageStateService.createUserMessage('session-1', createTestQueuedMessage('msg-1'));
      expect(messageStateService.getMessageCount('session-1')).toBe(1);

      messageStateService.createUserMessage('session-1', createTestQueuedMessage('msg-2'));
      expect(messageStateService.getMessageCount('session-1')).toBe(2);

      messageStateService.removeMessage('session-1', 'msg-1');
      expect(messageStateService.getMessageCount('session-1')).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // sendSnapshot
  // ---------------------------------------------------------------------------

  describe('sendSnapshot', () => {
    it('should send messages_snapshot event', () => {
      const { events, unsubscribe } = collectEvents();
      messageStateService.createUserMessage('session-1', createTestQueuedMessage('msg-1'));

      messageStateService.sendSnapshot('session-1');
      unsubscribe();

      expect(
        events.some(
          (event) => event.type === 'messages_snapshot' && event.sessionId === 'session-1'
        )
      ).toBe(true);
    });

    it('should include pending interactive request if provided', () => {
      const { events, unsubscribe } = collectEvents();
      const pendingRequest = {
        requestId: 'req-1',
        toolName: 'AskUserQuestion',
        input: { questions: [] },
        timestamp: new Date().toISOString(),
      };

      messageStateService.sendSnapshot('session-1', {
        pendingInteractiveRequest: pendingRequest,
      });
      unsubscribe();

      expect(
        events.some(
          (event) =>
            event.type === 'messages_snapshot' &&
            event.sessionId === 'session-1' &&
            event.data.pendingInteractiveRequest === pendingRequest
        )
      ).toBe(true);
    });

    it('should include loadRequestId when provided', () => {
      const { events, unsubscribe } = collectEvents();

      messageStateService.sendSnapshot('session-1', { loadRequestId: 'load-abc' });
      unsubscribe();

      expect(
        events.some(
          (event) =>
            event.type === 'messages_snapshot' &&
            event.sessionId === 'session-1' &&
            event.data.loadRequestId === 'load-abc'
        )
      ).toBe(true);
    });

    it('should return messages sorted by order in snapshot', () => {
      const { events, unsubscribe } = collectEvents();
      const msg1 = createTestQueuedMessage('msg-1');
      const msg2 = createTestQueuedMessage('msg-2');

      // Add in specific order
      messageStateService.createUserMessage('session-1', msg1);
      messageStateService.createUserMessage('session-1', msg2);

      // Dispatch them to assign order values
      messageStateService.updateState('session-1', 'msg-1', MessageState.DISPATCHED);
      messageStateService.updateState('session-1', 'msg-2', MessageState.DISPATCHED);

      messageStateService.sendSnapshot('session-1');
      unsubscribe();

      const snapshot = events.find((event) => event.type === 'messages_snapshot');
      if (!snapshot || snapshot.type !== 'messages_snapshot') {
        expect.fail('Expected messages_snapshot event');
      }
      const payload = snapshot.data as { messages: Array<{ id: string; order?: number }> };
      expect(payload.messages[0]!.id).toBe('msg-1');
      expect(payload.messages[0]!.order).toBe(0);
      expect(payload.messages[1]!.id).toBe('msg-2');
      expect(payload.messages[1]!.order).toBe(1);
    });

    it('should include planContent in pendingInteractiveRequest', () => {
      const { events, unsubscribe } = collectEvents();
      const pendingRequest = {
        requestId: 'req-plan-123',
        toolName: 'EnterPlanMode',
        input: { someKey: 'someValue' },
        planContent: '# My Plan\n\nStep 1: Do something',
        timestamp: new Date().toISOString(),
      };

      messageStateService.sendSnapshot('session-1', {
        pendingInteractiveRequest: pendingRequest,
      });
      unsubscribe();

      expect(
        events.some(
          (event) =>
            event.type === 'messages_snapshot' &&
            event.sessionId === 'session-1' &&
            event.data.pendingInteractiveRequest === pendingRequest
        )
      ).toBe(true);
    });

    it('should include event store claude_message events in snapshot', () => {
      const { events, unsubscribe } = collectEvents();

      // Simulate a live session: user message dispatched + claude_message events stored
      const msg = createTestQueuedMessage('msg-1', 'Hello');
      messageStateService.createUserMessage('session-1', msg);
      messageStateService.updateState('session-1', 'msg-1', MessageState.DISPATCHED);

      // Store claude_message events as the event forwarder would
      const assistantData = {
        type: 'assistant',
        message: { role: 'assistant', content: 'Hi there!' },
      };
      const toolUseData = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }],
        },
      };
      messageStateService.storeEvent('session-1', {
        type: 'claude_message',
        data: assistantData,
        order: 100,
      });
      messageStateService.storeEvent('session-1', {
        type: 'claude_message',
        data: toolUseData,
        order: 101,
      });

      messageStateService.sendSnapshot('session-1');
      unsubscribe();

      const snapshot = events.find((e) => e.type === 'messages_snapshot');
      if (!snapshot || snapshot.type !== 'messages_snapshot') {
        expect.fail('Expected messages_snapshot event');
      }

      const { messages } = snapshot.data;
      // Should have: 1 user message + 2 event store messages = 3 total
      expect(messages).toHaveLength(3);

      // User message from state machine
      expect(messages[0]!.source).toBe('user');
      expect(messages[0]!.id).toBe('msg-1');

      // Event store messages
      expect(messages[1]!.source).toBe('claude');
      expect(messages[1]!.message).toBe(assistantData);
      expect(messages[1]!.order).toBe(100);

      expect(messages[2]!.source).toBe('claude');
      expect(messages[2]!.message).toBe(toolUseData);
      expect(messages[2]!.order).toBe(101);
    });

    it('should skip event store entries without order or data', () => {
      const { events, unsubscribe } = collectEvents();

      // Store events with missing fields - should be skipped
      messageStateService.storeEvent('session-1', { type: 'claude_message' }); // no data, no order
      messageStateService.storeEvent('session-1', {
        type: 'claude_message',
        data: { type: 'assistant' },
      }); // no order
      messageStateService.storeEvent('session-1', { type: 'tool_progress', order: 1 }); // wrong type
      // Valid event
      messageStateService.storeEvent('session-1', {
        type: 'claude_message',
        data: { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
        order: 5,
      });

      messageStateService.sendSnapshot('session-1');
      unsubscribe();

      const snapshot = events.find((e) => e.type === 'messages_snapshot');
      if (!snapshot || snapshot.type !== 'messages_snapshot') {
        expect.fail('Expected messages_snapshot event');
      }

      // Only the valid claude_message event should appear
      expect(snapshot.data.messages).toHaveLength(1);
      expect(snapshot.data.messages[0]!.source).toBe('claude');
      expect(snapshot.data.messages[0]!.order).toBe(5);
    });

    it('should filter transient stream events from snapshot to match live client behavior', () => {
      const { events, unsubscribe } = collectEvents();

      // Store stream events as the forwarder would during a live session.
      // The client's shouldStoreMessage filters stream_event via shouldIncludeStreamEvent,
      // only keeping content_block_start for tool_use/tool_result/thinking.
      // The snapshot must apply the same filtering.

      // Should be INCLUDED: content_block_start with tool_use
      messageStateService.storeEvent('session-1', {
        type: 'claude_message',
        data: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
          },
        },
        order: 1,
      });
      // Should be INCLUDED: content_block_start with thinking
      messageStateService.storeEvent('session-1', {
        type: 'claude_message',
        data: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'thinking', thinking: '' },
          },
        },
        order: 2,
      });
      // Should be EXCLUDED: content_block_delta (transient)
      messageStateService.storeEvent('session-1', {
        type: 'claude_message',
        data: {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'hi' },
          },
        },
        order: 3,
      });
      // Should be EXCLUDED: content_block_stop (transient)
      messageStateService.storeEvent('session-1', {
        type: 'claude_message',
        data: {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
        },
        order: 4,
      });
      // Should be EXCLUDED: message_delta (transient)
      messageStateService.storeEvent('session-1', {
        type: 'claude_message',
        data: {
          type: 'stream_event',
          event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        },
        order: 5,
      });
      // Should be INCLUDED: non-stream_event message (assistant)
      messageStateService.storeEvent('session-1', {
        type: 'claude_message',
        data: { type: 'assistant', message: { role: 'assistant', content: 'Hello' } },
        order: 6,
      });

      messageStateService.sendSnapshot('session-1');
      unsubscribe();

      const snapshot = events.find((e) => e.type === 'messages_snapshot');
      if (!snapshot || snapshot.type !== 'messages_snapshot') {
        expect.fail('Expected messages_snapshot event');
      }

      const { messages } = snapshot.data;
      // tool_use start (1) + thinking start (2) + assistant (6) = 3
      expect(messages).toHaveLength(3);
      expect(messages[0]!.order).toBe(1);
      expect(messages[1]!.order).toBe(2);
      expect(messages[2]!.order).toBe(6);
    });

    it('should sort snapshot messages by order when event store messages precede queued users', () => {
      const { events, unsubscribe } = collectEvents();

      // Dispatched user message gets order 0
      const msg1 = createTestQueuedMessage('msg-1', 'First');
      messageStateService.createUserMessage('session-1', msg1);
      messageStateService.updateState('session-1', 'msg-1', MessageState.DISPATCHED);
      messageStateService.updateState('session-1', 'msg-1', MessageState.COMMITTED);

      // Queued user message has no order yet → gets BASE_ORDER (1_000_000_000)
      const msg2 = createTestQueuedMessage('msg-2', 'Queued');
      messageStateService.createUserMessage('session-1', msg2);

      // Event store messages with order values between user messages
      messageStateService.storeEvent('session-1', {
        type: 'claude_message',
        data: { type: 'assistant', message: { role: 'assistant', content: 'Reply' } },
        order: 5,
      });

      messageStateService.sendSnapshot('session-1');
      unsubscribe();

      const snapshot = events.find((e) => e.type === 'messages_snapshot');
      if (!snapshot || snapshot.type !== 'messages_snapshot') {
        expect.fail('Expected messages_snapshot event');
      }

      const { messages } = snapshot.data;
      expect(messages).toHaveLength(3);

      // Order should be: msg-1 (order 0), event store (order 5), msg-2 (order 1_000_000_000)
      expect(messages[0]!.id).toBe('msg-1');
      expect(messages[0]!.order).toBe(0);
      expect(messages[1]!.source).toBe('claude');
      expect(messages[1]!.order).toBe(5);
      expect(messages[2]!.id).toBe('msg-2');
      expect(messages[2]!.order).toBe(1_000_000_000);
    });

    it('reconnect snapshot should match live session messages', () => {
      // Simulate what happens during a live session:
      // 1. User sends a message
      // 2. Claude responds with events stored in event store
      // 3. Client disconnects and reconnects
      // 4. Snapshot should contain the same messages the client originally saw

      const msg = createTestQueuedMessage('msg-1', 'What is 2+2?');
      messageStateService.createUserMessage('session-1', msg);
      messageStateService.updateState('session-1', 'msg-1', MessageState.DISPATCHED);
      messageStateService.updateState('session-1', 'msg-1', MessageState.COMMITTED);

      // Simulate claude_message events being stored during live streaming
      const liveEvents = [
        {
          type: 'claude_message' as const,
          data: { type: 'assistant', message: { role: 'assistant', content: 'The answer is 4.' } },
          order: 10,
        },
        {
          type: 'claude_message' as const,
          data: {
            type: 'result',
            usage: { input_tokens: 10, output_tokens: 5 },
            duration_ms: 100,
          },
          order: 11,
        },
      ];

      // Store events as the chat-event-forwarder would during live session
      for (const event of liveEvents) {
        messageStateService.storeEvent('session-1', event);
      }

      // Now simulate reconnect: sendSnapshot should include both
      // state machine messages AND event store messages
      const { events, unsubscribe } = collectEvents();
      messageStateService.sendSnapshot('session-1');
      unsubscribe();

      const snapshot = events.find((e) => e.type === 'messages_snapshot');
      if (!snapshot || snapshot.type !== 'messages_snapshot') {
        expect.fail('Expected messages_snapshot event');
      }

      const { messages } = snapshot.data;

      // Verify user message is present
      const userMessages = messages.filter((m) => m.source === 'user');
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]!.text).toBe('What is 2+2?');

      // Verify claude messages from event store are present
      const claudeMessages = messages.filter((m) => m.source === 'claude');
      expect(claudeMessages).toHaveLength(2);
      expect(claudeMessages[0]!.order).toBe(10);
      expect(claudeMessages[1]!.order).toBe(11);

      // Verify the event data is preserved
      expect(claudeMessages[0]!.message?.type).toBe('assistant');
      expect(claudeMessages[1]!.message?.type).toBe('result');
    });
  });

  // ---------------------------------------------------------------------------
  // Session Isolation
  // ---------------------------------------------------------------------------

  describe('session isolation', () => {
    it('should maintain separate message stores for different sessions', () => {
      messageStateService.createUserMessage('session-1', createTestQueuedMessage('s1-msg-1'));
      messageStateService.createUserMessage('session-2', createTestQueuedMessage('s2-msg-1'));
      messageStateService.createUserMessage('session-2', createTestQueuedMessage('s2-msg-2'));

      expect(messageStateService.getMessageCount('session-1')).toBe(1);
      expect(messageStateService.getMessageCount('session-2')).toBe(2);

      expect(messageStateService.hasMessage('session-1', 's1-msg-1')).toBe(true);
      expect(messageStateService.hasMessage('session-1', 's2-msg-1')).toBe(false);
      expect(messageStateService.hasMessage('session-2', 's2-msg-1')).toBe(true);
    });

    it('should not affect other sessions when updating state', () => {
      messageStateService.createUserMessage('session-1', createTestQueuedMessage('msg-1'));
      messageStateService.createUserMessage('session-2', createTestQueuedMessage('msg-1'));

      messageStateService.updateState('session-1', 'msg-1', MessageState.DISPATCHED);

      expect(messageStateService.getMessage('session-1', 'msg-1')?.state).toBe(
        MessageState.DISPATCHED
      );
      expect(messageStateService.getMessage('session-2', 'msg-1')?.state).toBe(
        MessageState.ACCEPTED
      );
    });
  });
});
