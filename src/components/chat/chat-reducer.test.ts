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
  createQueueMessageAction,
  createUserMessageAction,
} from './chat-reducer';

// =============================================================================
// Test Helpers
// =============================================================================

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
    expect(state.running).toBe(false);
    expect(state.stopping).toBe(false);
    expect(state.gitBranch).toBeNull();
    expect(state.availableSessions).toEqual([]);
    expect(state.pendingPermission).toBeNull();
    expect(state.pendingQuestion).toBeNull();
    expect(state.loadingSession).toBe(false);
    expect(state.startingSession).toBe(false);
    expect(state.chatSettings).toEqual(DEFAULT_CHAT_SETTINGS);
    expect(state.queuedMessages).toEqual([]);
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
      running: true,
      gitBranch: 'feature/test',
      chatSettings: customSettings,
    });

    expect(state.running).toBe(true);
    expect(state.gitBranch).toBe('feature/test');
    expect(state.chatSettings).toEqual(customSettings);
    // Other values should still be defaults
    expect(state.messages).toEqual([]);
    expect(state.stopping).toBe(false);
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
    it('should set running to true', () => {
      const action: ChatAction = { type: 'WS_STATUS', payload: { running: true } };
      const newState = chatReducer(initialState, action);

      expect(newState.running).toBe(true);
    });

    it('should set running to false', () => {
      const state = { ...initialState, running: true };
      const action: ChatAction = { type: 'WS_STATUS', payload: { running: false } };
      const newState = chatReducer(state, action);

      expect(newState.running).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // WS_STARTING Action
  // -------------------------------------------------------------------------

  describe('WS_STARTING action', () => {
    it('should set startingSession to true', () => {
      const action: ChatAction = { type: 'WS_STARTING' };
      const newState = chatReducer(initialState, action);

      expect(newState.startingSession).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // WS_STARTED Action
  // -------------------------------------------------------------------------

  describe('WS_STARTED action', () => {
    it('should set running to true and clear starting flag', () => {
      const state = { ...initialState, startingSession: true };
      const action: ChatAction = { type: 'WS_STARTED' };
      const newState = chatReducer(state, action);

      expect(newState.running).toBe(true);
      expect(newState.startingSession).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // WS_STOPPED Action
  // -------------------------------------------------------------------------

  describe('WS_STOPPED action', () => {
    it('should clear running, stopping, and startingSession flags', () => {
      const state = { ...initialState, running: true, stopping: true, startingSession: true };
      const action: ChatAction = { type: 'WS_STOPPED' };
      const newState = chatReducer(state, action);

      expect(newState.running).toBe(false);
      expect(newState.stopping).toBe(false);
      expect(newState.startingSession).toBe(false);
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

    it('should clear startingSession when receiving a Claude message', () => {
      const state = { ...initialState, startingSession: true };
      const claudeMsg = createTestAssistantMessage();
      const action: ChatAction = { type: 'WS_CLAUDE_MESSAGE', payload: claudeMsg };
      const newState = chatReducer(state, action);

      expect(newState.startingSession).toBe(false);
    });

    it('should set running to false when receiving a result message', () => {
      const state = { ...initialState, running: true };
      const resultMsg = createTestResultMessage();
      const action: ChatAction = { type: 'WS_CLAUDE_MESSAGE', payload: resultMsg };
      const newState = chatReducer(state, action);

      expect(newState.running).toBe(false);
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
      expect(newState.running).toBe(false);
      expect(newState.loadingSession).toBe(false);
      expect(newState.toolUseIdToIndex.size).toBe(0);
    });

    it('should handle empty history', () => {
      const state = { ...initialState, loadingSession: true };
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
      expect(newState.running).toBe(true);
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
        loadingSession: true,
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
        loadingSession: true,
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

    it('should deduplicate messages that exist in both state and history', () => {
      // Scenario: WebSocket reconnect where the same message exists in both
      // state and history - should not create duplicates
      const timestamp = '2024-01-01T00:00:02.000Z';
      const optimisticMessage: ChatMessage = {
        id: 'msg-123',
        source: 'user',
        text: 'Help me debug this',
        timestamp,
      };

      const historyMessages: HistoryMessage[] = [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00.000Z' },
        { type: 'assistant', content: 'Hi there!', timestamp: '2024-01-01T00:00:01.000Z' },
        // Same message as optimisticMessage
        { type: 'user', content: 'Help me debug this', timestamp, uuid: 'history-123' },
      ];

      const state = {
        ...initialState,
        messages: [optimisticMessage],
        loadingSession: true,
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

      // Should only have 3 messages (not 4), with no duplicates
      expect(newState.messages).toHaveLength(3);
      expect(newState.messages[0].source).toBe('user');
      expect(newState.messages[0].text).toBe('Hello');
      expect(newState.messages[1].source).toBe('claude');
      expect(newState.messages[2].source).toBe('user');
      expect(newState.messages[2].text).toBe('Help me debug this');
    });

    it('should handle timestamp variations when deduplicating', () => {
      // Optimistic message has slightly different timestamp (within 5 seconds)
      const optimisticMessage: ChatMessage = {
        id: 'msg-123',
        source: 'user',
        text: 'Help me debug this',
        timestamp: '2024-01-01T00:00:02.000Z',
      };

      const historyMessages: HistoryMessage[] = [
        // Same content but timestamp is 3 seconds earlier
        { type: 'user', content: 'Help me debug this', timestamp: '2024-01-01T00:00:05.000Z' },
      ];

      const state = {
        ...initialState,
        messages: [optimisticMessage],
        loadingSession: true,
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

      // Should deduplicate despite small timestamp difference
      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0].text).toBe('Help me debug this');
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

      expect(newState.pendingPermission).toEqual(permissionRequest);
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

      expect(newState.pendingQuestion).toEqual(questionRequest);
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
        running: true,
        gitBranch: 'old-branch',
        pendingPermission: {
          requestId: 'req-1',
          toolName: 'Test',
          toolInput: {},
          timestamp: '2024-01-01T00:00:00.000Z',
        },
        queuedMessages: [{ id: 'q-1', text: 'queued', timestamp: '2024-01-01T00:00:00.000Z' }],
        toolUseIdToIndex: new Map([['tool-1', 0]]),
      };

      const action: ChatAction = { type: 'SESSION_SWITCH_START' };
      const newState = chatReducer(state, action);

      expect(newState.messages).toEqual([]);
      expect(newState.gitBranch).toBeNull();
      expect(newState.pendingPermission).toBeNull();
      expect(newState.pendingQuestion).toBeNull();
      expect(newState.startingSession).toBe(false);
      expect(newState.loadingSession).toBe(true);
      expect(newState.running).toBe(false);
      expect(newState.queuedMessages).toEqual([]);
      expect(newState.toolUseIdToIndex.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // SESSION_LOADING_START Action
  // -------------------------------------------------------------------------

  describe('SESSION_LOADING_START action', () => {
    it('should set loadingSession to true', () => {
      const action: ChatAction = { type: 'SESSION_LOADING_START' };
      const newState = chatReducer(initialState, action);

      expect(newState.loadingSession).toBe(true);
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
    it('should clear pending permission', () => {
      const state: ChatState = {
        ...initialState,
        pendingPermission: {
          requestId: 'req-1',
          toolName: 'Bash',
          toolInput: {},
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      };
      const action: ChatAction = { type: 'PERMISSION_RESPONSE' };
      const newState = chatReducer(state, action);

      expect(newState.pendingPermission).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // QUESTION_RESPONSE Action
  // -------------------------------------------------------------------------

  describe('QUESTION_RESPONSE action', () => {
    it('should clear pending question', () => {
      const state: ChatState = {
        ...initialState,
        pendingQuestion: {
          requestId: 'req-1',
          questions: [],
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      };
      const action: ChatAction = { type: 'QUESTION_RESPONSE' };
      const newState = chatReducer(state, action);

      expect(newState.pendingQuestion).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // STOP_REQUESTED Action
  // -------------------------------------------------------------------------

  describe('STOP_REQUESTED action', () => {
    it('should set stopping to true', () => {
      const action: ChatAction = { type: 'STOP_REQUESTED' };
      const newState = chatReducer(initialState, action);

      expect(newState.stopping).toBe(true);
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
  // Queue Actions
  // -------------------------------------------------------------------------

  describe('QUEUE_MESSAGE action', () => {
    it('should add message to queue', () => {
      const queuedMsg: QueuedMessage = {
        id: 'q-1',
        text: 'Queued message',
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const action: ChatAction = { type: 'QUEUE_MESSAGE', payload: queuedMsg };
      const newState = chatReducer(initialState, action);

      expect(newState.queuedMessages).toHaveLength(1);
      expect(newState.queuedMessages[0]).toEqual(queuedMsg);
    });
  });

  describe('DEQUEUE_MESSAGE action', () => {
    it('should remove first message from queue', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: [
          { id: 'q-1', text: 'First', timestamp: '2024-01-01T00:00:00.000Z' },
          { id: 'q-2', text: 'Second', timestamp: '2024-01-01T00:00:01.000Z' },
        ],
      };
      const action: ChatAction = { type: 'DEQUEUE_MESSAGE' };
      const newState = chatReducer(state, action);

      expect(newState.queuedMessages).toHaveLength(1);
      expect(newState.queuedMessages[0].id).toBe('q-2');
    });

    it('should handle empty queue', () => {
      const action: ChatAction = { type: 'DEQUEUE_MESSAGE' };
      const newState = chatReducer(initialState, action);

      expect(newState.queuedMessages).toEqual([]);
    });
  });

  describe('REMOVE_QUEUED_MESSAGE action', () => {
    it('should remove specific message from queue by id', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: [
          { id: 'q-1', text: 'First', timestamp: '2024-01-01T00:00:00.000Z' },
          { id: 'q-2', text: 'Second', timestamp: '2024-01-01T00:00:01.000Z' },
          { id: 'q-3', text: 'Third', timestamp: '2024-01-01T00:00:02.000Z' },
        ],
      };
      const action: ChatAction = { type: 'REMOVE_QUEUED_MESSAGE', payload: { id: 'q-2' } };
      const newState = chatReducer(state, action);

      expect(newState.queuedMessages).toHaveLength(2);
      expect(newState.queuedMessages[0].id).toBe('q-1');
      expect(newState.queuedMessages[1].id).toBe('q-3');
    });
  });

  describe('SET_QUEUE action', () => {
    it('should replace entire queue', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: [{ id: 'old-1', text: 'Old', timestamp: '2024-01-01T00:00:00.000Z' }],
      };
      const newQueue: QueuedMessage[] = [
        { id: 'new-1', text: 'New 1', timestamp: '2024-01-02T00:00:00.000Z' },
        { id: 'new-2', text: 'New 2', timestamp: '2024-01-02T00:00:01.000Z' },
      ];
      const action: ChatAction = { type: 'SET_QUEUE', payload: newQueue };
      const newState = chatReducer(state, action);

      expect(newState.queuedMessages).toEqual(newQueue);
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
  // CLEAR_CHAT Action
  // -------------------------------------------------------------------------

  describe('CLEAR_CHAT action', () => {
    it('should reset chat state but preserve some fields', () => {
      const state: ChatState = {
        ...initialState,
        messages: [
          { id: 'msg-1', source: 'user', text: 'Hello', timestamp: '2024-01-01T00:00:00.000Z' },
        ],
        running: true,
        stopping: true,
        gitBranch: 'feature/test',
        pendingPermission: {
          requestId: 'req-1',
          toolName: 'Test',
          toolInput: {},
          timestamp: '2024-01-01T00:00:00.000Z',
        },
        startingSession: true,
        chatSettings: { selectedModel: 'sonnet', thinkingEnabled: true, planModeEnabled: true },
        toolUseIdToIndex: new Map([['tool-1', 0]]),
      };

      const action: ChatAction = { type: 'CLEAR_CHAT' };
      const newState = chatReducer(state, action);

      expect(newState.messages).toEqual([]);
      expect(newState.gitBranch).toBeNull();
      expect(newState.pendingPermission).toBeNull();
      expect(newState.pendingQuestion).toBeNull();
      expect(newState.startingSession).toBe(false);
      expect(newState.stopping).toBe(false);
      expect(newState.chatSettings).toEqual(DEFAULT_CHAT_SETTINGS);
      expect(newState.toolUseIdToIndex.size).toBe(0);
      // running state is not reset by CLEAR_CHAT
      expect(newState.running).toBe(true);
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
        running: true,
        gitBranch: 'feature/test',
        chatSettings: { selectedModel: 'sonnet', thinkingEnabled: true, planModeEnabled: false },
        queuedMessages: [{ id: 'q-1', text: 'queued', timestamp: '2024-01-01T00:00:00.000Z' }],
      };

      const action: ChatAction = { type: 'RESET_FOR_SESSION_SWITCH' };
      const newState = chatReducer(state, action);

      expect(newState.messages).toEqual([]);
      expect(newState.gitBranch).toBeNull();
      expect(newState.loadingSession).toBe(true);
      expect(newState.running).toBe(false);
      expect(newState.queuedMessages).toEqual([]);
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

  it('should return null for message_queued type', () => {
    const wsMessage: WebSocketMessage = { type: 'message_queued' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
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

describe('createQueueMessageAction', () => {
  it('should create QUEUE_MESSAGE action with trimmed text', () => {
    const action = createQueueMessageAction('  Hello, Claude!  ');

    expect(action.type).toBe('QUEUE_MESSAGE');
    // Type guard: action is QUEUE_MESSAGE type with QueuedMessage payload
    if (action.type === 'QUEUE_MESSAGE') {
      expect(action.payload.text).toBe('Hello, Claude!');
      expect(action.payload.id).toMatch(/^msg-\d+-\w+$/);
      expect(action.payload.timestamp).toBeDefined();
    }
  });

  it('should create unique ids for different calls', () => {
    const action1 = createQueueMessageAction('First');
    const action2 = createQueueMessageAction('Second');

    // Type guard: action is QUEUE_MESSAGE type with QueuedMessage payload
    if (action1.type === 'QUEUE_MESSAGE' && action2.type === 'QUEUE_MESSAGE') {
      expect(action1.payload.id).not.toBe(action2.payload.id);
    }
  });
});
