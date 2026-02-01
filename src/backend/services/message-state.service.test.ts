/**
 * Tests for the MessageStateService.
 *
 * Tests the message state machine that manages unified message state for chat sessions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryMessage, QueuedMessage } from '@/lib/claude-types';
import { isClaudeMessage, isUserMessage, MessageState } from '@/lib/claude-types';
import { messageStateService } from './message-state.service';

// Mock the chatConnectionService to prevent actual WebSocket broadcasts
vi.mock('./chat-connection.service', () => ({
  chatConnectionService: {
    forwardToSession: vi.fn(),
  },
}));

// Import the mock after setup
import { chatConnectionService } from './chat-connection.service';

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
    vi.clearAllMocks();
  });

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
      expect(result.attachments?.[0].name).toBe('image.png');
    });

    it('should emit state change event', () => {
      const msg = createTestQueuedMessage('msg-1');
      messageStateService.createUserMessage('session-1', msg);

      expect(chatConnectionService.forwardToSession).toHaveBeenCalledWith('session-1', {
        type: 'message_state_changed',
        id: 'msg-1',
        newState: MessageState.ACCEPTED,
        queuePosition: 0,
        errorMessage: undefined,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // createClaudeMessage
  // ---------------------------------------------------------------------------

  describe('createClaudeMessage', () => {
    it('should create a Claude message in STREAMING state', () => {
      const result = messageStateService.createClaudeMessage('session-1', 'claude-msg-1');

      expect(result.id).toBe('claude-msg-1');
      expect(result.type).toBe('claude');
      expect(result.state).toBe(MessageState.STREAMING);
    });

    it('should store content if provided', () => {
      const content = {
        type: 'assistant' as const,
        message: { role: 'assistant' as const, content: 'Hello' },
      };
      const result = messageStateService.createClaudeMessage('session-1', 'claude-msg-1', content);

      expect(result.content).toEqual(content);
    });

    it('should emit state change event', () => {
      messageStateService.createClaudeMessage('session-1', 'claude-msg-1');

      expect(chatConnectionService.forwardToSession).toHaveBeenCalledWith('session-1', {
        type: 'message_state_changed',
        id: 'claude-msg-1',
        newState: MessageState.STREAMING,
        queuePosition: undefined,
        errorMessage: undefined,
      });
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

    it('should allow Claude message STREAMING -> COMPLETE transition', () => {
      messageStateService.createClaudeMessage('session-1', 'claude-msg-1');

      const result = messageStateService.updateState(
        'session-1',
        'claude-msg-1',
        MessageState.COMPLETE
      );
      expect(result).toBe(true);
      expect(messageStateService.getMessage('session-1', 'claude-msg-1')?.state).toBe(
        MessageState.COMPLETE
      );
    });

    it('should reject user state transitions for Claude messages', () => {
      messageStateService.createClaudeMessage('session-1', 'claude-msg-1');

      // STREAMING -> DISPATCHED is invalid for Claude messages
      const result = messageStateService.updateState(
        'session-1',
        'claude-msg-1',
        MessageState.DISPATCHED
      );
      expect(result).toBe(false);
      expect(messageStateService.getMessage('session-1', 'claude-msg-1')?.state).toBe(
        MessageState.STREAMING
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
      vi.clearAllMocks();

      messageStateService.updateState('session-1', 'msg-1', MessageState.DISPATCHED);

      expect(chatConnectionService.forwardToSession).toHaveBeenCalledWith('session-1', {
        type: 'message_state_changed',
        id: 'msg-1',
        newState: MessageState.DISPATCHED,
        queuePosition: 0,
        errorMessage: undefined,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // updateClaudeContent
  // ---------------------------------------------------------------------------

  describe('updateClaudeContent', () => {
    it('should update Claude message content', () => {
      messageStateService.createClaudeMessage('session-1', 'claude-msg-1');

      const newContent = {
        type: 'assistant' as const,
        message: { role: 'assistant' as const, content: 'Updated' },
      };
      const result = messageStateService.updateClaudeContent(
        'session-1',
        'claude-msg-1',
        newContent
      );

      expect(result).toBe(true);
      const updatedMsg = messageStateService.getMessage('session-1', 'claude-msg-1');
      expect(updatedMsg && isClaudeMessage(updatedMsg) ? updatedMsg.content : undefined).toEqual(
        newContent
      );
    });

    it('should return false for non-existent message', () => {
      const newContent = {
        type: 'assistant' as const,
        message: { role: 'assistant' as const, content: 'Updated' },
      };
      const result = messageStateService.updateClaudeContent(
        'session-1',
        'non-existent',
        newContent
      );

      expect(result).toBe(false);
    });

    it('should return false for user message', () => {
      const msg = createTestQueuedMessage('msg-1');
      messageStateService.createUserMessage('session-1', msg);

      const newContent = {
        type: 'assistant' as const,
        message: { role: 'assistant' as const, content: 'Updated' },
      };
      const result = messageStateService.updateClaudeContent('session-1', 'msg-1', newContent);

      expect(result).toBe(false);
    });

    it('should not emit state change event (too noisy)', () => {
      messageStateService.createClaudeMessage('session-1', 'claude-msg-1');
      vi.clearAllMocks();

      const newContent = {
        type: 'assistant' as const,
        message: { role: 'assistant' as const, content: 'Updated' },
      };
      messageStateService.updateClaudeContent('session-1', 'claude-msg-1', newContent);

      expect(chatConnectionService.forwardToSession).not.toHaveBeenCalled();
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

    it('should return messages sorted by timestamp', () => {
      // Create messages with specific timestamps
      const now = Date.now();
      const msg1: QueuedMessage = {
        ...createTestQueuedMessage('msg-1'),
        timestamp: new Date(now - 2000).toISOString(),
      };
      const msg2: QueuedMessage = {
        ...createTestQueuedMessage('msg-2'),
        timestamp: new Date(now - 1000).toISOString(),
      };
      const msg3: QueuedMessage = {
        ...createTestQueuedMessage('msg-3'),
        timestamp: new Date(now).toISOString(),
      };

      // Add in non-chronological order
      messageStateService.createUserMessage('session-1', msg2);
      messageStateService.createUserMessage('session-1', msg3);
      messageStateService.createUserMessage('session-1', msg1);

      const result = messageStateService.getAllMessages('session-1');

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('msg-1');
      expect(result[1].id).toBe('msg-2');
      expect(result[2].id).toBe('msg-3');
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
      messageStateService.createClaudeMessage('session-1', 'claude-msg-1');

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
      expect(messages[0].type).toBe('user');
      expect(messages[0].state).toBe(MessageState.COMMITTED);
      expect(isUserMessage(messages[0]) ? messages[0].text : undefined).toBe('Hello');
    });

    it('should load assistant messages from history as COMPLETE', () => {
      const history: HistoryMessage[] = [
        createTestHistoryMessage('assistant', 'Hi there!', 'uuid-1'),
      ];

      messageStateService.loadFromHistory('session-1', history);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('claude');
      expect(messages[0].state).toBe(MessageState.COMPLETE);
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
      expect(messages[0].type).toBe('claude');
      const claudeMsg = messages[0];
      expect(isClaudeMessage(claudeMsg) ? claudeMsg.content?.message?.content : undefined).toEqual([
        { type: 'tool_use', id: 'tool-123', name: 'Read', input: { file_path: '/test.txt' } },
      ]);
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
      expect(messages[0].type).toBe('claude');
      const claudeMsg = messages[0];
      expect(isClaudeMessage(claudeMsg) ? claudeMsg.content?.message?.content : undefined).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'tool-123',
          content: 'File contents here',
          is_error: false,
        },
      ]);
    });

    it('should handle thinking messages', () => {
      const history: HistoryMessage[] = [
        createTestHistoryMessage('thinking', 'Let me think about this...', 'uuid-1'),
      ];

      messageStateService.loadFromHistory('session-1', history);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('claude');
      const claudeMsg = messages[0];
      expect(isClaudeMessage(claudeMsg) ? claudeMsg.content?.message?.content : undefined).toEqual([
        { type: 'thinking', thinking: 'Let me think about this...' },
      ]);
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
      expect(isUserMessage(messages[0]) ? messages[0].text : undefined).toBe('Existing message');
    });

    it('should load history when session is empty', () => {
      // Session is empty - history should load
      const history: HistoryMessage[] = [
        createTestHistoryMessage('user', 'From history', 'uuid-1'),
      ];
      messageStateService.loadFromHistory('session-1', history);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(isUserMessage(messages[0]) ? messages[0].text : undefined).toBe('From history');
    });

    it('should not emit state change events (for cold load)', () => {
      vi.clearAllMocks();

      const history: HistoryMessage[] = [
        createTestHistoryMessage('user', 'Hello', 'uuid-1'),
        createTestHistoryMessage('assistant', 'Hi!', 'uuid-2'),
      ];

      messageStateService.loadFromHistory('session-1', history);

      // No state change events should be emitted during history load
      expect(chatConnectionService.forwardToSession).not.toHaveBeenCalled();
    });

    it('should generate IDs for messages without UUIDs', () => {
      const history: HistoryMessage[] = [
        { type: 'user', content: 'No UUID', timestamp: new Date().toISOString() },
      ];

      messageStateService.loadFromHistory('session-1', history);

      const messages = messageStateService.getAllMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toMatch(/^history-/);
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
      expect(isUserMessage(messages[0]) ? messages[0].text : undefined).toBe('From history');
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

      messageStateService.createClaudeMessage('session-1', 'claude-msg-1');
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
      messageStateService.createUserMessage('session-1', createTestQueuedMessage('msg-1'));
      vi.clearAllMocks();

      messageStateService.sendSnapshot('session-1', { phase: 'ready' });

      expect(chatConnectionService.forwardToSession).toHaveBeenCalledWith('session-1', {
        type: 'messages_snapshot',
        allMessages: expect.any(Array),
        sessionStatus: { phase: 'ready' },
        pendingInteractiveRequest: undefined,
      });
    });

    it('should include pending interactive request if provided', () => {
      const pendingRequest = {
        requestId: 'req-1',
        toolName: 'AskUserQuestion',
        input: { questions: [] },
        timestamp: new Date().toISOString(),
      };

      messageStateService.sendSnapshot('session-1', { phase: 'running' }, pendingRequest);

      expect(chatConnectionService.forwardToSession).toHaveBeenCalledWith('session-1', {
        type: 'messages_snapshot',
        allMessages: expect.any(Array),
        sessionStatus: { phase: 'running' },
        pendingInteractiveRequest: pendingRequest,
      });
    });

    it('should return sorted messages in snapshot', () => {
      const now = Date.now();
      const msg1: QueuedMessage = {
        ...createTestQueuedMessage('msg-1'),
        timestamp: new Date(now - 1000).toISOString(),
      };
      const msg2: QueuedMessage = {
        ...createTestQueuedMessage('msg-2'),
        timestamp: new Date(now).toISOString(),
      };

      // Add in reverse order
      messageStateService.createUserMessage('session-1', msg2);
      messageStateService.createUserMessage('session-1', msg1);
      vi.clearAllMocks();

      messageStateService.sendSnapshot('session-1', { phase: 'ready' });

      const call = vi.mocked(chatConnectionService.forwardToSession).mock.calls[0];
      const payload = call[1] as { allMessages: Array<{ id: string }> };
      expect(payload.allMessages[0].id).toBe('msg-1');
      expect(payload.allMessages[1].id).toBe('msg-2');
    });

    it('should include planContent in pendingInteractiveRequest', () => {
      const pendingRequest = {
        requestId: 'req-plan-123',
        toolName: 'EnterPlanMode',
        input: { someKey: 'someValue' },
        planContent: '# My Plan\n\nStep 1: Do something',
        timestamp: new Date().toISOString(),
      };

      messageStateService.sendSnapshot('session-1', { phase: 'running' }, pendingRequest);

      expect(chatConnectionService.forwardToSession).toHaveBeenCalledWith('session-1', {
        type: 'messages_snapshot',
        allMessages: [],
        sessionStatus: { phase: 'running' },
        pendingInteractiveRequest: pendingRequest,
      });
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
