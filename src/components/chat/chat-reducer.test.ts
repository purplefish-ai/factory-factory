/**
 * Tests for the chat reducer module.
 *
 * This file tests all state transitions, action creators, and helper functions
 * for the chat state management.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentMessage,
  ChatMessage,
  ChatSettings,
  PermissionRequest,
  QueuedMessage,
  SessionInfo,
  UserQuestionRequest,
  WebSocketMessage,
} from '@/lib/chat-protocol';
import { DEFAULT_CHAT_SETTINGS, MessageState } from '@/lib/chat-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  type ChatAction,
  type ChatState,
  chatReducer,
  createActionFromWebSocketMessage,
  createInitialChatState,
  createUserMessageAction,
} from './reducer';

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

function createFullyEnabledCapabilities(
  selectedModel = DEFAULT_CHAT_SETTINGS.selectedModel
): ChatBarCapabilities {
  return {
    provider: 'CLAUDE',
    model: {
      enabled: true,
      options: [
        { value: 'opus', label: 'Opus' },
        { value: 'sonnet', label: 'Sonnet' },
      ],
      selected: selectedModel,
    },
    reasoning: {
      enabled: true,
      options: [{ value: 'medium', label: 'Medium' }],
      selected: 'medium',
    },
    thinking: { enabled: true, defaultBudget: 10_000 },
    planMode: { enabled: true },
    attachments: { enabled: true, kinds: ['image', 'text'] },
    slashCommands: { enabled: true },
    usageStats: { enabled: true, contextWindow: true },
    rewind: { enabled: true },
  };
}

function createTestToolUseMessage(toolUseId: string): AgentMessage {
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

function createTestAssistantMessage(): AgentMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
    },
  };
}

function createTestThinkingAssistantMessage(): AgentMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Planning internally' }],
    },
  };
}

function createTestResultMessage(result?: unknown): AgentMessage {
  return {
    type: 'result',
    usage: { input_tokens: 100, output_tokens: 50 },
    duration_ms: 1000,
    total_cost_usd: 0.01,
    num_turns: 1,
    ...(result !== undefined ? { result } : {}),
  };
}

function createTestThinkingMessage(): AgentMessage {
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

function createTestToolResultMessage(toolUseId: string): AgentMessage {
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
      ...DEFAULT_CHAT_SETTINGS,
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
  // Runtime Actions
  // -------------------------------------------------------------------------

  describe('runtime actions', () => {
    it('sets sessionStatus to running for SESSION_RUNTIME_UPDATED running payload', () => {
      const action: ChatAction = {
        type: 'SESSION_RUNTIME_UPDATED',
        payload: {
          sessionRuntime: {
            phase: 'running',
            processState: 'alive',
            activity: 'WORKING',
            updatedAt: '2026-02-08T00:00:00.000Z',
          },
        },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.sessionStatus).toEqual({ phase: 'running' });
    });

    it('sets sessionStatus to ready for SESSION_RUNTIME_UPDATED idle payload', () => {
      const state = { ...initialState, sessionStatus: { phase: 'running' } as const };
      const action: ChatAction = {
        type: 'SESSION_RUNTIME_UPDATED',
        payload: {
          sessionRuntime: {
            phase: 'idle',
            processState: 'alive',
            activity: 'IDLE',
            updatedAt: '2026-02-08T00:00:00.000Z',
          },
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.sessionStatus).toEqual({ phase: 'ready' });
    });

    it('clears lastExit info when runtime update omits lastExit', () => {
      const state = {
        ...initialState,
        sessionRuntime: {
          phase: 'error' as const,
          processState: 'stopped' as const,
          activity: 'IDLE' as const,
          updatedAt: '2026-02-08T00:00:00.000Z',
          lastExit: {
            code: 1,
            timestamp: '2026-02-03T12:00:00.000Z',
            unexpected: true,
          },
        },
        processStatus: {
          state: 'stopped' as const,
          lastExit: {
            code: 1,
            exitedAt: '2026-02-03T12:00:00.000Z',
            unexpected: true,
          },
        },
      };
      const action: ChatAction = {
        type: 'SESSION_RUNTIME_UPDATED',
        payload: {
          sessionRuntime: {
            phase: 'idle',
            processState: 'stopped',
            activity: 'IDLE',
            updatedAt: '2026-02-08T00:00:00.000Z',
          },
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.processStatus).toEqual({ state: 'stopped' });
    });
  });

  // -------------------------------------------------------------------------
  // SESSION_RUNTIME_UPDATED Action
  // -------------------------------------------------------------------------

  describe('SESSION_RUNTIME_UPDATED action', () => {
    it('clears transient UI state when runtime indicates process stopped', () => {
      const state: ChatState = {
        ...initialState,
        isCompacting: true,
        toolProgress: new Map([['tool-1', { toolName: 'Edit', elapsedSeconds: 5 }]]),
        activeHooks: new Map([
          [
            'hook-1',
            {
              hookId: 'hook-1',
              hookName: 'PostToolUse',
              hookEvent: 'PostToolUse',
              startedAt: '2026-02-07T00:00:00.000Z',
            },
          ],
        ]),
      };

      const action: ChatAction = {
        type: 'SESSION_RUNTIME_UPDATED',
        payload: {
          sessionRuntime: {
            phase: 'idle',
            processState: 'stopped',
            activity: 'IDLE',
            updatedAt: '2026-02-07T00:00:01.000Z',
          },
        },
      };

      const newState = chatReducer(state, action);

      expect(newState.isCompacting).toBe(false);
      expect(newState.toolProgress.size).toBe(0);
      expect(newState.activeHooks.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // WS_AGENT_MESSAGE Action
  // -------------------------------------------------------------------------

  describe('WS_AGENT_MESSAGE action', () => {
    it('should add assistant message with tool content to messages array', () => {
      const claudeMsg: AgentMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'test.ts' } }],
        },
      };
      const action: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: claudeMsg, order: 0 },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]!.source).toBe('agent');
      expect(newState.messages[0]!.message).toEqual(claudeMsg);
    });

    it('should store assistant message with text content', () => {
      const claudeMsg = createTestAssistantMessage();
      const action: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: claudeMsg, order: 0 },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]!.source).toBe('agent');
      expect(newState.messages[0]!.message).toEqual(claudeMsg);
    });

    it('should not duplicate Claude messages when the same order is received twice', () => {
      const claudeMsg = createTestAssistantMessage();
      const action: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: claudeMsg, order: 42 },
      };

      const once = chatReducer(initialState, action);
      const twice = chatReducer(once, action);

      expect(twice.messages).toHaveLength(1);
      expect(twice.messages[0]!.order).toBe(42);
      expect(twice.messages[0]!.message).toEqual(claudeMsg);
    });

    it('does not derive runtime phase changes from Claude message payloads', () => {
      const state = { ...initialState, sessionStatus: { phase: 'starting' } as const };
      const claudeMsg = createTestAssistantMessage();
      const action: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: claudeMsg, order: 0 },
      };
      const newState = chatReducer(state, action);

      expect(newState.sessionStatus).toEqual({ phase: 'starting' });
    });

    it('does not set sessionStatus from result messages', () => {
      const state = { ...initialState, sessionStatus: { phase: 'running' } as const };
      const resultMsg = createTestResultMessage();
      const action: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: resultMsg, order: 0 },
      };
      const newState = chatReducer(state, action);

      expect(newState.sessionStatus).toEqual({ phase: 'running' });
      expect(newState.messages).toHaveLength(1);
    });

    it('suppresses result message when it duplicates the latest assistant text', () => {
      const assistantMsg = createTestAssistantMessage();
      const assistantAction: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: assistantMsg, order: 0 },
      };
      const withAssistant = chatReducer(initialState, assistantAction);

      const duplicateResult = createTestResultMessage('Hello!');
      const resultAction: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: duplicateResult, order: 1 },
      };
      const withResult = chatReducer(withAssistant, resultAction);

      expect(withResult.messages).toHaveLength(1);
      expect(withResult.messages[0]!.message).toEqual(assistantMsg);
      // Token stats should still update from result messages
      expect(withResult.tokenStats.inputTokens).toBe(100);
      expect(withResult.tokenStats.outputTokens).toBe(50);
    });

    it('suppresses duplicate result even when a queued placeholder is present', () => {
      let state = chatReducer(initialState, {
        type: 'WS_AGENT_MESSAGE',
        payload: {
          message: {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Dup' }] },
          },
          order: 1,
        },
      });
      state = chatReducer(state, {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'queued-1',
          newState: MessageState.ACCEPTED,
          queuePosition: 0,
          userMessage: {
            text: 'next question',
            timestamp: '2026-02-08T00:00:02.000Z',
          },
        },
      });

      const withResult = chatReducer(state, {
        type: 'WS_AGENT_MESSAGE',
        payload: {
          message: createTestResultMessage('Dup'),
          order: 2,
        },
      });

      expect(withResult.messages).toHaveLength(2);
      expect(withResult.messages[0]).toMatchObject({
        source: 'agent',
        message: { type: 'assistant' },
      });
      expect(withResult.messages[1]).toMatchObject({ source: 'user', text: 'next question' });
    });

    it('keeps result message when it differs from latest assistant text', () => {
      const assistantMsg = createTestAssistantMessage();
      const assistantAction: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: assistantMsg, order: 0 },
      };
      const withAssistant = chatReducer(initialState, assistantAction);

      const distinctResult = createTestResultMessage('Different final text');
      const resultAction: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: distinctResult, order: 1 },
      };
      const withResult = chatReducer(withAssistant, resultAction);

      expect(withResult.messages).toHaveLength(2);
      expect(withResult.messages[1]!.message).toEqual(distinctResult);
    });

    it('keeps result message when same text appeared only before latest user turn', () => {
      let state = chatReducer(initialState, {
        type: 'USER_MESSAGE_SENT',
        payload: {
          id: 'u1',
          source: 'user',
          text: 'first',
          timestamp: '2026-02-08T00:00:00.000Z',
          order: 0,
        },
      });
      state = chatReducer(state, {
        type: 'WS_AGENT_MESSAGE',
        payload: {
          message: {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Same answer' }] },
          },
          order: 1,
        },
      });
      state = chatReducer(state, {
        type: 'USER_MESSAGE_SENT',
        payload: {
          id: 'u2',
          source: 'user',
          text: 'second',
          timestamp: '2026-02-08T00:00:01.000Z',
          order: 2,
        },
      });
      state = chatReducer(state, {
        type: 'WS_AGENT_MESSAGE',
        payload: {
          message: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: {} }],
            },
          },
          order: 3,
        },
      });
      const withResult = chatReducer(state, {
        type: 'WS_AGENT_MESSAGE',
        payload: {
          message: createTestResultMessage('Same answer'),
          order: 4,
        },
      });

      expect(withResult.messages).toHaveLength(5);
      expect(withResult.messages[4]!.message).toMatchObject({ type: 'result' });
    });

    it('should store tool_use messages and track index for O(1) updates', () => {
      const toolUseId = 'tool-use-123';
      const toolUseMsg = createTestToolUseMessage(toolUseId);
      const action: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: toolUseMsg, order: 0 },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.toolUseIdToIndex.get(toolUseId)).toBe(0);
    });

    it('should store thinking messages', () => {
      const thinkingMsg = createTestThinkingMessage();
      const action: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: thinkingMsg, order: 0 },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
    });

    it('should store assistant messages with thinking-only content', () => {
      const thinkingAssistantMsg = createTestThinkingAssistantMessage();
      const action: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: thinkingAssistantMsg, order: 0 },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]!.message).toEqual(thinkingAssistantMsg);
    });

    it('should store tool_result messages from user type', () => {
      const toolResultMsg = createTestToolResultMessage('tool-123');
      const action: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: toolResultMsg, order: 0 },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
    });

    it('should not store text_delta stream events', () => {
      const deltaMsg: AgentMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      };
      const action: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: deltaMsg, order: 0 },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(0);
    });

    it('should not store message_start stream events', () => {
      const msgStartEvent: AgentMessage = {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { role: 'assistant', content: [] },
        },
      };
      const action: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: msgStartEvent, order: 0 },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(0);
    });

    it('should not store user messages without tool_result content', () => {
      const userMsg: AgentMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: 'Hello',
        },
      };
      const action: ChatAction = {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: userMsg, order: 0 },
      };
      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(0);
    });

    it('should append thinking_delta to matching thinking block index only', () => {
      let state = chatReducer(initialState, {
        type: 'WS_AGENT_MESSAGE',
        payload: {
          message: {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: 'first' },
            },
          },
          order: 0,
        },
      });
      state = chatReducer(state, {
        type: 'WS_AGENT_MESSAGE',
        payload: {
          message: {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'thinking', thinking: 'second' },
            },
          },
          order: 1,
        },
      });

      state = chatReducer(state, {
        type: 'WS_AGENT_MESSAGE',
        payload: {
          message: {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: '-delta' },
            },
          },
          order: 2,
        },
      });

      const firstEvent = state.messages[0]?.message?.event as
        | { content_block?: { thinking?: string } }
        | undefined;
      const secondEvent = state.messages[1]?.message?.event as
        | { content_block?: { thinking?: string } }
        | undefined;
      expect(firstEvent?.content_block?.thinking).toBe('first-delta');
      expect(secondEvent?.content_block?.thinking).toBe('second');
    });

    it('should append latest thinking from stream events only', () => {
      let state = chatReducer(initialState, {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: createTestThinkingMessage(), order: 0 },
      });

      state = chatReducer(state, {
        type: 'WS_AGENT_MESSAGE',
        payload: {
          message: {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: ' +delta' },
            },
          },
          order: 1,
        },
      });

      const event = state.messages[0]?.message?.event as
        | { content_block?: { thinking?: string } }
        | undefined;
      expect(event?.content_block?.thinking).toBe('Analyzing the problem... +delta');
      expect(state.latestThinking).toBe(' +delta');
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
      expect(newState.messages[0]!.source).toBe('agent');
      expect(newState.messages[0]!.message?.type).toBe('error');
      expect(newState.messages[0]!.message?.error).toBe('Connection failed');
    });
  });

  // -------------------------------------------------------------------------
  // WS_SESSIONS Action
  // -------------------------------------------------------------------------

  describe('WS_SESSIONS action', () => {
    it('should update available sessions list', () => {
      const sessions: SessionInfo[] = [
        {
          providerSessionId: 'session-1',
          createdAt: '2024-01-01T00:00:00.000Z',
          modifiedAt: '2024-01-01T00:00:00.000Z',
          sizeBytes: 1024,
        },
        {
          providerSessionId: 'session-2',
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
  // SESSION_SWITCH_START Action
  // -------------------------------------------------------------------------

  describe('SESSION_SWITCH_START action', () => {
    it('should reset state for session switch', () => {
      const state: ChatState = {
        ...initialState,
        messages: [
          {
            id: 'msg-1',
            source: 'user',
            text: 'Hello',
            timestamp: '2024-01-01T00:00:00.000Z',
            order: 0,
          },
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
            settings: {
              selectedModel: null,
              reasoningEffort: null,
              thinkingEnabled: false,
              planModeEnabled: false,
            },
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
      // Queued messages are preserved during switch to avoid visual disappearance
      expect(newState.queuedMessages.size).toBe(1);
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
      let state = chatReducer(initialState, {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: toolUseMsg, order: 0 },
      });
      expect(state.toolUseIdToIndex.get(toolUseId)).toBe(0);

      // Now update the input
      const updatedInput = { file_path: '/updated/path.txt', content: 'new content' };
      const updateAction: ChatAction = {
        type: 'TOOL_INPUT_UPDATE',
        payload: { toolUseId, input: updatedInput },
      };
      state = chatReducer(state, updateAction);

      // Verify the update
      const updatedMessage = state.messages[0]!;
      const event = updatedMessage.message?.event as { content_block?: { input?: unknown } };
      expect(event?.content_block?.input).toEqual(updatedInput);
    });

    it('should fallback to linear scan if toolUseId not in index', () => {
      const toolUseId = 'tool-use-xyz';
      const toolUseMsg = createTestToolUseMessage(toolUseId);

      // Add tool use message but clear the index
      let state = chatReducer(initialState, {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: toolUseMsg, order: 0 },
      });
      state = { ...state, toolUseIdToIndex: new Map() }; // Clear the index

      // Update should still work via linear scan
      const updatedInput = { command: 'updated command' };
      const updateAction: ChatAction = {
        type: 'TOOL_INPUT_UPDATE',
        payload: { toolUseId, input: updatedInput },
      };
      const newState = chatReducer(state, updateAction);

      // Verify update worked and index was populated
      const event = newState.messages[0]!.message?.event as { content_block?: { input?: unknown } };
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

    it('should recover from stale index when message inserted in middle of array', () => {
      const toolUseId = 'tool-use-xyz';
      const toolUseMsg = createTestToolUseMessage(toolUseId);

      // Add tool use message at index 0
      let state = chatReducer(initialState, {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: toolUseMsg, order: 0 },
      });
      expect(state.toolUseIdToIndex.get(toolUseId)).toBe(0);
      expect(state.messages.length).toBe(1);

      // Simulate a message being inserted at the beginning (e.g., by insertMessageByTimestamp)
      // This shifts our tool use message to index 1, but the cache still says index 0
      const earlierUserMessage: ChatMessage = {
        id: 'earlier-msg',
        source: 'user',
        text: 'Earlier message',
        timestamp: '2020-01-01T00:00:00.000Z', // Very early timestamp
        order: -1, // Earlier order
      };
      state = {
        ...state,
        messages: [earlierUserMessage, ...state.messages],
        // toolUseIdToIndex still points to 0 (stale!)
      };
      expect(state.messages.length).toBe(2);
      expect(state.messages[0]!.id).toBe('earlier-msg');
      expect(state.messages[1]!.source).toBe('agent'); // Tool use is now at index 1

      // Update should still work - it should detect stale index and do linear scan
      const updatedInput = { recovered: 'input' };
      const updateAction: ChatAction = {
        type: 'TOOL_INPUT_UPDATE',
        payload: { toolUseId, input: updatedInput },
      };
      const newState = chatReducer(state, updateAction);

      // Verify update worked
      const toolUseMessage = newState.messages[1]!;
      const event = toolUseMessage.message?.event as { content_block?: { input?: unknown } };
      expect(event?.content_block?.input).toEqual(updatedInput);

      // Verify index was corrected
      expect(newState.toolUseIdToIndex.get(toolUseId)).toBe(1);
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
  // MESSAGE_USED_AS_RESPONSE Action
  // -------------------------------------------------------------------------

  describe('MESSAGE_USED_AS_RESPONSE action', () => {
    it('should add message to chat and clear pending request', () => {
      const state: ChatState = {
        ...initialState,
        pendingRequest: {
          type: 'question',
          request: {
            requestId: 'req-1',
            questions: [{ question: 'Pick one', options: [{ label: 'A', description: '' }] }],
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        },
        pendingMessages: new Map([['msg-1', { text: 'My response' }]]),
      };
      const action: ChatAction = {
        type: 'MESSAGE_USED_AS_RESPONSE',
        payload: { id: 'msg-1', text: 'My response', order: 0 },
      };
      const newState = chatReducer(state, action);

      // Message should be added to chat
      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]!.id).toBe('msg-1');
      expect(newState.messages[0]!.source).toBe('user');
      expect(newState.messages[0]!.text).toBe('My response');

      // Pending request should be cleared
      expect(newState.pendingRequest).toEqual({ type: 'none' });

      // Pending message should be removed
      expect(newState.pendingMessages.has('msg-1')).toBe(false);
    });

    it('should work with permission pending request', () => {
      const state: ChatState = {
        ...initialState,
        pendingRequest: {
          type: 'permission',
          request: {
            requestId: 'req-1',
            toolName: 'ExitPlanMode',
            toolInput: {},
            timestamp: '2024-01-01T00:00:00.000Z',
            planContent: 'Plan content here',
          },
        },
      };
      const action: ChatAction = {
        type: 'MESSAGE_USED_AS_RESPONSE',
        payload: { id: 'msg-1', text: 'Please revise the plan', order: 0 },
      };
      const newState = chatReducer(state, action);

      // Message should be added
      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]!.text).toBe('Please revise the plan');

      // Pending request should be cleared
      expect(newState.pendingRequest).toEqual({ type: 'none' });
    });

    it('should preserve attachments from pending messages', () => {
      const attachments = [
        { id: 'att-1', name: 'test.png', type: 'image/png', size: 1024, data: 'base64data' },
      ];
      const state: ChatState = {
        ...initialState,
        pendingRequest: {
          type: 'question',
          request: {
            requestId: 'req-1',
            questions: [{ question: 'Pick one', options: [{ label: 'A', description: '' }] }],
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        },
        pendingMessages: new Map([['msg-1', { text: 'My response', attachments }]]),
      };
      const action: ChatAction = {
        type: 'MESSAGE_USED_AS_RESPONSE',
        payload: { id: 'msg-1', text: 'My response', order: 0 },
      };
      const newState = chatReducer(state, action);

      // Message should include attachments
      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]!.attachments).toEqual(attachments);
    });

    it('should de-dupe if message already exists (reconnect scenario)', () => {
      const existingMessage: ChatMessage = {
        id: 'msg-1',
        source: 'user',
        text: 'Already in chat',
        timestamp: '2024-01-01T00:00:00.000Z',
        order: 0,
      };
      const state: ChatState = {
        ...initialState,
        messages: [existingMessage],
        pendingRequest: {
          type: 'question',
          request: {
            requestId: 'req-1',
            questions: [{ question: 'Pick one', options: [{ label: 'A', description: '' }] }],
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        },
        pendingMessages: new Map([['msg-1', { text: 'Duplicate' }]]),
      };
      const action: ChatAction = {
        type: 'MESSAGE_USED_AS_RESPONSE',
        payload: { id: 'msg-1', text: 'Duplicate', order: 0 },
      };
      const newState = chatReducer(state, action);

      // Message should NOT be duplicated
      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]!.text).toBe('Already in chat');

      // But pending state should still be cleared
      expect(newState.pendingMessages.has('msg-1')).toBe(false);
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
        order: 0,
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
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
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
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      };
      const state: ChatState = {
        ...initialState,
        queuedMessages: toQueuedMessagesMap([existingMessage]),
      };
      const newMessage: QueuedMessage = {
        id: 'q-2',
        text: 'Second',
        timestamp: '2024-01-01T00:00:01.000Z',
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      };
      const action: ChatAction = { type: 'ADD_TO_QUEUE', payload: newMessage };
      const newState = chatReducer(state, action);

      expect(newState.queuedMessages.size).toBe(2);
      expect(newState.queuedMessages.get(existingMessage.id)).toEqual(existingMessage);
      expect(newState.queuedMessages.get(newMessage.id)).toEqual(newMessage);
    });
  });

  // -------------------------------------------------------------------------
  // Settings Actions
  // -------------------------------------------------------------------------

  describe('UPDATE_SETTINGS action', () => {
    it('should merge partial settings', () => {
      const state: ChatState = {
        ...initialState,
        chatCapabilities: createFullyEnabledCapabilities(),
      };
      const action: ChatAction = {
        type: 'UPDATE_SETTINGS',
        payload: { thinkingEnabled: true },
      };
      const newState = chatReducer(state, action);

      expect(newState.chatSettings.thinkingEnabled).toBe(true);
      expect(newState.chatSettings.selectedModel).toBe(DEFAULT_CHAT_SETTINGS.selectedModel);
      expect(newState.chatSettings.planModeEnabled).toBe(DEFAULT_CHAT_SETTINGS.planModeEnabled);
    });

    it('should update multiple settings at once', () => {
      const state: ChatState = {
        ...initialState,
        chatCapabilities: createFullyEnabledCapabilities(),
      };
      const action: ChatAction = {
        type: 'UPDATE_SETTINGS',
        payload: { selectedModel: 'sonnet', planModeEnabled: true },
      };
      const newState = chatReducer(state, action);

      expect(newState.chatSettings.selectedModel).toBe('sonnet');
      expect(newState.chatSettings.planModeEnabled).toBe(true);
    });
  });

  describe('SET_SETTINGS action', () => {
    it('should replace entire settings object', () => {
      const state: ChatState = {
        ...initialState,
        chatCapabilities: createFullyEnabledCapabilities(),
      };
      const newSettings: ChatSettings = {
        ...DEFAULT_CHAT_SETTINGS,
        selectedModel: 'opus',
        reasoningEffort: 'medium',
        thinkingEnabled: true,
        planModeEnabled: true,
      };
      const action: ChatAction = { type: 'SET_SETTINGS', payload: newSettings };
      const newState = chatReducer(state, action);

      expect(newState.chatSettings).toEqual(newSettings);
    });
  });

  describe('WS_CHAT_CAPABILITIES action', () => {
    it('stores capabilities and clamps unsupported settings', () => {
      const state: ChatState = {
        ...initialState,
        chatSettings: {
          ...DEFAULT_CHAT_SETTINGS,
          selectedModel: 'sonnet',
          thinkingEnabled: true,
          planModeEnabled: true,
        },
        slashCommands: [{ name: '/help', description: 'Help' }],
        slashCommandsLoaded: false,
      };

      const capabilities: ChatBarCapabilities = {
        provider: 'CODEX',
        model: { enabled: false, options: [] },
        reasoning: { enabled: false, options: [] },
        thinking: { enabled: false },
        planMode: { enabled: true },
        attachments: { enabled: false, kinds: [] },
        slashCommands: { enabled: false },
        usageStats: { enabled: false, contextWindow: false },
        rewind: { enabled: false },
      };

      const action: ChatAction = {
        type: 'WS_CHAT_CAPABILITIES',
        payload: { capabilities },
      };
      const newState = chatReducer(state, action);

      expect(newState.chatCapabilities).toEqual(capabilities);
      expect(newState.chatSettings.thinkingEnabled).toBe(false);
      expect(newState.chatSettings.planModeEnabled).toBe(true);
      expect(newState.slashCommands).toEqual([]);
      expect(newState.slashCommandsLoaded).toBe(true);
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
          {
            id: 'msg-1',
            source: 'user',
            text: 'Hello',
            timestamp: '2024-01-01T00:00:00.000Z',
            order: 0,
          },
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
        chatSettings: {
          ...DEFAULT_CHAT_SETTINGS,
          selectedModel: 'sonnet',
          thinkingEnabled: true,
          planModeEnabled: true,
        },
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
          {
            id: 'msg-1',
            source: 'user',
            text: 'Hello',
            timestamp: '2024-01-01T00:00:00.000Z',
            order: 0,
          },
        ],
        sessionStatus: { phase: 'running' } as const,
        gitBranch: 'feature/test',
        chatSettings: {
          ...DEFAULT_CHAT_SETTINGS,
          selectedModel: 'sonnet',
          thinkingEnabled: true,
          planModeEnabled: false,
        },
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'q-1',
            text: 'queued',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: {
              selectedModel: null,
              reasoningEffort: null,
              thinkingEnabled: false,
              planModeEnabled: false,
            },
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
      const unknownAction = unsafeCoerce<ChatAction>({ type: 'UNKNOWN_ACTION' });
      const newState = chatReducer(initialState, unknownAction);

      expect(newState).toBe(initialState);
    });
  });

  // -------------------------------------------------------------------------
  // SESSION_REPLAY_BATCH Action (Message State Machine)
  // -------------------------------------------------------------------------

  describe('SESSION_REPLAY_BATCH action', () => {
    it('should apply replayed events in a single reducer action', () => {
      const action: ChatAction = {
        type: 'SESSION_REPLAY_BATCH',
        payload: {
          replayEvents: [
            {
              type: 'message_state_changed',
              id: 'msg-1',
              newState: MessageState.ACCEPTED,
              userMessage: {
                text: 'Hello',
                timestamp: '2024-01-01T00:00:00.000Z',
                order: 0,
              },
            },
            {
              type: 'session_runtime_updated',
              sessionRuntime: {
                phase: 'running',
                processState: 'alive',
                activity: 'WORKING',
                updatedAt: '2026-02-08T00:00:00.000Z',
              },
            },
          ],
        },
      };

      const newState = chatReducer(initialState, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]!.id).toBe('msg-1');
      expect(newState.sessionStatus).toEqual({ phase: 'running' });
      expect(newState.processStatus).toEqual({ state: 'alive' });
    });

    it('should replay onto a clean transcript to avoid duplicates on reconnect', () => {
      const existingMessage: ChatMessage = {
        id: 'old-msg',
        source: 'agent',
        message: createTestResultMessage(),
        timestamp: '2024-01-01T00:00:00.000Z',
        order: 0,
      };

      const state: ChatState = {
        ...initialState,
        messages: [existingMessage],
      };

      const action: ChatAction = {
        type: 'SESSION_REPLAY_BATCH',
        payload: {
          replayEvents: [
            { type: 'agent_message', data: createTestResultMessage(), order: 0 },
            {
              type: 'session_runtime_updated',
              sessionRuntime: {
                phase: 'running',
                processState: 'alive',
                activity: 'WORKING',
                updatedAt: '2026-02-08T00:00:00.000Z',
              },
            },
          ],
        },
      };

      const newState = chatReducer(state, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]!.id).not.toBe('old-msg');
      expect(newState.sessionStatus).toEqual({ phase: 'running' });
    });

    it('should clear loading state after replay completes if still loading', () => {
      const state: ChatState = {
        ...initialState,
        sessionStatus: { phase: 'loading' },
        sessionRuntime: {
          phase: 'loading',
          processState: 'unknown',
          activity: 'IDLE',
          updatedAt: '2026-02-08T00:00:00.000Z',
        },
      };

      const action: ChatAction = {
        type: 'SESSION_REPLAY_BATCH',
        payload: {
          replayEvents: [
            {
              type: 'message_state_changed',
              id: 'msg-1',
              newState: MessageState.ACCEPTED,
              userMessage: {
                text: 'Hello from history',
                timestamp: '2024-01-01T00:00:00.000Z',
                order: 0,
              },
            },
          ],
        },
      };

      const newState = chatReducer(state, action);

      expect(newState.messages).toHaveLength(1);
      expect(newState.sessionStatus).toEqual({ phase: 'ready' });
      expect(newState.sessionRuntime.phase).toBe('idle');
    });

    it('should not clear loading state if runtime update changes phase during replay', () => {
      const state: ChatState = {
        ...initialState,
        sessionStatus: { phase: 'loading' },
        sessionRuntime: {
          phase: 'loading',
          processState: 'unknown',
          activity: 'IDLE',
          updatedAt: '2026-02-08T00:00:00.000Z',
        },
      };

      const action: ChatAction = {
        type: 'SESSION_REPLAY_BATCH',
        payload: {
          replayEvents: [
            {
              type: 'session_runtime_updated',
              sessionRuntime: {
                phase: 'running',
                processState: 'alive',
                activity: 'WORKING',
                updatedAt: '2026-02-08T00:00:00.000Z',
              },
            },
          ],
        },
      };

      const newState = chatReducer(state, action);

      expect(newState.sessionStatus).toEqual({ phase: 'running' });
      expect(newState.sessionRuntime.phase).toBe('running');
    });
  });

  // -------------------------------------------------------------------------
  // MESSAGE_STATE_CHANGED Action (Message State Machine)
  // -------------------------------------------------------------------------

  describe('MESSAGE_STATE_CHANGED action', () => {
    it('should remove message from queuedMessages when dispatched', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'msg-1',
            text: 'Queued',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: {
              selectedModel: null,
              reasoningEffort: null,
              thinkingEnabled: false,
              planModeEnabled: false,
            },
          },
        ]),
      };

      const action: ChatAction = {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'msg-1',
          newState: MessageState.DISPATCHED,
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.queuedMessages.size).toBe(0);
    });

    it('should recover missing queued message on DISPATCHED when ACCEPTED was missed', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'msg-1',
            text: 'Queued',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: {
              selectedModel: null,
              reasoningEffort: null,
              thinkingEnabled: false,
              planModeEnabled: false,
            },
          },
        ]),
      };

      const action: ChatAction = {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'msg-1',
          newState: MessageState.DISPATCHED,
          userMessage: {
            text: 'Queued',
            timestamp: '2024-01-01T00:00:00.000Z',
            order: 3,
          },
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.queuedMessages.size).toBe(0);
      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]).toMatchObject({
        id: 'msg-1',
        source: 'user',
        text: 'Queued',
        order: 3,
      });
    });

    it('should remove message from queuedMessages when committed', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'msg-1',
            text: 'Queued',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: {
              selectedModel: null,
              reasoningEffort: null,
              thinkingEnabled: false,
              planModeEnabled: false,
            },
          },
        ]),
      };

      const action: ChatAction = {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'msg-1',
          newState: MessageState.COMMITTED,
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.queuedMessages.size).toBe(0);
    });

    it('should recover missing queued message on COMMITTED when dispatch event was missed', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'msg-1',
            text: 'Queued',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: {
              selectedModel: null,
              reasoningEffort: null,
              thinkingEnabled: false,
              planModeEnabled: false,
            },
          },
        ]),
      };

      const action: ChatAction = {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'msg-1',
          newState: MessageState.COMMITTED,
          userMessage: {
            text: 'Queued',
            timestamp: '2024-01-01T00:00:00.000Z',
            order: 3,
          },
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.queuedMessages.size).toBe(0);
      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]).toMatchObject({
        id: 'msg-1',
        source: 'user',
        text: 'Queued',
        order: 3,
      });
    });

    it('should recover message on COMMITTED even when queue entry is already gone', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: new Map(),
        messages: [],
      };

      const action: ChatAction = {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'msg-1',
          newState: MessageState.COMMITTED,
          userMessage: {
            text: 'Recovered',
            timestamp: '2024-01-01T00:00:00.000Z',
            order: 5,
          },
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.queuedMessages.size).toBe(0);
      expect(newState.messages).toHaveLength(1);
      expect(newState.messages[0]).toMatchObject({
        id: 'msg-1',
        source: 'user',
        text: 'Recovered',
        order: 5,
      });
    });

    it('should remove message from queuedMessages when complete', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'msg-1',
            text: 'Queued',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: {
              selectedModel: null,
              reasoningEffort: null,
              thinkingEnabled: false,
              planModeEnabled: false,
            },
          },
        ]),
      };

      const action: ChatAction = {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'msg-1',
          newState: MessageState.COMPLETE,
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.queuedMessages.size).toBe(0);
    });

    it('should handle state change for non-existent message gracefully', () => {
      const action: ChatAction = {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'nonexistent',
          newState: MessageState.DISPATCHED,
        },
      };
      const newState = chatReducer(initialState, action);

      // Should return equivalent state without errors (may not be same reference)
      expect(newState).toStrictEqual(initialState);
    });

    it('should handle ACCEPTED state with queue position', () => {
      const state: ChatState = {
        ...initialState,
        queuedMessages: toQueuedMessagesMap([
          {
            id: 'msg-1',
            text: 'Queued',
            timestamp: '2024-01-01T00:00:00.000Z',
            settings: {
              selectedModel: null,
              reasoningEffort: null,
              thinkingEnabled: false,
              planModeEnabled: false,
            },
          },
        ]),
      };

      const action: ChatAction = {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'msg-1',
          newState: MessageState.ACCEPTED,
          queuePosition: 2,
        },
      };
      const newState = chatReducer(state, action);

      // Message should still be in queue
      expect(newState.queuedMessages.size).toBe(1);
      expect(newState.queuedMessages.has('msg-1')).toBe(true);
    });

    it('should insert ACCEPTED messages in order by backend-assigned order', () => {
      // Start with a message that has a higher order
      const laterMessage: ChatMessage = {
        id: 'later-msg',
        source: 'user',
        text: 'Later message',
        timestamp: '2024-01-01T12:00:00.000Z',
        order: 1,
      };
      const state: ChatState = {
        ...initialState,
        messages: [laterMessage],
      };

      // Add an earlier message (lower order) via MESSAGE_STATE_CHANGED ACCEPTED
      const action: ChatAction = {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'earlier-msg',
          newState: MessageState.ACCEPTED,
          userMessage: {
            text: 'Earlier message',
            timestamp: '2024-01-01T06:00:00.000Z',
            order: 0, // Lower order should sort before higher order
          },
        },
      };
      const newState = chatReducer(state, action);

      // Earlier message should be inserted before the later one due to lower order
      expect(newState.messages.length).toBe(2);
      expect(newState.messages[0]!.id).toBe('earlier-msg');
      expect(newState.messages[1]!.id).toBe('later-msg');
    });

    it('should insert ACCEPTED messages at end when they have highest order', () => {
      // Start with an earlier message (lower order)
      const earlierMessage: ChatMessage = {
        id: 'earlier-msg',
        source: 'user',
        text: 'Earlier message',
        timestamp: '2024-01-01T06:00:00.000Z',
        order: 0,
      };
      const state: ChatState = {
        ...initialState,
        messages: [earlierMessage],
      };

      // Add a later message (higher order) via MESSAGE_STATE_CHANGED ACCEPTED
      const action: ChatAction = {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'later-msg',
          newState: MessageState.ACCEPTED,
          userMessage: {
            text: 'Later message',
            timestamp: '2024-01-01T12:00:00.000Z',
            order: 1, // Higher order should sort after
          },
        },
      };
      const newState = chatReducer(state, action);

      // Later message should be at the end due to higher order
      expect(newState.messages.length).toBe(2);
      expect(newState.messages[0]!.id).toBe('earlier-msg');
      expect(newState.messages[1]!.id).toBe('later-msg');
    });

    it('should maintain correct order when multiple messages arrive out of order', () => {
      const state: ChatState = {
        ...initialState,
        messages: [],
      };

      // Simulate messages arriving out of order (e.g., due to network timing)
      // Message 3 (order: 2) arrives first
      let newState = chatReducer(state, {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'msg-3',
          newState: MessageState.ACCEPTED,
          userMessage: { text: 'Third', timestamp: '2024-01-01T15:00:00.000Z', order: 2 },
        },
      });

      // Message 1 (order: 0) arrives second
      newState = chatReducer(newState, {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'msg-1',
          newState: MessageState.ACCEPTED,
          userMessage: { text: 'First', timestamp: '2024-01-01T09:00:00.000Z', order: 0 },
        },
      });

      // Message 2 (order: 1) arrives third
      newState = chatReducer(newState, {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'msg-2',
          newState: MessageState.ACCEPTED,
          userMessage: { text: 'Second', timestamp: '2024-01-01T12:00:00.000Z', order: 1 },
        },
      });

      // All messages should be sorted by backend-assigned order
      expect(newState.messages.length).toBe(3);
      expect(newState.messages[0]!.id).toBe('msg-1'); // order: 0
      expect(newState.messages[1]!.id).toBe('msg-2'); // order: 1
      expect(newState.messages[2]!.id).toBe('msg-3'); // order: 2
    });

    it('should insert messages in order even when arriving out of sequence', () => {
      // Start with a message at order 1
      const existingMessage: ChatMessage = {
        id: 'msg-1',
        source: 'user',
        text: 'First message',
        timestamp: '2024-01-01T10:00:00.000Z',
        order: 1,
      };
      const state: ChatState = {
        ...initialState,
        messages: [existingMessage],
      };

      // Add an earlier message (order: 0) that arrives later
      const action: ChatAction = {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'msg-0',
          newState: MessageState.ACCEPTED,
          userMessage: {
            text: 'Earlier message',
            timestamp: '2024-01-01T09:00:00.000Z',
            order: 0,
          },
        },
      };
      const newState = chatReducer(state, action);

      // Messages should be sorted by order
      expect(newState.messages.length).toBe(2);
      expect(newState.messages[0]!.id).toBe('msg-0'); // order: 0
      expect(newState.messages[1]!.id).toBe('msg-1'); // order: 1
    });

    it('should still apply ACCEPTED transition when first pending UUID is empty', () => {
      const state: ChatState = {
        ...initialState,
        pendingUserMessageUuids: [''],
      };

      const action: ChatAction = {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'msg-empty-uuid',
          newState: MessageState.ACCEPTED,
          userMessage: {
            text: 'Message should still be accepted',
            timestamp: '2024-01-01T12:00:00.000Z',
            order: 1,
          },
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.messages.some((message) => message.id === 'msg-empty-uuid')).toBe(true);
      expect(newState.queuedMessages.has('msg-empty-uuid')).toBe(true);
      expect(newState.pendingUserMessageUuids).toEqual([]);
      expect(newState.messageIdToUuid.has('msg-empty-uuid')).toBe(false);
    });
  });
});

// =============================================================================
// createActionFromWebSocketMessage Tests
// =============================================================================

describe('createActionFromWebSocketMessage', () => {
  it('returns null for unknown legacy status-like message', () => {
    const wsMessage = unsafeCoerce<WebSocketMessage>({ type: 'status' });
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('returns null for unknown legacy lifecycle-like messages', () => {
    const wsMessage = unsafeCoerce<WebSocketMessage>({ type: 'starting' });
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should convert agent_message to WS_AGENT_MESSAGE action', () => {
    const claudeMsg: AgentMessage = {
      type: 'assistant',
      message: { role: 'assistant', content: 'Hello!' },
    };
    const wsMessage: WebSocketMessage = { type: 'agent_message', data: claudeMsg, order: 5 };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({
      type: 'WS_AGENT_MESSAGE',
      payload: { message: claudeMsg, order: 5 },
    });
  });

  it('should return null for agent_message without data', () => {
    const wsMessage = unsafeCoerce<WebSocketMessage>({ type: 'agent_message' });
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should convert error message to WS_ERROR action', () => {
    const wsMessage: WebSocketMessage = { type: 'error', message: 'Connection lost' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({ type: 'WS_ERROR', payload: { message: 'Connection lost' } });
  });

  it('should return null for error message without message field', () => {
    const wsMessage = unsafeCoerce<WebSocketMessage>({ type: 'error' });
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should convert sessions message to WS_SESSIONS action', () => {
    const sessions: SessionInfo[] = [
      {
        providerSessionId: 'session-1',
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
    const wsMessage = unsafeCoerce<WebSocketMessage>({ type: 'sessions' });
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should convert config_options_update to CONFIG_OPTIONS_UPDATE action', () => {
    const wsMessage: WebSocketMessage = {
      type: 'config_options_update',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'string',
          category: 'model',
          currentValue: 'sonnet',
          options: [{ value: 'sonnet', name: 'Sonnet' }],
        },
      ],
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({
      type: 'CONFIG_OPTIONS_UPDATE',
      payload: {
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'string',
            category: 'model',
            currentValue: 'sonnet',
            options: [{ value: 'sonnet', name: 'Sonnet' }],
          },
        ],
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
    const acpOptions = [
      { optionId: 'opt-1', name: 'file1.txt', kind: 'allow_once' as const },
      { optionId: 'opt-2', name: 'Cancel', kind: 'reject_once' as const },
    ];
    const wsMessage: WebSocketMessage = {
      type: 'user_question',
      requestId: 'req-456',
      toolName: 'ExitPlanMode',
      questions,
      acpOptions,
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action?.type).toBe('WS_USER_QUESTION');
    expect((action as { payload: UserQuestionRequest }).payload.requestId).toBe('req-456');
    expect((action as { payload: UserQuestionRequest }).payload.toolName).toBe('ExitPlanMode');
    expect((action as { payload: UserQuestionRequest }).payload.questions).toEqual(questions);
    expect((action as { payload: UserQuestionRequest }).payload.acpOptions).toEqual(acpOptions);
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

  it('should return null for unknown message type', () => {
    const wsMessage = unsafeCoerce<WebSocketMessage>({ type: 'unknown_type' });
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should convert message_used_as_response to MESSAGE_USED_AS_RESPONSE action', () => {
    const wsMessage: WebSocketMessage = {
      type: 'message_used_as_response',
      id: 'msg-1',
      text: 'My custom response',
      order: 5,
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({
      type: 'MESSAGE_USED_AS_RESPONSE',
      payload: { id: 'msg-1', text: 'My custom response', order: 5 },
    });
  });

  it('should return null for message_used_as_response without id', () => {
    const wsMessage: WebSocketMessage = {
      type: 'message_used_as_response',
      text: 'My custom response',
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should return null for message_used_as_response without text', () => {
    const wsMessage: WebSocketMessage = { type: 'message_used_as_response', id: 'msg-1' };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Message State Machine Events
  // -------------------------------------------------------------------------

  it('should convert session_replay_batch to SESSION_REPLAY_BATCH action', () => {
    const wsMessage: WebSocketMessage = {
      type: 'session_replay_batch',
      replayEvents: [{ type: 'error', message: 'legacy replay event' }],
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({
      type: 'SESSION_REPLAY_BATCH',
      payload: {
        replayEvents: [{ type: 'error', message: 'legacy replay event' }],
      },
    });
  });

  it('should convert message_state_changed to MESSAGE_STATE_CHANGED action', () => {
    const wsMessage: WebSocketMessage = {
      type: 'message_state_changed',
      id: 'msg-1',
      newState: MessageState.DISPATCHED,
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({
      type: 'MESSAGE_STATE_CHANGED',
      payload: {
        id: 'msg-1',
        newState: MessageState.DISPATCHED,
        queuePosition: undefined,
        errorMessage: undefined,
      },
    });
  });

  it('should include queuePosition and errorMessage in MESSAGE_STATE_CHANGED', () => {
    const wsMessage: WebSocketMessage = {
      type: 'message_state_changed',
      id: 'msg-1',
      newState: MessageState.REJECTED,
      queuePosition: 3,
      errorMessage: 'Queue full',
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toEqual({
      type: 'MESSAGE_STATE_CHANGED',
      payload: {
        id: 'msg-1',
        newState: MessageState.REJECTED,
        queuePosition: 3,
        errorMessage: 'Queue full',
      },
    });
  });

  it('should return null for message_state_changed without id', () => {
    const wsMessage: WebSocketMessage = {
      type: 'message_state_changed',
      newState: MessageState.DISPATCHED,
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });

  it('should return null for message_state_changed without newState', () => {
    const wsMessage: WebSocketMessage = {
      type: 'message_state_changed',
      id: 'msg-1',
    };
    const action = createActionFromWebSocketMessage(wsMessage);

    expect(action).toBeNull();
  });
});

// =============================================================================
// Action Creator Tests
// =============================================================================

describe('createUserMessageAction', () => {
  it('should create USER_MESSAGE_SENT action with generated id', () => {
    const action = createUserMessageAction('Hello, Claude!', 0);

    expect(action.type).toBe('USER_MESSAGE_SENT');
    // Type guard: action is USER_MESSAGE_SENT type with ChatMessage payload
    if (action.type === 'USER_MESSAGE_SENT') {
      expect(action.payload.source).toBe('user');
      expect(action.payload.text).toBe('Hello, Claude!');
      expect(action.payload.id).toMatch(/^msg-\d+-\w+$/);
      expect(action.payload.timestamp).toBeDefined();
      expect(action.payload.order).toBe(0);
    }
  });

  it('should create unique ids for different calls', () => {
    const action1 = createUserMessageAction('First', 0);
    const action2 = createUserMessageAction('Second', 1);

    // Type guard: action is USER_MESSAGE_SENT type with ChatMessage payload
    if (action1.type === 'USER_MESSAGE_SENT' && action2.type === 'USER_MESSAGE_SENT') {
      expect(action1.payload.id).not.toBe(action2.payload.id);
    }
  });
});

// Note: createQueueMessageAction has been removed.
// Queue is now managed on the backend and MESSAGE_QUEUED/MESSAGE_DISPATCHED/MESSAGE_REMOVED
// actions are received from WebSocket events.

// =============================================================================
// SDK Event Tests
// =============================================================================

describe('SDK Compaction Actions', () => {
  it('should set isCompacting to true on SDK_COMPACTING_START', () => {
    const state = createInitialChatState({ isCompacting: false });
    const action: ChatAction = { type: 'SDK_COMPACTING_START' };

    const newState = chatReducer(state, action);

    expect(newState.isCompacting).toBe(true);
  });

  it('should set isCompacting to false on SDK_COMPACTING_END', () => {
    const state = createInitialChatState({ isCompacting: true });
    const action: ChatAction = { type: 'SDK_COMPACTING_END' };

    const newState = chatReducer(state, action);

    expect(newState.isCompacting).toBe(false);
  });

  it('should reset isCompacting on stopped runtime update', () => {
    const state = createInitialChatState({
      isCompacting: true,
      sessionStatus: { phase: 'running' },
    });
    const action: ChatAction = {
      type: 'SESSION_RUNTIME_UPDATED',
      payload: {
        sessionRuntime: {
          phase: 'idle',
          processState: 'stopped',
          activity: 'IDLE',
          updatedAt: '2026-02-08T00:00:00.000Z',
        },
      },
    };

    const newState = chatReducer(state, action);

    expect(newState.isCompacting).toBe(false);
    expect(newState.sessionStatus).toEqual({ phase: 'ready' });
  });
});

describe('SDK Task Notification Actions', () => {
  it('should append notification on SDK_TASK_NOTIFICATION', () => {
    const state = createInitialChatState({ taskNotifications: [] });
    const action: ChatAction = {
      type: 'SDK_TASK_NOTIFICATION',
      payload: { message: 'Task started' },
    };

    const newState = chatReducer(state, action);

    expect(newState.taskNotifications).toHaveLength(1);
    expect(newState.taskNotifications[0]!.message).toBe('Task started');
    expect(newState.taskNotifications[0]!.id).toBeDefined();
    expect(newState.taskNotifications[0]!.timestamp).toBeDefined();
  });

  it('should generate unique UUIDs for notifications', () => {
    const state = createInitialChatState({ taskNotifications: [] });
    const action1: ChatAction = {
      type: 'SDK_TASK_NOTIFICATION',
      payload: { message: 'Task 1' },
    };
    const action2: ChatAction = {
      type: 'SDK_TASK_NOTIFICATION',
      payload: { message: 'Task 2' },
    };

    const state1 = chatReducer(state, action1);
    const state2 = chatReducer(state1, action2);

    expect(state2.taskNotifications).toHaveLength(2);
    expect(state2.taskNotifications[0]!.id).not.toBe(state2.taskNotifications[1]!.id);
    // UUID format check
    expect(state2.taskNotifications[0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it('should dismiss specific notification on DISMISS_TASK_NOTIFICATION', () => {
    const existingNotifications = [
      { id: 'notif-1', message: 'Task 1', timestamp: '2024-01-01T00:00:00Z' },
      { id: 'notif-2', message: 'Task 2', timestamp: '2024-01-01T00:00:01Z' },
      { id: 'notif-3', message: 'Task 3', timestamp: '2024-01-01T00:00:02Z' },
    ];
    const state = createInitialChatState({ taskNotifications: existingNotifications });
    const action: ChatAction = {
      type: 'DISMISS_TASK_NOTIFICATION',
      payload: { id: 'notif-2' },
    };

    const newState = chatReducer(state, action);

    expect(newState.taskNotifications).toHaveLength(2);
    expect(newState.taskNotifications.map((n) => n.id)).toEqual(['notif-1', 'notif-3']);
  });

  it('should clear all notifications on CLEAR_TASK_NOTIFICATIONS', () => {
    const existingNotifications = [
      { id: 'notif-1', message: 'Task 1', timestamp: '2024-01-01T00:00:00Z' },
      { id: 'notif-2', message: 'Task 2', timestamp: '2024-01-01T00:00:01Z' },
    ];
    const state = createInitialChatState({ taskNotifications: existingNotifications });
    const action: ChatAction = { type: 'CLEAR_TASK_NOTIFICATIONS' };

    const newState = chatReducer(state, action);

    expect(newState.taskNotifications).toHaveLength(0);
  });

  it('should reset taskNotifications on session switch', () => {
    const existingNotifications = [
      { id: 'notif-1', message: 'Task 1', timestamp: '2024-01-01T00:00:00Z' },
    ];
    const state = createInitialChatState({ taskNotifications: existingNotifications });
    const action: ChatAction = { type: 'SESSION_SWITCH_START' };

    const newState = chatReducer(state, action);

    expect(newState.taskNotifications).toHaveLength(0);
  });
});

describe('SDK Status Update Actions', () => {
  it('should update permissionMode on SDK_STATUS_UPDATE', () => {
    const state = createInitialChatState({ permissionMode: null });
    const action: ChatAction = {
      type: 'SDK_STATUS_UPDATE',
      payload: { permissionMode: 'acceptEdits' },
    };

    const newState = chatReducer(state, action);

    expect(newState.permissionMode).toBe('acceptEdits');
  });

  it('should preserve existing permissionMode when payload is undefined', () => {
    const state = createInitialChatState({ permissionMode: 'plan' });
    const action: ChatAction = {
      type: 'SDK_STATUS_UPDATE',
      payload: {},
    };

    const newState = chatReducer(state, action);

    expect(newState.permissionMode).toBe('plan');
  });

  it('should reset permissionMode on session switch', () => {
    const state = createInitialChatState({ permissionMode: 'acceptEdits' });
    const action: ChatAction = { type: 'SESSION_SWITCH_START' };

    const newState = chatReducer(state, action);

    expect(newState.permissionMode).toBeNull();
  });
});

describe('createActionFromWebSocketMessage - SDK Events', () => {
  it('should create SDK_COMPACTING_START action for compacting_start message', () => {
    const message: WebSocketMessage = { type: 'compacting_start' };
    const action = createActionFromWebSocketMessage(message);

    expect(action).toEqual({ type: 'SDK_COMPACTING_START' });
  });

  it('should create SDK_COMPACTING_END action for compacting_end message', () => {
    const message: WebSocketMessage = { type: 'compacting_end' };
    const action = createActionFromWebSocketMessage(message);

    expect(action).toEqual({ type: 'SDK_COMPACTING_END' });
  });

  it('should create SDK_TASK_NOTIFICATION action for task_notification message', () => {
    const message: WebSocketMessage = {
      type: 'task_notification',
      message: 'Agent started task',
    };
    const action = createActionFromWebSocketMessage(message);

    expect(action).toEqual({
      type: 'SDK_TASK_NOTIFICATION',
      payload: { message: 'Agent started task' },
    });
  });

  it('should return null for task_notification without message', () => {
    const message: WebSocketMessage = { type: 'task_notification' };
    const action = createActionFromWebSocketMessage(message);

    expect(action).toBeNull();
  });
});

// =============================================================================
// Token Stats Accumulation Tests
// =============================================================================

describe('Token Stats Accumulation', () => {
  let initialState: ChatState;

  beforeEach(() => {
    initialState = createInitialChatState();
  });

  it('should initialize with empty token stats', () => {
    expect(initialState.tokenStats).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      totalDurationApiMs: 0,
      turnCount: 0,
      webSearchRequests: 0,
      contextWindow: null,
      maxOutputTokens: null,
      serviceTier: null,
    });
  });

  it('should accumulate token stats from result messages', () => {
    const state = { ...initialState, sessionStatus: { phase: 'running' } as const };

    const resultMsg: AgentMessage = {
      type: 'result',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
        service_tier: 'scale',
      },
      duration_ms: 2000,
      duration_api_ms: 1500,
      total_cost_usd: 0.05,
      num_turns: 1,
    };

    const action: ChatAction = {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: resultMsg, order: 0 },
    };
    const newState = chatReducer(state, action);

    expect(newState.tokenStats.inputTokens).toBe(1000);
    expect(newState.tokenStats.outputTokens).toBe(500);
    expect(newState.tokenStats.cacheReadInputTokens).toBe(200);
    expect(newState.tokenStats.cacheCreationInputTokens).toBe(100);
    expect(newState.tokenStats.totalDurationMs).toBe(2000);
    expect(newState.tokenStats.totalDurationApiMs).toBe(1500);
    expect(newState.tokenStats.totalCostUsd).toBe(0.05);
    expect(newState.tokenStats.turnCount).toBe(1);
    expect(newState.tokenStats.serviceTier).toBe('scale');
  });

  it('should accumulate stats across multiple result messages', () => {
    let state: ChatState = { ...initialState, sessionStatus: { phase: 'running' } as const };

    // First result
    const resultMsg1: AgentMessage = {
      type: 'result',
      usage: { input_tokens: 1000, output_tokens: 500 },
      duration_ms: 2000,
      total_cost_usd: 0.05,
      num_turns: 1,
    };
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: resultMsg1, order: 0 },
    });

    // Second result
    const resultMsg2: AgentMessage = {
      type: 'result',
      usage: { input_tokens: 2000, output_tokens: 1000 },
      duration_ms: 3000,
      total_cost_usd: 0.12,
      num_turns: 2,
    };
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: resultMsg2, order: 1 },
    });

    // Tokens should accumulate
    expect(state.tokenStats.inputTokens).toBe(3000);
    expect(state.tokenStats.outputTokens).toBe(1500);
    expect(state.tokenStats.totalDurationMs).toBe(5000);
    // Cost and turn count take latest value
    expect(state.tokenStats.totalCostUsd).toBe(0.12);
    expect(state.tokenStats.turnCount).toBe(2);
  });

  it('should extract context window from model_usage', () => {
    const state = { ...initialState, sessionStatus: { phase: 'running' } as const };

    const resultMsg: AgentMessage = {
      type: 'result',
      usage: { input_tokens: 1000, output_tokens: 500 },
      duration_ms: 2000,
      total_cost_usd: 0.05,
      num_turns: 1,
      model_usage: {
        'claude-3-opus': {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.05,
          contextWindow: 200_000,
          maxOutputTokens: 16_384,
        },
      },
    };

    const action: ChatAction = {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: resultMsg, order: 0 },
    };
    const newState = chatReducer(state, action);

    expect(newState.tokenStats.contextWindow).toBe(200_000);
    expect(newState.tokenStats.maxOutputTokens).toBe(16_384);
  });

  it('should not update token stats for non-result messages', () => {
    const state = { ...initialState, sessionStatus: { phase: 'running' } as const };

    const assistantMsg: AgentMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
      },
    };

    const action: ChatAction = {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: assistantMsg, order: 0 },
    };
    const newState = chatReducer(state, action);

    expect(newState.tokenStats.inputTokens).toBe(0);
    expect(newState.tokenStats.outputTokens).toBe(0);
  });

  it('should reset token stats on session switch', () => {
    // Set up state with existing stats
    const state: ChatState = {
      ...initialState,
      tokenStats: {
        inputTokens: 5000,
        outputTokens: 2000,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 500,
        totalCostUsd: 0.25,
        totalDurationMs: 10_000,
        totalDurationApiMs: 8000,
        turnCount: 5,
        webSearchRequests: 2,
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        serviceTier: 'scale',
      },
    };

    const action: ChatAction = { type: 'SESSION_SWITCH_START' };
    const newState = chatReducer(state, action);

    expect(newState.tokenStats).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      totalDurationApiMs: 0,
      turnCount: 0,
      webSearchRequests: 0,
      contextWindow: null,
      maxOutputTokens: null,
      serviceTier: null,
    });
  });

  it('should reset token stats on clear chat', () => {
    const state: ChatState = {
      ...initialState,
      tokenStats: {
        inputTokens: 5000,
        outputTokens: 2000,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 500,
        totalCostUsd: 0.25,
        totalDurationMs: 10_000,
        totalDurationApiMs: 8000,
        turnCount: 5,
        webSearchRequests: 2,
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        serviceTier: 'scale',
      },
    };

    const action: ChatAction = { type: 'CLEAR_CHAT' };
    const newState = chatReducer(state, action);

    expect(newState.tokenStats.inputTokens).toBe(0);
    expect(newState.tokenStats.outputTokens).toBe(0);
    expect(newState.tokenStats.contextWindow).toBeNull();
  });

  describe('reducer slices', () => {
    it('updates sessionStatus without touching messages for runtime updates', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        source: 'user',
        text: 'hello',
        timestamp: new Date().toISOString(),
        order: 1,
      };
      const state = createInitialChatState({
        messages: [message],
        sessionStatus: { phase: 'ready' },
      });

      const action: ChatAction = {
        type: 'SESSION_RUNTIME_UPDATED',
        payload: {
          sessionRuntime: {
            phase: 'running',
            processState: 'alive',
            activity: 'WORKING',
            updatedAt: '2026-02-08T00:00:00.000Z',
          },
        },
      };
      const newState = chatReducer(state, action);

      expect(newState.sessionStatus.phase).toBe('running');
      expect(newState.messages).toEqual([message]);
    });

    it('merges settings updates', () => {
      const state = createInitialChatState({
        chatSettings: {
          ...DEFAULT_CHAT_SETTINGS,
          selectedModel: 'opus',
          thinkingEnabled: false,
          planModeEnabled: false,
        },
        chatCapabilities: createFullyEnabledCapabilities(),
      });
      const action: ChatAction = {
        type: 'UPDATE_SETTINGS',
        payload: { planModeEnabled: true },
      };
      const newState = chatReducer(state, action);

      expect(newState.chatSettings.planModeEnabled).toBe(true);
      expect(newState.chatSettings.selectedModel).toBe('opus');
    });

    it('records tool progress updates', () => {
      const state = createInitialChatState();
      const action: ChatAction = {
        type: 'SDK_TOOL_PROGRESS',
        payload: { toolUseId: 'tool-1', toolName: 'TestTool', elapsedSeconds: 5 },
      };
      const newState = chatReducer(state, action);

      expect(newState.toolProgress.get('tool-1')).toEqual({
        toolName: 'TestTool',
        elapsedSeconds: 5,
      });
    });

    it('sets rewind preview state', () => {
      const state = createInitialChatState();
      const action: ChatAction = {
        type: 'REWIND_PREVIEW_START',
        payload: { userMessageId: 'msg-1', requestNonce: 'nonce-1' },
      };
      const newState = chatReducer(state, action);

      expect(newState.rewindPreview).toEqual({
        userMessageId: 'msg-1',
        requestNonce: 'nonce-1',
        isLoading: true,
      });
    });

    it('adds interactive response message and clears pending request', () => {
      const state = createInitialChatState({
        pendingRequest: {
          type: 'question',
          request: {
            requestId: 'req-1',
            questions: [],
            timestamp: new Date().toISOString(),
          },
        },
        pendingMessages: new Map([['msg-1', { text: 'hi' }]]),
      });

      const action: ChatAction = {
        type: 'MESSAGE_USED_AS_RESPONSE',
        payload: { id: 'msg-1', text: 'hi', order: 1 },
      };
      const newState = chatReducer(state, action);

      expect(newState.pendingRequest).toEqual({ type: 'none' });
      expect(newState.messages[0]?.id).toBe('msg-1');
    });
  });
});
