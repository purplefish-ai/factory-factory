/**
 * Tests for the chat reducer module.
 *
 * This file tests all state transitions, action creators, and helper functions
 * for the chat state management.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ChatMessage,
  ChatSettings,
  ClaudeMessage,
  HistoryMessage,
  PermissionRequest,
  QueuedMessage,
  SessionInfo,
  UserQuestionRequest,
  WebSocketMessage,
} from '@/lib/claude-types';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/claude-types';
import {
  type ChatAction,
  type ChatState,
  chatReducer,
  createActionFromWebSocketMessage,
  createInitialChatState,
  createUserMessageAction,
} from './chat-reducer';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Helper to convert array of QueuedMessages to Map.
 * Used for setting up test state since queuedMessages is now a Map.
 */
function toQueuedMessagesMap(messages: QueuedMessage[]): Map<string, QueuedMessage> {
  const map = new Map<string, QueuedMessage>();
  for (const msg of messages) {
    map.set(msg.id, msg);
  }
  return map;
}

function createTestToolUseMessage(toolUseId: string): ClaudeMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: toolUseId,
        name: 'TestTool',
        input: { arg: 'value' },
      },
    },
  };
}

function createTestAssistantMessage(): ClaudeMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
    },
  };
}

function createTestResultMessage(): ClaudeMessage {
  return {
    type: 'result',
    usage: { input_tokens: 100, output_tokens: 50 },
    duration_ms: 1000,
    total_cost_usd: 0.01,
    num_turns: 1,
  };
}

function createTestThinkingMessage(): ClaudeMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'thinking',
        thinking: 'Analyzing the problem...',
      },
    },
  };
}

function createTestToolResultMessage(toolUseId: string): ClaudeMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'Tool output',
        },
      ],
    },
  };
}

// =============================================================================
// Initial State Tests
// =============================================================================

describe('createInitialChatState', () => {
  it('should create valid initial state with defaults', () => {
    const state = createInitialChatState();

    expect(state.messages).toEqual([]);
    expect(state.sessionStatus).toEqual({ phase: 'loading' });
    expect(state.gitBranch).toBeNull();
    expect(state.availableSessions).toEqual([]);
    expect(state.pendingRequest).toEqual({ type: 'none' });
    expect(state.chatSettings).toEqual(DEFAULT_CHAT_SETTINGS);
    expect(state.queuedMessages).toBeInstanceOf(Map);
    expect(state.queuedMessages.size).toBe(0);
    expect(state.toolUseIdToIndex).toBeInstanceOf(Map);
    expect(state.toolUseIdToIndex.size).toBe(0);
  });

  it('should allow overrides for initial state', () => {
    const customSettings: ChatSettings = {
      selectedModel: 'sonnet',
      thinkingEnabled: true,
      planModeEnabled: true,
    };

    const state = createInitialChatState({
      sessionStatus: { phase: 'running' },
      gitBranch: 'feature/test',
      chatSettings: customSettings,
    });

    expect(state.sessionStatus).toEqual({ phase: 'running' });
    expect(state.gitBranch).toBe('feature/test');
    expect(state.chatSettings).toEqual(customSettings);
    // Other values should still be defaults
    expect(state.messages).toEqual([]);
  });
});

// =============================================================================
// Reducer Action Tests
// =============================================================================

describe('chatReducer', () => {
  let initialState: ChatState;

  // Create fresh initial state before each test
  beforeEach(() => {
    initialState = createInitialChatState();
  });

  // -------------------------------------------------------------------------
  // WS_STATUS Action
  // -------------------------------------------------------------------------

  describe('WS_STATUS action', () => {
    it('should set sessionStatus to running when payload.running is true', () => {
      const action: ChatAction = { type: 'WS_STATUS', payload: { running: true } };
      const newState = chatReducer(initialState, action);

      expect(newState.sessionStatus).toEqual({ phase: 'running' });
    });

    it('should set sessionStatus to ready when payload.running is false', () => {
      const state = { ...initialState, sessionStatus: { phase: 'running' } as const };
      const action: ChatAction = { type: 'WS_STATUS', payload: { running: false } };
      const newState = chatReducer(state, action);

      expect(newState.sessionStatus).toEqual({ phase: 'ready' });
    });
  });

  // -------------------------------------------------------------------------
  // WS_STARTING Action
  // -------------------------------------------------------------------------

  describe('WS_STARTING action', () => {
    it('should set sessionStatus to starting', () => {
      const action: ChatAction = { type: 'WS_STARTING' };
      const newState = chatReducer(initialState, action);

      expect(newState.sessionStatus).toEqual({ phase: 'starting' });
    });
  });

  // -------------------------------------------------------------------------
  // WS_STARTED Action
  // -------------------------------------------------------------------------

  describe('WS_STARTED action', () => {
    it('should set sessionStatus to running', () => {
      const state = { ...initialState, sessionStatus: { phase: 'starting' } as const };
      const action: ChatAction = { type: 'WS_STARTED' };
      const newState = chatReducer(state, action);

      expect(newState.sessionStatus).toEqual({ phase: 'running' });
    });

    it('should clear latestThinking to prevent stale content flash', () => {
      const state = {
        ...initialState,
        sessionStatus: { phase: 'starting' } as const,
        latestThinking: 'Stale thinking from previous session',
      };
      const action: ChatAction = { type: 'WS_STARTED' };
      const newState = chatReducer(state, action);

      expect(newState.latestThinking).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // WS_STOPPED Action
  // -------------------------------------------------------------------------

  describe('WS_STOPPED action', () => {
    it('should set sessionStatus to ready', () => {
      const state = { ...initialState, sessionStatus: { phase: 'running' } as const };
      const action: ChatAction = { type: 'WS_STOPPED' };
      const newState = chatReducer(state, action);

      expect(newState.sessionStatus).toEqual({ phase: 'ready' });
    });
  });

  // -------------------------------------------------------------------------
  // WS_CLAUDE_MESSAGE Action
  // -------------------------------------------------------------------------

  describe('WS_CLAUDE_MESSAGE action', () => {
    it('should add assistant message to messages array', () => {
      const claudeMsg = createTestAssistantMessage();
      const action: ChatAction = { type: 'WS_CLAUDE_MESSAGE', payload: claudeMsg };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0].source).toBe('claude');
      expect(newState.messages[0].message).toEqual(claudeMsg);
    });

    it('should transition from starting to running when receiving a Claude message', () => {
      const state = { ...initialState, sessionStatus: { phase: 'starting' } as const };
      const claudeMsg = createTestAssistantMessage();
      const action: ChatAction = { type: 'WS_CLAUDE_MESSAGE', payload: claudeMsg };
      const newState = chatReducer(state, action);

      expect(newState.sessionStatus).toEqual({ phase: 'running' });
    });

    it('should set sessionStatus to ready when receiving a result message', () => {
      const state = { ...initialState, sessionStatus: { phase: 'running' } as const };
      const resultMsg = createTestResultMessage();
      const action: ChatAction = { type: 'WS_CLAUDE_MESSAGE', payload: resultMsg };
      const newState = chatReducer(state, action);

      expect(newState.sessionStatus).toEqual({ phase: 'ready' });
      expect(newState.messages).toHaveLength(1);
    });

    it('should store tool_use messages and track index for O(1) updates', () => {
      const toolUseId = 'tool-use-123';
      const toolUseMsg = createTestToolUseMessage(toolUseId);
      const action: ChatAction = { type: 'WS_CLAUDE_MESSAGE', payload: toolUseMsg };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.toolUseIdToIndex.get(toolUseId)).toBe(0);
    });

    it('should store thinking messages', () => {
      const thinkingMsg = createTestThinkingMessage();
      const action: ChatAction = { type: 'WS_CLAUDE_MESSAGE', payload: thinkingMsg };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
    });

    it('should store tool_result messages from user type', () => {
      const toolResultMsg = createTestToolResultMessage('tool-123');
      const action: ChatAction = { type: 'WS_CLAUDE_MESSAGE', payload: toolResultMsg };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
    });

    it('should not store text_delta stream events', () => {
      const deltaMsg: ClaudeMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      };
      const action: ChatAction = { type: 'WS_CLAUDE_MESSAGE', payload: deltaMsg };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(0);
    });

    it('should not store message_start stream events', () => {
      const msgStartEvent: ClaudeMessage = {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { role: 'assistant', content: [] },
        },
      };
      const action: ChatAction = { type: 'WS_CLAUDE_MESSAGE', payload: msgStartEvent };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(0);
    });

    it('should not store user messages without tool_result content', () => {
      const userMsg: ClaudeMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: 'Hello',
        },
      };
      const action: ChatAction = { type: 'WS_CLAUDE_MESSAGE', payload: userMsg };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // WS_ERROR Action
  // -------------------------------------------------------------------------

  describe('WS_ERROR action', () => {
    it('should add error message to messages array', () => {
      const action: ChatAction = {
        type: 'WS_ERROR',
        payload: { message: 'Connection failed' },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0].source).toBe('claude');
      expect(newState.messages[0].message?.type).toBe('error');
      expect(newState.messages[0].message?.error).toBe('Connection failed');
    });
  });

  // -------------------------------------------------------------------------
  // WS_SESSIONS Action
  // -------------------------------------------------------------------------

  describe('WS_SESSIONS action', () => {
    it('should update available sessions list', () => {
      const sessions: SessionInfo[] = [
        {
          claudeSessionId: 'session-1',
          createdAt: '2024-01-01T00:00:00.000Z',
          modifiedAt: '2024-01-01T00:00:00.000Z',
          sizeBytes: 1024,
        },
        {
          claudeSessionId: 'session-2',
          createdAt: '2024-01-02T00:00:00.000Z',
          modifiedAt: '2024-01-02T00:00:00.000Z',
          sizeBytes: 2048,
        },
      ];
      const action: ChatAction = { type: 'WS_SESSIONS', payload: { sessions } };
      const newState = chatReducer(initialState, action);

      expect(newState.availableSessions).toEqual(sessions);
    });
  });

  // -------------------------------------------------------------------------
  // WS_SESSION_LOADED Action
  // -------------------------------------------------------------------------

  describe('WS_SESSION_LOADED action', () => {
    it('should load session history and update state', () => {
      const historyMessages: HistoryMessage[] = [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00.000Z' },
        { type: 'assistant', content: 'Hi there!', timestamp: '2024-01-01T00:00:01.000Z' },
      ];

      const state = { ...initialState, loadingSession: true };
      const action: ChatAction = {
        type: 'WS_SESSION_LOADED',
        payload: {
          messages: historyMessages,
          gitBranch: 'main',
          running: false,
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.messages).toHaveLength(2);
      expect(newState.gitBranch).toBe('main');
      expect(newState.sessionStatus).toEqual({ phase: 'ready' });
      expect(newState.toolUseIdToIndex.size).toBe(0);
    });

    it('should handle empty history', () => {
      const state = { ...initialState, sessionStatus: { phase: 'loading' } as const };
      const action: ChatAction = {
        type: 'WS_SESSION_LOADED',
        payload: {
          messages: [],
          gitBranch: null,
          running: true,
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.messages).toEqual([]);
      expect(newState.gitBranch).toBeNull();
      expect(newState.sessionStatus).toEqual({ phase: 'running' });
    });

    it('should preserve optimistic user messages when loading session', () => {
      // Scenario: User sends a message, navigates away before session starts,
      // then navigates back. The optimistic message should be preserved.
      const optimisticMessage: ChatMessage = {
        id: 'msg-123',
        source: 'user',
        text: 'Help me debug this',
        timestamp: '2024-01-01T00:00:02.000Z',
      };

      const historyMessages: HistoryMessage[] = [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00.000Z' },
        { type: 'assistant', content: 'Hi there!', timestamp: '2024-01-01T00:00:01.000Z' },
      ];

      const state = {
        ...initialState,
        messages: [optimisticMessage],
        sessionStatus: { phase: 'loading' } as const,
      };

      const action: ChatAction = {
        type: 'WS_SESSION_LOADED',
        payload: {
          messages: historyMessages,
          gitBranch: 'main',
          running: false,
        },
      };
      const newState = chatReducer(state, action);

      // Should have 2 history messages + 1 optimistic message
      expect(newState.messages).toHaveLength(3);
      expect(newState.messages[0].source).toBe('user');
      expect(newState.messages[1].source).toBe('claude');
      expect(newState.messages[2]).toEqual(optimisticMessage);
    });

    it('should not preserve non-user messages when loading session', () => {
      // Claude messages in state should be replaced by history
      const claudeMessage: ChatMessage = {
        id: 'msg-456',
        source: 'claude',
        message: { type: 'assistant', role: 'assistant', content: 'Thinking...' } as ClaudeMessage,
        timestamp: '2024-01-01T00:00:02.000Z',
      };

      const historyMessages: HistoryMessage[] = [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00.000Z' },
      ];

      const state = {
        ...initialState,
        messages: [claudeMessage],
        sessionStatus: { phase: 'loading' } as const,
      };

      const action: ChatAction = {
        type: 'WS_SESSION_LOADED',
        payload: {
          messages: historyMessages,
          gitBranch: 'main',
          running: false,
        },
      };
      const newState = chatReducer(state, action);

      // Should only have the history message, not the Claude message
      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0].source).toBe('user');
    });

    it('should not preserve messages that are older than last history message', () => {
      // Scenario: WebSocket reconnect where message in state was already processed into history
      const optimisticMessage: ChatMessage = {
        id: 'msg-123',
        source: 'user',
        text: 'Help me debug this',
        timestamp: '2024-01-01T00:00:02.000Z',
      };

      const historyMessages: HistoryMessage[] = [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00.000Z' },
        { type: 'assistant', content: 'Hi there!', timestamp: '2024-01-01T00:00:01.000Z' },
        // Same message as optimisticMessage - already in history with same timestamp
        {
          type: 'user',
          content: 'Help me debug this',
          timestamp: '2024-01-01T00:00:02.000Z',
          uuid: 'history-123',
        },
      ];

      const state = {
        ...initialState,
        messages: [optimisticMessage],
        sessionStatus: { phase: 'loading' } as const,
      };

      const action: ChatAction = {
        type: 'WS_SESSION_LOADED',
        payload: {
          messages: historyMessages,
          gitBranch: 'main',
          running: false,
        },
      };
      const newState = chatReducer(state, action);

      // Should only have 3 messages from history, optimistic message not added since it's not newer
      expect(newState.messages).toHaveLength(3);
      expect(newState.messages[0].source).toBe('user');
      expect(newState.messages[0].text).toBe('Hello');
      expect(newState.messages[1].source).toBe('claude');
      expect(newState.messages[2].source).toBe('user');
      expect(newState.messages[2].text).toBe('Help me debug this');
    });

    it('should preserve messages that are newer than last history message', () => {
      // Optimistic message sent AFTER the last history message
      const optimisticMessage: ChatMessage = {
        id: 'msg-456',
        source: 'user',
        text: 'Another question',
        timestamp: '2024-01-01T00:00:10.000Z', // 8 seconds after last history
      };

      const historyMessages: HistoryMessage[] = [
        { type: 'user', content: 'Help me debug this', timestamp: '2024-01-01T00:00:02.000Z' },
      ];

      const state = {
        ...initialState,
        messages: [optimisticMessage],
        sessionStatus: { phase: 'loading' } as const,
      };

      const action: ChatAction = {
        type: 'WS_SESSION_LOADED',
        payload: {
          messages: historyMessages,
          gitBranch: 'main',
          running: false,
        },
      };
      const newState = chatReducer(state, action);

      // Should have history message + optimistic message
      expect(newState.messages).toHaveLength(2);
      expect(newState.messages[0].text).toBe('Help me debug this');
      expect(newState.messages[1].text).toBe('Another question');
    });

    it('should handle duplicate text messages sent at different times', () => {
      // User sends "ok" twice within 5 seconds - both should be preserved if second is truly newer
      const firstOkMessage: ChatMessage = {
        id: 'msg-1',
        source: 'user',
        text: 'ok',
        timestamp: '2024-01-01T00:00:02.000Z',
      };

      const secondOkMessage: ChatMessage = {
        id: 'msg-2',
        source: 'user',
        text: 'ok',
        timestamp: '2024-01-01T00:00:05.000Z',
      };

      const historyMessages: HistoryMessage[] = [
        // Only the first "ok" is in history
        { type: 'user', content: 'ok', timestamp: '2024-01-01T00:00:02.000Z' },
      ];

      const state = {
        ...initialState,
        messages: [firstOkMessage, secondOkMessage],
        sessionStatus: { phase: 'loading' } as const,
      };

      const action: ChatAction = {
        type: 'WS_SESSION_LOADED',
        payload: {
          messages: historyMessages,
          gitBranch: 'main',
          running: false,
        },
      };
      const newState = chatReducer(state, action);

      // Should have history message + second "ok" (which is newer)
      expect(newState.messages).toHaveLength(2);
      expect(newState.messages[0].text).toBe('ok');
      expect(newState.messages[0].timestamp).toBe('2024-01-01T00:00:02.000Z');
      expect(newState.messages[1].text).toBe('ok');
      expect(newState.messages[1].timestamp).toBe('2024-01-01T00:00:05.000Z');
    });

    it('should preserve existing pendingPermission when session_loaded has no pending request (race condition)', () => {
      // Scenario: Permission request arrives during session loading, then session_loaded arrives
      // without a pending request. The existing permission should be preserved.
      const existingPermission: PermissionRequest = {
        requestId: 'req-1',
        toolName: 'ExitPlanMode',
        toolInput: {},
        timestamp: '2024-01-01T00:00:00.000Z',
        planContent: '# My Plan',
      };
      const state: ChatState = {
        ...initialState,
        pendingRequest: { type: 'permission', request: existingPermission },
        sessionStatus: { phase: 'loading' } as const,
      };

      const action: ChatAction = {
        type: 'WS_SESSION_LOADED',
        payload: {
          messages: [],
          gitBranch: 'main',
          running: true,
          pendingInteractiveRequest: null, // No pending request from backend
        },
      };
      const newState = chatReducer(state, action);

      // Should preserve the existing permission, not overwrite with null
      expect(newState.pendingRequest).toEqual({ type: 'permission', request: existingPermission });
    });

    it('should preserve existing pendingQuestion when session_loaded has no pending request (race condition)', () => {
      // Scenario: Question request arrives during session loading, then session_loaded arrives
      // without a pending request. The existing question should be preserved.
      const existingQuestion: UserQuestionRequest = {
        requestId: 'req-2',
        questions: [
          { question: 'Which option?', header: 'Choice', options: [], multiSelect: false },
        ],
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const state: ChatState = {
        ...initialState,
        pendingRequest: { type: 'question', request: existingQuestion },
        sessionStatus: { phase: 'loading' } as const,
      };

      const action: ChatAction = {
        type: 'WS_SESSION_LOADED',
        payload: {
          messages: [],
          gitBranch: 'main',
          running: true,
          pendingInteractiveRequest: null,
        },
      };
      const newState = chatReducer(state, action);

      // Should preserve the existing question, not overwrite with null
      expect(newState.pendingRequest).toEqual({ type: 'question', request: existingQuestion });
    });

    it('should restore pendingRequest as permission from backend when present', () => {
      const state: ChatState = {
        ...initialState,
        sessionStatus: { phase: 'loading' } as const,
      };

      const action: ChatAction = {
        type: 'WS_SESSION_LOADED',
        payload: {
          messages: [],
          gitBranch: 'main',
          running: true,
          pendingInteractiveRequest: {
            requestId: 'req-3',
            toolName: 'ExitPlanMode',
            toolUseId: 'tool-1',
            input: { planFile: '/tmp/plan.md' },
            planContent: '# Restored Plan',
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.pendingRequest).toEqual({
        type: 'permission',
        request: {
          requestId: 'req-3',
          toolName: 'ExitPlanMode',
          toolInput: { planFile: '/tmp/plan.md' },
          timestamp: '2024-01-01T00:00:00.000Z',
          planContent: '# Restored Plan',
        },
      });
    });

    it('should restore pendingRequest as question from backend when present', () => {
      const state: ChatState = {
        ...initialState,
        sessionStatus: { phase: 'loading' } as const,
      };

      const action: ChatAction = {
        type: 'WS_SESSION_LOADED',
        payload: {
          messages: [],
          gitBranch: 'main',
          running: true,
          pendingInteractiveRequest: {
            requestId: 'req-4',
            toolName: 'AskUserQuestion',
            toolUseId: 'tool-2',
            input: {
              questions: [
                { question: 'Pick one', header: 'Test', options: [], multiSelect: false },
              ],
            },
            planContent: null,
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.pendingRequest).toEqual({
        type: 'question',
        request: {
          requestId: 'req-4',
          questions: [{ question: 'Pick one', header: 'Test', options: [], multiSelect: false }],
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      });
    });

    it('should clear startingSession flag when session is loaded', () => {
      // Scenario: WS_STARTING sets sessionStatus to starting, then WS_SESSION_LOADED arrives
      // The sessionStatus should transition to ready to allow queue draining
      const state: ChatState = {
        ...initialState,
        sessionStatus: { phase: 'loading' } as const,
      };

      const action: ChatAction = {
        type: 'WS_SESSION_LOADED',
        payload: {
          messages: [],
          gitBranch: 'main',
          running: false,
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.sessionStatus.phase).not.toBe('starting');
      expect(newState.sessionStatus.phase).not.toBe('loading');
    });
  });

  // -------------------------------------------------------------------------
  // WS_PERMISSION_REQUEST Action
  // -------------------------------------------------------------------------

  describe('WS_PERMISSION_REQUEST action', () => {
    it('should set pending permission request', () => {
      const permissionRequest: PermissionRequest = {
        requestId: 'req-123',
        toolName: 'Bash',
        toolInput: { command: 'ls -la' },
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const action: ChatAction = { type: 'WS_PERMISSION_REQUEST', payload: permissionRequest };
      const newState = chatReducer(initialState, action);

      expect(newState.pendingRequest).toEqual({ type: 'permission', request: permissionRequest });
    });

    it('should overwrite existing pending permission request with newer one (matches backend behavior)', () => {
      // Backend always overwrites stored request with the new one, so frontend must match
      // to prevent responding to an old request while backend has the new one stored
      const existingRequest: PermissionRequest = {
        requestId: 'req-first',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const newRequest: PermissionRequest = {
        requestId: 'req-second',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/test.txt' },
        timestamp: '2024-01-01T00:00:01.000Z',
      };
      const state: ChatState = {
        ...initialState,
        pendingRequest: { type: 'permission', request: existingRequest },
      };
      const action: ChatAction = { type: 'WS_PERMISSION_REQUEST', payload: newRequest };
      const newState = chatReducer(state, action);

      // Should overwrite with the new request to match backend state
      expect(newState.pendingRequest).toEqual({ type: 'permission', request: newRequest });
    });

    it('should replace pendingQuestion when permission request arrives', () => {
      const existingQuestion: UserQuestionRequest = {
        requestId: 'req-q1',
        questions: [{ question: 'Which?', header: 'Q', options: [], multiSelect: false }],
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const permissionRequest: PermissionRequest = {
        requestId: 'req-p1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        timestamp: '2024-01-01T00:00:01.000Z',
      };
      const state: ChatState = {
        ...initialState,
        pendingRequest: { type: 'question', request: existingQuestion },
      };
      const action: ChatAction = { type: 'WS_PERMISSION_REQUEST', payload: permissionRequest };
      const newState = chatReducer(state, action);

      // Discriminated union naturally replaces the question with permission
      expect(newState.pendingRequest).toEqual({ type: 'permission', request: permissionRequest });
    });
  });

  // -------------------------------------------------------------------------
  // WS_USER_QUESTION Action
  // -------------------------------------------------------------------------

  describe('WS_USER_QUESTION action', () => {
    it('should set pending user question request', () => {
      const questionRequest: UserQuestionRequest = {
        requestId: 'req-456',
        questions: [
          {
            question: 'Which file?',
            options: [
              { label: 'file1.txt', description: 'First file' },
              { label: 'file2.txt', description: 'Second file' },
            ],
          },
        ],
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const action: ChatAction = { type: 'WS_USER_QUESTION', payload: questionRequest };
      const newState = chatReducer(initialState, action);

      expect(newState.pendingRequest).toEqual({ type: 'question', request: questionRequest });
    });

    it('should overwrite existing pending question with newer one (matches backend behavior)', () => {
      // Backend always overwrites stored request with the new one, so frontend must match
      const existingQuestion: UserQuestionRequest = {
        requestId: 'req-first',
        questions: [{ question: 'First question?', header: 'Q1', options: [], multiSelect: false }],
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const newQuestion: UserQuestionRequest = {
        requestId: 'req-second',
        questions: [
          { question: 'Second question?', header: 'Q2', options: [], multiSelect: false },
        ],
        timestamp: '2024-01-01T00:00:01.000Z',
      };
      const state: ChatState = {
        ...initialState,
        pendingRequest: { type: 'question', request: existingQuestion },
      };
      const action: ChatAction = { type: 'WS_USER_QUESTION', payload: newQuestion };
      const newState = chatReducer(state, action);

      // Should overwrite with the new question to match backend state
      expect(newState.pendingRequest).toEqual({ type: 'question', request: newQuestion });
    });

    it('should replace pendingPermission when question request arrives', () => {
      const existingPermission: PermissionRequest = {
        requestId: 'req-p1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const questionRequest: UserQuestionRequest = {
        requestId: 'req-q1',
        questions: [{ question: 'Which?', header: 'Q', options: [], multiSelect: false }],
        timestamp: '2024-01-01T00:00:01.000Z',
      };
      const state: ChatState = {
        ...initialState,
        pendingRequest: { type: 'permission', request: existingPermission },
      };
      const action: ChatAction = { type: 'WS_USER_QUESTION', payload: questionRequest };
      const newState = chatReducer(state, action);

      // Discriminated union naturally replaces the permission with question
      expect(newState.pendingRequest).toEqual({ type: 'question', request: questionRequest });
    });
  });

  // -------------------------------------------------------------------------
  // WS_QUEUE_LOADED Action
  // -------------------------------------------------------------------------

  describe('WS_QUEUE_LOADED action', () => {
    it('should add queued messages to messages array', () => {
      const queuedMessages: QueuedMessage[] = [
        {
          id: 'q1',
          text: 'Queued message',
          timestamp: '2024-01-01T00:00:00.000Z',
          settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
        },
      ];
      const action: ChatAction = { type: 'WS_QUEUE_LOADED', payload: { queuedMessages } };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]).toEqual({
        id: 'q1',
        source: 'user',
        text: 'Queued message',
        timestamp: '2024-01-01T00:00:00.000Z',
        attachments: undefined,
      });
    });

    it('should set queuedMessages map from payload', () => {
      const queuedMessages: QueuedMessage[] = [
        {
          id: 'q1',
          text: 'Message 1',
          timestamp: '2024-01-01T00:00:00.000Z',
          settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
        },
        {
          id: 'q2',
          text: 'Message 2',
          timestamp: '2024-01-01T00:00:01.000Z',
          settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
        },
      ];
      const action: ChatAction = { type: 'WS_QUEUE_LOADED', payload: { queuedMessages } };
      const newState = chatReducer(initialState, action);

      expect(newState.queuedMessages.size).toBe(2);
      expect(newState.queuedMessages.get('q1')?.text).toBe('Message 1');
      expect(newState.queuedMessages.get('q2')?.text).toBe('Message 2');
    });

    it('should transition from loading to ready', () => {
      const state: ChatState = {
        ...initialState,
        sessionStatus: { phase: 'loading' },
      };
      const action: ChatAction = { type: 'WS_QUEUE_LOADED', payload: { queuedMessages: [] } };
      const newState = chatReducer(state, action);

      expect(newState.sessionStatus.phase).toBe('ready');
    });

    it('should be ignored if session is not in loading state (race condition protection)', () => {
      const queuedMessages: QueuedMessage[] = [
        {
          id: 'stale-q1',
          text: 'Stale queued message',
          timestamp: '2024-01-01T00:00:00.000Z',
          settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
        },
      ];
      const state: ChatState = {
        ...initialState,
        sessionStatus: { phase: 'running' },
        messages: [
          {
            id: 'existing',
            source: 'user',
            text: 'Already loaded',
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        ],
      };
      const action: ChatAction = { type: 'WS_QUEUE_LOADED', payload: { queuedMessages } };
      const newState = chatReducer(state, action);

      // Should return unchanged state - no stale data added
      expect(newState).toBe(state);
      expect(newState.sessionStatus.phase).toBe('running');
      expect(newState.messages).toHaveLength(1);
      expect(newState.queuedMessages.size).toBe(0);
    });

    it('should deduplicate messages that already exist', () => {
      const existingMessage: ChatMessage = {
        id: 'q1',
        source: 'user',
        text: 'Already exists',
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const state: ChatState = {
        ...initialState,
        sessionStatus: { phase: 'loading' },
        messages: [existingMessage],
      };
      const queuedMessages: QueuedMessage[] = [
        {
          id: 'q1', // Same ID - should be deduplicated
          text: 'Queued version',
          timestamp: '2024-01-01T00:00:00.000Z',
          settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
        },
        {
          id: 'q2', // New ID - should be added
          text: 'New message',
          timestamp: '2024-01-01T00:00:01.000Z',
          settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
        },
      ];
      const action: ChatAction = { type: 'WS_QUEUE_LOADED', payload: { queuedMessages } };
      const newState = chatReducer(state, action);

      // Should have original message + only the new queued message (q2)
      expect(newState.messages).toHaveLength(2);
      expect(newState.messages[0].id).toBe('q1');
      expect(newState.messages[0].text).toBe('Already exists'); // Original preserved
      expect(newState.messages[1].id).toBe('q2');
    });
  });

  // -------------------------------------------------------------------------
  // SESSION_SWITCH_START Action
  // -------------------------------------------------------------------------

  describe('SESSION_SWITCH_START action', () => {
    it('should reset state for session switch', () => {
      const state: ChatState = {
        ...initialState,
        messages: [
          { id: 'msg-1', source: 'user', text: 'Hello', timestamp: '2024-01-01T00:00:00.000Z' },
        ],
        sessionStatus: { phase: 'running' } as const,
        gitBranch: 'old-branch',
        pendingRequest: {
          type: 'permission',
          request: {
            requestId: 'req-1',
            toolName: 'Test',
            toolInput: {},
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        },
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'q-1',
            text: 'queued',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
          },
        ]),
        toolUseIdToIndex: new Map([['tool-1', 0]]),
        latestThinking: 'Some thinking from previous session',
      };

      const action: ChatAction = { type: 'SESSION_SWITCH_START' };
      const newState = chatReducer(state, action);

      expect(newState.messages).toEqual([]);
      expect(newState.gitBranch).toBeNull();
      expect(newState.pendingRequest).toEqual({ type: 'none' });
      expect(newState.sessionStatus).toEqual({ phase: 'loading' });
      expect(newState.queuedMessages.size).toBe(0);
      expect(newState.toolUseIdToIndex.size).toBe(0);
      expect(newState.latestThinking).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // SESSION_LOADING_START Action
  // -------------------------------------------------------------------------

  describe('SESSION_LOADING_START action', () => {
    it('should set loadingSession to true', () => {
      const action: ChatAction = { type: 'SESSION_LOADING_START' };
      const newState = chatReducer(initialState, action);

      expect(newState.sessionStatus).toEqual({ phase: 'loading' });
    });
  });

  // -------------------------------------------------------------------------
  // TOOL_INPUT_UPDATE Action (O(1) optimization)
  // -------------------------------------------------------------------------

  describe('TOOL_INPUT_UPDATE action', () => {
    it('should update tool input using O(1) lookup from toolUseIdToIndex', () => {
      const toolUseId = 'tool-use-abc';
      const toolUseMsg = createTestToolUseMessage(toolUseId);

      // First add the tool use message
      let state = chatReducer(initialState, { type: 'WS_CLAUDE_MESSAGE', payload: toolUseMsg });
      expect(state.toolUseIdToIndex.get(toolUseId)).toBe(0);

      // Now update the input
      const updatedInput = { file_path: '/updated/path.txt', content: 'new content' };
      const updateAction: ChatAction = {
        type: 'TOOL_INPUT_UPDATE',
        payload: { toolUseId, input: updatedInput },
      };
      state = chatReducer(state, updateAction);

      // Verify the update
      const updatedMessage = state.messages[0];
      const event = updatedMessage.message?.event as { content_block?: { input?: unknown } };
      expect(event?.content_block?.input).toEqual(updatedInput);
    });

    it('should fallback to linear scan if toolUseId not in index', () => {
      const toolUseId = 'tool-use-xyz';
      const toolUseMsg = createTestToolUseMessage(toolUseId);

      // Add tool use message but clear the index
      let state = chatReducer(initialState, { type: 'WS_CLAUDE_MESSAGE', payload: toolUseMsg });
      state = { ...state, toolUseIdToIndex: new Map() }; // Clear the index

      // Update should still work via linear scan
      const updatedInput = { command: 'updated command' };
      const updateAction: ChatAction = {
        type: 'TOOL_INPUT_UPDATE',
        payload: { toolUseId, input: updatedInput },
      };
      const newState = chatReducer(state, updateAction);

      // Verify update worked and index was populated
      const event = newState.messages[0].message?.event as { content_block?: { input?: unknown } };
      expect(event?.content_block?.input).toEqual(updatedInput);
      expect(newState.toolUseIdToIndex.get(toolUseId)).toBe(0);
    });

    it('should return state unchanged if toolUseId not found', () => {
      const action: ChatAction = {
        type: 'TOOL_INPUT_UPDATE',
        payload: { toolUseId: 'nonexistent', input: { foo: 'bar' } },
      };
      const newState = chatReducer(initialState, action);

      expect(newState).toBe(initialState);
    });
  });

  // -------------------------------------------------------------------------
  // TOOL_USE_INDEXED Action
  // -------------------------------------------------------------------------

  describe('TOOL_USE_INDEXED action', () => {
    it('should add toolUseId to index map', () => {
      const action: ChatAction = {
        type: 'TOOL_USE_INDEXED',
        payload: { toolUseId: 'tool-123', index: 5 },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.toolUseIdToIndex.get('tool-123')).toBe(5);
    });

    it('should preserve existing entries when adding new one', () => {
      const state = { ...initialState, toolUseIdToIndex: new Map([['tool-1', 0]]) };
      const action: ChatAction = {
        type: 'TOOL_USE_INDEXED',
        payload: { toolUseId: 'tool-2', index: 1 },
      };
      const newState = chatReducer(state, action);

      expect(newState.toolUseIdToIndex.get('tool-1')).toBe(0);
      expect(newState.toolUseIdToIndex.get('tool-2')).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // PERMISSION_RESPONSE Action
  // -------------------------------------------------------------------------

  describe('PERMISSION_RESPONSE action', () => {
    it('should clear pending request', () => {
      const state: ChatState = {
        ...initialState,
        pendingRequest: {
          type: 'permission',
          request: {
            requestId: 'req-1',
            toolName: 'Bash',
            toolInput: {},
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      const action: ChatAction = { type: 'PERMISSION_RESPONSE', payload: { allow: true } };
      const newState = chatReducer(state, action);

      expect(newState.pendingRequest).toEqual({ type: 'none' });
    });

    it('should disable plan mode when ExitPlanMode is approved', () => {
      const state: ChatState = {
        ...initialState,
        chatSettings: { ...initialState.chatSettings, planModeEnabled: true },
        pendingRequest: {
          type: 'permission',
          request: {
            requestId: 'req-1',
            toolName: 'ExitPlanMode',
            toolInput: {},
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      const action: ChatAction = { type: 'PERMISSION_RESPONSE', payload: { allow: true } };
      const newState = chatReducer(state, action);

      expect(newState.pendingRequest).toEqual({ type: 'none' });
      expect(newState.chatSettings.planModeEnabled).toBe(false);
    });

    it('should not disable plan mode when ExitPlanMode is denied', () => {
      const state: ChatState = {
        ...initialState,
        chatSettings: { ...initialState.chatSettings, planModeEnabled: true },
        pendingRequest: {
          type: 'permission',
          request: {
            requestId: 'req-1',
            toolName: 'ExitPlanMode',
            toolInput: {},
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      const action: ChatAction = { type: 'PERMISSION_RESPONSE', payload: { allow: false } };
      const newState = chatReducer(state, action);

      expect(newState.pendingRequest).toEqual({ type: 'none' });
      expect(newState.chatSettings.planModeEnabled).toBe(true);
    });

    it('should not affect plan mode for other tools', () => {
      const state: ChatState = {
        ...initialState,
        chatSettings: { ...initialState.chatSettings, planModeEnabled: true },
        pendingRequest: {
          type: 'permission',
          request: {
            requestId: 'req-1',
            toolName: 'Bash',
            toolInput: {},
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      const action: ChatAction = { type: 'PERMISSION_RESPONSE', payload: { allow: true } };
      const newState = chatReducer(state, action);

      expect(newState.pendingRequest).toEqual({ type: 'none' });
      expect(newState.chatSettings.planModeEnabled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // QUESTION_RESPONSE Action
  // -------------------------------------------------------------------------

  describe('QUESTION_RESPONSE action', () => {
    it('should clear pending request', () => {
      const state: ChatState = {
        ...initialState,
        pendingRequest: {
          type: 'question',
          request: {
            requestId: 'req-1',
            questions: [],
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      const action: ChatAction = { type: 'QUESTION_RESPONSE' };
      const newState = chatReducer(state, action);

      expect(newState.pendingRequest).toEqual({ type: 'none' });
    });
  });

  // -------------------------------------------------------------------------
  // STOP_REQUESTED Action
  // -------------------------------------------------------------------------

  describe('STOP_REQUESTED action', () => {
    it('should set stopping to true', () => {
      const action: ChatAction = { type: 'STOP_REQUESTED' };
      const newState = chatReducer(initialState, action);

      expect(newState.sessionStatus).toEqual({ phase: 'stopping' });
    });
  });

  // -------------------------------------------------------------------------
  // USER_MESSAGE_SENT Action
  // -------------------------------------------------------------------------

  describe('USER_MESSAGE_SENT action', () => {
    it('should add user message to messages array', () => {
      const userMessage: ChatMessage = {
        id: 'msg-123',
        source: 'user',
        text: 'Hello, Claude!',
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const action: ChatAction = { type: 'USER_MESSAGE_SENT', payload: userMessage };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]).toEqual(userMessage);
    });
  });

  // -------------------------------------------------------------------------
  // Queue Actions (Backend-managed)
  // -------------------------------------------------------------------------

  describe('ADD_TO_QUEUE action', () => {
    it('should add message to queuedMessages', () => {
      const queuedMessage: QueuedMessage = {
        id: 'q-1',
        text: 'Hello',
        timestamp: '2024-01-01T00:00:00.000Z',
        settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
      };
      const action: ChatAction = { type: 'ADD_TO_QUEUE', payload: queuedMessage };
      const newState = chatReducer(initialState, action);

      expect(newState.queuedMessages.size).toBe(1);
      expect(newState.queuedMessages.get(queuedMessage.id)).toEqual(queuedMessage);
    });

    it('should append to existing queue', () => {
      const existingMessage: QueuedMessage = {
        id: 'q-1',
        text: 'First',
        timestamp: '2024-01-01T00:00:00.000Z',
        settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
      };
      const state: ChatState = {
        ...initialState,
        queuedMessages: toQueuedMessagesMap([existingMessage]),
      };
      const newMessage: QueuedMessage = {
        id: 'q-2',
        text: 'Second',
        timestamp: '2024-01-01T00:00:01.000Z',
        settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
      };
      const action: ChatAction = { type: 'ADD_TO_QUEUE', payload: newMessage };
      const newState = chatReducer(state, action);

      expect(newState.queuedMessages.size).toBe(2);
      expect(newState.queuedMessages.get(existingMessage.id)).toEqual(existingMessage);
      expect(newState.queuedMessages.get(newMessage.id)).toEqual(newMessage);
    });
  });

  describe('MESSAGE_QUEUED action', () => {
    it('should be a no-op (optimistic UI already shows message)', () => {
      const action: ChatAction = { type: 'MESSAGE_QUEUED', payload: { id: 'q-1', position: 0 } };
      const newState = chatReducer(initialState, action);

      // State should be unchanged
      expect(newState).toEqual(initialState);
    });
  });

  describe('MESSAGE_DISPATCHED action', () => {
    it('should remove message from queuedMessages', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'q-1',
            text: 'First',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
          },
          {
            id: 'q-2',
            text: 'Second',
            timestamp: '2024-01-01T00:00:01.000Z',
            settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
          },
        ]),
      };
      const action: ChatAction = { type: 'MESSAGE_DISPATCHED', payload: { id: 'q-1' } };
      const newState = chatReducer(state, action);

      expect(newState.queuedMessages.size).toBe(1);
      expect(newState.queuedMessages.has('q-2')).toBe(true);
    });

    it('should handle dispatching message not in queue gracefully', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'q-1',
            text: 'First',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
          },
        ]),
      };
      const action: ChatAction = { type: 'MESSAGE_DISPATCHED', payload: { id: 'nonexistent' } };
      const newState = chatReducer(state, action);

      // Queue should be unchanged
      expect(newState.queuedMessages.size).toBe(1);
      expect(newState.queuedMessages.has('q-1')).toBe(true);
    });
  });

  describe('MESSAGE_REMOVED action', () => {
    it('should remove message from chat (undo optimistic update)', () => {
      const state: ChatState = {
        ...initialState,
        messages: [
          { id: 'msg-1', source: 'user', text: 'First', timestamp: '2024-01-01T00:00:00.000Z' },
          { id: 'msg-2', source: 'user', text: 'Second', timestamp: '2024-01-01T00:00:01.000Z' },
        ],
      };
      const action: ChatAction = { type: 'MESSAGE_REMOVED', payload: { id: 'msg-1' } };
      const newState = chatReducer(state, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0].id).toBe('msg-2');
    });

    it('should remove message from both messages and queuedMessages', () => {
      const state: ChatState = {
        ...initialState,
        messages: [
          { id: 'msg-1', source: 'user', text: 'First', timestamp: '2024-01-01T00:00:00.000Z' },
          { id: 'msg-2', source: 'user', text: 'Second', timestamp: '2024-01-01T00:00:01.000Z' },
        ],
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'msg-1',
            text: 'First',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
          },
          {
            id: 'msg-2',
            text: 'Second',
            timestamp: '2024-01-01T00:00:01.000Z',
            settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
          },
        ]),
      };
      const action: ChatAction = { type: 'MESSAGE_REMOVED', payload: { id: 'msg-1' } };
      const newState = chatReducer(state, action);

      // Should remove from both messages and queuedMessages
      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0].id).toBe('msg-2');
      expect(newState.queuedMessages.size).toBe(1);
      expect(newState.queuedMessages.has('msg-2')).toBe(true);
    });
  });

  describe('SET_QUEUE action', () => {
    it('should replace entire queue', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'old-1',
            text: 'Old',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
          },
        ]),
      };
      const newQueue: QueuedMessage[] = [
        {
          id: 'new-1',
          text: 'New 1',
          timestamp: '2024-01-02T00:00:00.000Z',
          settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
        },
        {
          id: 'new-2',
          text: 'New 2',
          timestamp: '2024-01-02T00:00:01.000Z',
          settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
        },
      ];
      const action: ChatAction = { type: 'SET_QUEUE', payload: newQueue };
      const newState = chatReducer(state, action);

      // SET_QUEUE converts array to Map
      expect(newState.queuedMessages.size).toBe(2);
      expect(newState.queuedMessages.get('new-1')?.text).toBe('New 1');
      expect(newState.queuedMessages.get('new-2')?.text).toBe('New 2');
    });
  });

  // -------------------------------------------------------------------------
  // Settings Actions
  // -------------------------------------------------------------------------

  describe('UPDATE_SETTINGS action', () => {
    it('should merge partial settings', () => {
      const action: ChatAction = {
        type: 'UPDATE_SETTINGS',
        payload: { thinkingEnabled: true },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.chatSettings.thinkingEnabled).toBe(true);
      expect(newState.chatSettings.selectedModel).toBe(DEFAULT_CHAT_SETTINGS.selectedModel);
      expect(newState.chatSettings.planModeEnabled).toBe(DEFAULT_CHAT_SETTINGS.planModeEnabled);
    });

    it('should update multiple settings at once', () => {
      const action: ChatAction = {
        type: 'UPDATE_SETTINGS',
        payload: { selectedModel: 'sonnet', planModeEnabled: true },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.chatSettings.selectedModel).toBe('sonnet');
      expect(newState.chatSettings.planModeEnabled).toBe(true);
    });
  });

  describe('SET_SETTINGS action', () => {
    it('should replace entire settings object', () => {
      const newSettings: ChatSettings = {
        selectedModel: 'opus',
        thinkingEnabled: true,
        planModeEnabled: true,
      };
      const action: ChatAction = { type: 'SET_SETTINGS', payload: newSettings };
      const newState = chatReducer(initialState, action);

      expect(newState.chatSettings).toEqual(newSettings);
    });
  });

  // -------------------------------------------------------------------------
  // THINKING_DELTA Action (Extended Thinking Mode)
  // -------------------------------------------------------------------------

  describe('THINKING_DELTA action', () => {
    it('should accumulate thinking content from null', () => {
      const state: ChatState = { ...initialState, latestThinking: null };
      const action: ChatAction = {
        type: 'THINKING_DELTA',
        payload: { thinking: 'First thought' },
      };
      const newState = chatReducer(state, action);

      expect(newState.latestThinking).toBe('First thought');
    });

    it('should accumulate thinking content from existing', () => {
      const state: ChatState = { ...initialState, latestThinking: 'First thought' };
      const action: ChatAction = {
        type: 'THINKING_DELTA',
        payload: { thinking: ' and second thought' },
      };
      const newState = chatReducer(state, action);

      expect(newState.latestThinking).toBe('First thought and second thought');
    });

    it('should handle empty delta', () => {
      const state: ChatState = { ...initialState, latestThinking: 'Existing' };
      const action: ChatAction = {
        type: 'THINKING_DELTA',
        payload: { thinking: '' },
      };
      const newState = chatReducer(state, action);

      expect(newState.latestThinking).toBe('Existing');
    });
  });

  // -------------------------------------------------------------------------
  // THINKING_CLEAR Action
  // -------------------------------------------------------------------------

  describe('THINKING_CLEAR action', () => {
    it('should clear thinking content', () => {
      const state: ChatState = { ...initialState, latestThinking: 'Some thinking' };
      const action: ChatAction = { type: 'THINKING_CLEAR' };
      const newState = chatReducer(state, action);

      expect(newState.latestThinking).toBeNull();
    });

    it('should handle clearing already null thinking', () => {
      const state: ChatState = { ...initialState, latestThinking: null };
      const action: ChatAction = { type: 'THINKING_CLEAR' };
      const newState = chatReducer(state, action);

      expect(newState.latestThinking).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // CLEAR_CHAT Action
  // -------------------------------------------------------------------------

  describe('CLEAR_CHAT action', () => {
    it('should reset chat state but preserve some fields', () => {
      const state: ChatState = {
        ...initialState,
        messages: [
          { id: 'msg-1', source: 'user', text: 'Hello', timestamp: '2024-01-01T00:00:00.000Z' },
        ],
        sessionStatus: { phase: 'running' } as const,
        gitBranch: 'feature/test',
        pendingRequest: {
          type: 'permission',
          request: {
            requestId: 'req-1',
            toolName: 'Test',
            toolInput: {},
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        },
        chatSettings: { selectedModel: 'sonnet', thinkingEnabled: true, planModeEnabled: true },
        toolUseIdToIndex: new Map([['tool-1', 0]]),
      };

      const action: ChatAction = { type: 'CLEAR_CHAT' };
      const newState = chatReducer(state, action);

      expect(newState.messages).toEqual([]);
      expect(newState.gitBranch).toBeNull();
      expect(newState.pendingRequest).toEqual({ type: 'none' });
      // CLEAR_CHAT preserves running state but resets starting/stopping to ready
      expect(newState.sessionStatus).toEqual({ phase: 'running' });
      expect(newState.chatSettings).toEqual(DEFAULT_CHAT_SETTINGS);
      expect(newState.toolUseIdToIndex.size).toBe(0);
      // running state is preserved by CLEAR_CHAT (not reset to ready)
      expect(newState.sessionStatus).toEqual({ phase: 'running' });
    });
  });

  // -------------------------------------------------------------------------
  // RESET_FOR_SESSION_SWITCH Action
  // -------------------------------------------------------------------------

  describe('RESET_FOR_SESSION_SWITCH action', () => {
    it('should reset state for session switch but preserve some fields', () => {
      const state: ChatState = {
        ...initialState,
        messages: [
          { id: 'msg-1', source: 'user', text: 'Hello', timestamp: '2024-01-01T00:00:00.000Z' },
        ],
        sessionStatus: { phase: 'running' } as const,
        gitBranch: 'feature/test',
        chatSettings: { selectedModel: 'sonnet', thinkingEnabled: true, planModeEnabled: false },
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'q-1',
            text: 'queued',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
          },
        ]),
      };

      const action: ChatAction = { type: 'RESET_FOR_SESSION_SWITCH' };
      const newState = chatReducer(state, action);

      expect(newState.messages).toEqual([]);
      expect(newState.gitBranch).toBeNull();
      expect(newState.sessionStatus).toEqual({ phase: 'loading' });
      expect(newState.queuedMessages.size).toBe(0);
      // Settings are preserved
      expect(newState.chatSettings).toEqual(state.chatSettings);
    });
  });

  // -------------------------------------------------------------------------
  // Default Case
  // -------------------------------------------------------------------------

  describe('unknown action', () => {
    it('should return state unchanged for unknown action', () => {
      const unknownAction = { type: 'UNKNOWN_ACTION' } as unknown as ChatAction;
      const newState = chatReducer(initialState, unknownAction);

      expect(newState).toBe(initialState);
    });
  });
});

// =============================================================================
// createActionFromWebSocketMessage Tests
// =============================================================================

describe('createActionFromWebSocketMessage', () => {
  it('should convert status message to WS_STATUS action', () => {
    const wsMessage: WebSocketMessage = { type: 'status', running: true };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'WS_STATUS', payload: { running: true } });
  });

  it('should default running to false if not provided in status message', () => {
    const wsMessage: WebSocketMessage = { type: 'status' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'WS_STATUS', payload: { running: false } });
  });

  it('should convert starting message to WS_STARTING action', () => {
    const wsMessage: WebSocketMessage = { type: 'starting' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'WS_STARTING' });
  });

  it('should convert started message to WS_STARTED action', () => {
    const wsMessage: WebSocketMessage = { type: 'started' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'WS_STARTED' });
  });

  it('should convert stopped message to WS_STOPPED action', () => {
    const wsMessage: WebSocketMessage = { type: 'stopped' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'WS_STOPPED' });
  });

  it('should convert process_exit message to WS_STOPPED action', () => {
    const wsMessage: WebSocketMessage = { type: 'process_exit', code: 0 };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'WS_STOPPED' });
  });

  it('should convert claude_message to WS_CLAUDE_MESSAGE action', () => {
    const claudeMsg: ClaudeMessage = {
      type: 'assistant',
      message: { role: 'assistant', content: 'Hello!' },
    };
    const wsMessage: WebSocketMessage = { type: 'claude_message', data: claudeMsg };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'WS_CLAUDE_MESSAGE', payload: claudeMsg });
  });

  it('should return null for claude_message without data', () => {
    const wsMessage: WebSocketMessage = { type: 'claude_message' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should convert error message to WS_ERROR action', () => {
    const wsMessage: WebSocketMessage = { type: 'error', message: 'Connection lost' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'WS_ERROR', payload: { message: 'Connection lost' } });
  });

  it('should return null for error message without message field', () => {
    const wsMessage: WebSocketMessage = { type: 'error' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should convert sessions message to WS_SESSIONS action', () => {
    const sessions: SessionInfo[] = [
      {
        claudeSessionId: 'session-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-01T00:00:00.000Z',
        sizeBytes: 1024,
      },
    ];
    const wsMessage: WebSocketMessage = { type: 'sessions', sessions };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'WS_SESSIONS', payload: { sessions } });
  });

  it('should return null for sessions message without sessions field', () => {
    const wsMessage: WebSocketMessage = { type: 'sessions' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should convert session_loaded message to WS_SESSION_LOADED action', () => {
    const messages: HistoryMessage[] = [
      { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00.000Z' },
    ];
    const settings: ChatSettings = {
      selectedModel: 'opus',
      thinkingEnabled: false,
      planModeEnabled: false,
    };
    const wsMessage: WebSocketMessage = {
      type: 'session_loaded',
      messages,
      gitBranch: 'main',
      running: false,
      settings,
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({
      type: 'WS_SESSION_LOADED',
      payload: {
        messages,
        gitBranch: 'main',
        running: false,
        settings,
        pendingInteractiveRequest: null,
        queuedMessages: [],
      },
    });
  });

  it('should handle session_loaded with missing optional fields', () => {
    const wsMessage: WebSocketMessage = { type: 'session_loaded' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({
      type: 'WS_SESSION_LOADED',
      payload: {
        messages: [],
        gitBranch: null,
        running: false,
        settings: undefined,
        pendingInteractiveRequest: null,
        queuedMessages: [],
      },
    });
  });

  it('should convert permission_request to WS_PERMISSION_REQUEST action', () => {
    const wsMessage: WebSocketMessage = {
      type: 'permission_request',
      requestId: 'req-123',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action?.type).toBe('WS_PERMISSION_REQUEST');
    expect((action as { payload: PermissionRequest }).payload.requestId).toBe('req-123');
    expect((action as { payload: PermissionRequest }).payload.toolName).toBe('Bash');
    expect((action as { payload: PermissionRequest }).payload.toolInput).toEqual({ command: 'ls' });
    expect((action as { payload: PermissionRequest }).payload.timestamp).toBeDefined();
  });

  it('should return null for permission_request without requestId', () => {
    const wsMessage: WebSocketMessage = {
      type: 'permission_request',
      toolName: 'Bash',
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should return null for permission_request without toolName', () => {
    const wsMessage: WebSocketMessage = {
      type: 'permission_request',
      requestId: 'req-123',
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should convert user_question to WS_USER_QUESTION action', () => {
    const questions = [
      {
        question: 'Which file?',
        options: [{ label: 'file1.txt', description: 'First file' }],
      },
    ];
    const wsMessage: WebSocketMessage = {
      type: 'user_question',
      requestId: 'req-456',
      questions,
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action?.type).toBe('WS_USER_QUESTION');
    expect((action as { payload: UserQuestionRequest }).payload.requestId).toBe('req-456');
    expect((action as { payload: UserQuestionRequest }).payload.questions).toEqual(questions);
    expect((action as { payload: UserQuestionRequest }).payload.timestamp).toBeDefined();
  });

  it('should return null for user_question without requestId', () => {
    const wsMessage: WebSocketMessage = {
      type: 'user_question',
      questions: [],
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should return null for user_question without questions', () => {
    const wsMessage: WebSocketMessage = {
      type: 'user_question',
      requestId: 'req-456',
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should return null for message_queued without id', () => {
    const wsMessage: WebSocketMessage = { type: 'message_queued' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should convert message_queued to MESSAGE_QUEUED action', () => {
    const wsMessage: WebSocketMessage = { type: 'message_queued', id: 'msg-1', position: 2 };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'MESSAGE_QUEUED', payload: { id: 'msg-1', position: 2 } });
  });

  it('should convert message_dispatched to MESSAGE_DISPATCHED action', () => {
    const wsMessage: WebSocketMessage = { type: 'message_dispatched', id: 'msg-1' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'MESSAGE_DISPATCHED', payload: { id: 'msg-1' } });
  });

  it('should return null for message_dispatched without id', () => {
    const wsMessage: WebSocketMessage = { type: 'message_dispatched' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should convert message_removed to MESSAGE_REMOVED action', () => {
    const wsMessage: WebSocketMessage = { type: 'message_removed', id: 'msg-1' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'MESSAGE_REMOVED', payload: { id: 'msg-1' } });
  });

  it('should convert queue to WS_QUEUE_LOADED action', () => {
    const queuedMessages: QueuedMessage[] = [
      {
        id: 'q1',
        text: 'Queued',
        timestamp: '2024-01-01T00:00:00.000Z',
        settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
      },
    ];
    const wsMessage: WebSocketMessage = { type: 'queue', queuedMessages };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'WS_QUEUE_LOADED', payload: { queuedMessages } });
  });

  it('should convert queue to WS_QUEUE_LOADED with empty array when queuedMessages missing', () => {
    const wsMessage: WebSocketMessage = { type: 'queue' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'WS_QUEUE_LOADED', payload: { queuedMessages: [] } });
  });

  it('should return null for unknown message type', () => {
    const wsMessage = { type: 'unknown_type' } as unknown as WebSocketMessage;
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });
});

// =============================================================================
// Action Creator Tests
// =============================================================================

describe('createUserMessageAction', () => {
  it('should create USER_MESSAGE_SENT action with generated id', () => {
    const action = createUserMessageAction('Hello, Claude!');

    expect(action.type).toBe('USER_MESSAGE_SENT');
    // Type guard: action is USER_MESSAGE_SENT type with ChatMessage payload
    if (action.type === 'USER_MESSAGE_SENT') {
      expect(action.payload.source).toBe('user');
      expect(action.payload.text).toBe('Hello, Claude!');
      expect(action.payload.id).toMatch(/^msg-\d+-\w+$/);
      expect(action.payload.timestamp).toBeDefined();
    }
  });

  it('should create unique ids for different calls', () => {
    const action1 = createUserMessageAction('First');
    const action2 = createUserMessageAction('Second');

    // Type guard: action is USER_MESSAGE_SENT type with ChatMessage payload
    if (action1.type === 'USER_MESSAGE_SENT' && action2.type === 'USER_MESSAGE_SENT') {
      expect(action1.payload.id).not.toBe(action2.payload.id);
    }
  });
});

// Note: createQueueMessageAction has been removed.
// Queue is now managed on the backend and MESSAGE_QUEUED/MESSAGE_DISPATCHED/MESSAGE_REMOVED
// actions are received from WebSocket events.
