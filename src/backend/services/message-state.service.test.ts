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
            // For ACCEPTED state, includes full user message content
            userMessage: {
              text: msg.text,
              timestamp: msg.timestamp,
              attachments: msg.attachments,
              settings: msg.settings,
              order: 0,
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

      expect(events).toEqual([
        {
          type: 'message_state_changed',
          sessionId: 'session-1',
          data: {
            id: 'msg-1',
            newState: MessageState.DISPATCHED,
            queuePosition: 0,
            errorMessage: undefined,
            userMessage: undefined,
          },
        },
      ]);
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

    it('should return messages sorted by order (creation order)', () => {
      // Create messages - order is determined by when createUserMessage is called
      const msg1 = createTestQueuedMessage('msg-1');
      const msg2 = createTestQueuedMessage('msg-2');
      const msg3 = createTestQueuedMessage('msg-3');

      // Add in specific order - this is the order they will appear
      messageStateService.createUserMessage('session-1', msg1);
      messageStateService.createUserMessage('session-1', msg2);
      messageStateService.createUserMessage('session-1', msg3);

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

      messageStateService.sendSnapshot('session-1', { phase: 'ready' });
      unsubscribe();

      expect(
        events.some(
          (event) =>
            event.type === 'messages_snapshot' &&
            event.sessionId === 'session-1' &&
            event.data.sessionStatus.phase === 'ready'
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

      messageStateService.sendSnapshot('session-1', { phase: 'running' }, pendingRequest);
      unsubscribe();

      expect(
        events.some(
          (event) =>
            event.type === 'messages_snapshot' &&
            event.sessionId === 'session-1' &&
            event.data.sessionStatus.phase === 'running' &&
            event.data.pendingInteractiveRequest === pendingRequest
        )
      ).toBe(true);
    });

    it('should return messages sorted by order in snapshot', () => {
      const { events, unsubscribe } = collectEvents();
      const msg1 = createTestQueuedMessage('msg-1');
      const msg2 = createTestQueuedMessage('msg-2');

      // Add in specific order - messages will be sorted by order (creation order)
      messageStateService.createUserMessage('session-1', msg1);
      messageStateService.createUserMessage('session-1', msg2);
      messageStateService.sendSnapshot('session-1', { phase: 'ready' });
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

      messageStateService.sendSnapshot('session-1', { phase: 'running' }, pendingRequest);
      unsubscribe();

      expect(
        events.some(
          (event) =>
            event.type === 'messages_snapshot' &&
            event.sessionId === 'session-1' &&
            event.data.sessionStatus.phase === 'running' &&
            event.data.pendingInteractiveRequest === pendingRequest
        )
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // computeSessionStatus
  // ---------------------------------------------------------------------------

  describe('computeSessionStatus', () => {
    it('should return running when client is running', () => {
      const status = messageStateService.computeSessionStatus('session-1', true);
      expect(status).toEqual({ phase: 'running' });
    });

    it('should return ready when client is not running and no queued messages', () => {
      const status = messageStateService.computeSessionStatus('session-1', false);
      expect(status).toEqual({ phase: 'ready' });
    });

    it('should return starting when client is not running but has queued messages', () => {
      // Create a message in ACCEPTED state (queued)
      messageStateService.createUserMessage('session-1', createTestQueuedMessage('msg-1'));

      const status = messageStateService.computeSessionStatus('session-1', false);
      expect(status).toEqual({ phase: 'starting' });
    });

    it('should return ready when queued message is dispatched', () => {
      messageStateService.createUserMessage('session-1', createTestQueuedMessage('msg-1'));
      messageStateService.updateState('session-1', 'msg-1', MessageState.DISPATCHED);

      const status = messageStateService.computeSessionStatus('session-1', false);
      expect(status).toEqual({ phase: 'ready' });
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
