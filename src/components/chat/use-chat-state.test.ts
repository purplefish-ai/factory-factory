/**
 * Tests for the useChatState hook.
 *
 * These tests verify the chat state management logic including:
 * - Queue draining behavior (when agent becomes idle)
 * - Message queueing and persistence
 * - Session switching effects on queue
 * - sendMessage behavior
 *
 * Note: Testing React hooks with useReducer requires @testing-library/react-hooks
 * or similar. Since this project doesn't have that setup, we test the core logic
 * patterns instead, similar to use-websocket-transport.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSettings, QueuedMessage } from '@/lib/claude-types';
import { DEFAULT_CHAT_SETTINGS, THINKING_SUFFIX } from '@/lib/claude-types';
import type { ChatState } from './chat-reducer';
import { chatReducer, createInitialChatState } from './chat-reducer';

// =============================================================================
// Mock Storage
// =============================================================================

const mockStorage = new Map<string, string>();

const mockSessionStorage = {
  getItem: vi.fn((key: string) => mockStorage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => mockStorage.set(key, value)),
  removeItem: vi.fn((key: string) => mockStorage.delete(key)),
};

beforeEach(() => {
  mockStorage.clear();
  vi.stubGlobal('sessionStorage', mockSessionStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// =============================================================================
// Helper Functions (mirroring use-chat-state.ts logic)
// =============================================================================

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createQueuedMessage(text: string): QueuedMessage {
  return {
    id: generateMessageId(),
    text: text.trim(),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Simulates the drainQueue logic from use-chat-state.ts.
 * Returns the actions that would be dispatched and messages that would be sent.
 */
interface DrainQueueResult {
  shouldDrain: boolean;
  actions: Array<{ type: string; payload?: unknown }>;
  sentMessages: Array<{ type: string; [key: string]: unknown }>;
  persistedQueue: QueuedMessage[] | null;
  clearedDraft: boolean;
}

function simulateDrainQueue(state: ChatState, _sessionId: string | null): DrainQueueResult {
  const { running, startingSession, queuedMessages, chatSettings } = state;

  // Check if we should drain
  if (running || startingSession || queuedMessages.length === 0) {
    return {
      shouldDrain: false,
      actions: [],
      sentMessages: [],
      persistedQueue: null,
      clearedDraft: false,
    };
  }

  const [nextMsg, ...remaining] = queuedMessages;
  const actions: Array<{ type: string; payload?: unknown }> = [];
  const sentMessages: Array<{ type: string; [key: string]: unknown }> = [];

  // Update queue in state
  actions.push({ type: 'SET_QUEUE', payload: remaining });

  // Add user message (optimistic UI)
  actions.push({
    type: 'USER_MESSAGE_SENT',
    payload: {
      id: expect.any(String),
      source: 'user',
      text: nextMsg.text,
      timestamp: expect.any(String),
    },
  });

  // Start Claude
  actions.push({ type: 'WS_STARTING' });

  // Send start message
  sentMessages.push({
    type: 'start',
    selectedModel: chatSettings.selectedModel,
    thinkingEnabled: chatSettings.thinkingEnabled,
    planModeEnabled: chatSettings.planModeEnabled,
  });

  // Send user input (with thinking suffix if enabled)
  const messageText = chatSettings.thinkingEnabled
    ? `${nextMsg.text}${THINKING_SUFFIX}`
    : nextMsg.text;
  sentMessages.push({ type: 'user_input', text: messageText });

  return {
    shouldDrain: true,
    actions,
    sentMessages,
    persistedQueue: remaining,
    clearedDraft: true,
  };
}

/**
 * Simulates the idle detection logic from use-chat-state.ts useEffect.
 */
function shouldDrainOnStateChange(
  prevRunning: boolean,
  running: boolean,
  startingSession: boolean,
  queueLength: number
): boolean {
  const wasRunning = prevRunning;
  const isNowIdle = !(running || startingSession);
  const becameIdle = wasRunning && isNowIdle;
  const hasQueuedMessages = queueLength > 0;

  return (becameIdle || isNowIdle) && hasQueuedMessages;
}

// =============================================================================
// Queue Draining Logic Tests
// =============================================================================

describe('queue draining conditions', () => {
  it('should NOT drain when running is true', () => {
    const state = createInitialChatState({
      running: true,
      startingSession: false,
      queuedMessages: [createQueuedMessage('Hello')],
    });

    const result = simulateDrainQueue(state, 'session-123');

    expect(result.shouldDrain).toBe(false);
    expect(result.actions).toHaveLength(0);
    expect(result.sentMessages).toHaveLength(0);
  });

  it('should NOT drain when startingSession is true', () => {
    const state = createInitialChatState({
      running: false,
      startingSession: true,
      queuedMessages: [createQueuedMessage('Hello')],
    });

    const result = simulateDrainQueue(state, 'session-123');

    expect(result.shouldDrain).toBe(false);
    expect(result.actions).toHaveLength(0);
    expect(result.sentMessages).toHaveLength(0);
  });

  it('should NOT drain when queue is empty', () => {
    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [],
    });

    const result = simulateDrainQueue(state, 'session-123');

    expect(result.shouldDrain).toBe(false);
  });

  it('should drain when idle and queue has messages', () => {
    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [createQueuedMessage('Hello')],
    });

    const result = simulateDrainQueue(state, 'session-123');

    expect(result.shouldDrain).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.sentMessages.length).toBeGreaterThan(0);
  });

  it('should drain when both running and startingSession are false', () => {
    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [createQueuedMessage('First'), createQueuedMessage('Second')],
    });

    const result = simulateDrainQueue(state, 'session-123');

    expect(result.shouldDrain).toBe(true);
  });
});

describe('queue draining idle detection', () => {
  it('should drain when becoming idle (was running, now not)', () => {
    const prevRunning = true;
    const running = false;
    const startingSession = false;
    const queueLength = 1;

    const shouldDrain = shouldDrainOnStateChange(
      prevRunning,
      running,
      startingSession,
      queueLength
    );

    expect(shouldDrain).toBe(true);
  });

  it('should drain when already idle and has messages', () => {
    const prevRunning = false;
    const running = false;
    const startingSession = false;
    const queueLength = 1;

    const shouldDrain = shouldDrainOnStateChange(
      prevRunning,
      running,
      startingSession,
      queueLength
    );

    expect(shouldDrain).toBe(true);
  });

  it('should NOT drain when becoming busy (was not running, now running)', () => {
    const prevRunning = false;
    const running = true;
    const startingSession = false;
    const queueLength = 1;

    const shouldDrain = shouldDrainOnStateChange(
      prevRunning,
      running,
      startingSession,
      queueLength
    );

    expect(shouldDrain).toBe(false);
  });

  it('should NOT drain when starting session even with queued messages', () => {
    const prevRunning = false;
    const running = false;
    const startingSession = true;
    const queueLength = 1;

    const shouldDrain = shouldDrainOnStateChange(
      prevRunning,
      running,
      startingSession,
      queueLength
    );

    expect(shouldDrain).toBe(false);
  });

  it('should NOT drain when idle but queue is empty', () => {
    const prevRunning = true;
    const running = false;
    const startingSession = false;
    const queueLength = 0;

    const shouldDrain = shouldDrainOnStateChange(
      prevRunning,
      running,
      startingSession,
      queueLength
    );

    expect(shouldDrain).toBe(false);
  });
});

describe('queue draining actions', () => {
  it('should remove first message from queue (FIFO)', () => {
    const msg1 = createQueuedMessage('First');
    const msg2 = createQueuedMessage('Second');
    const msg3 = createQueuedMessage('Third');

    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [msg1, msg2, msg3],
    });

    const result = simulateDrainQueue(state, 'session-123');

    expect(result.persistedQueue).toHaveLength(2);
    expect(result.persistedQueue?.[0].id).toBe(msg2.id);
    expect(result.persistedQueue?.[1].id).toBe(msg3.id);
  });

  it('should send start message with current settings', () => {
    const settings: ChatSettings = {
      selectedModel: 'sonnet',
      thinkingEnabled: true,
      planModeEnabled: false,
    };

    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [createQueuedMessage('Hello')],
      chatSettings: settings,
    });

    const result = simulateDrainQueue(state, 'session-123');

    const startMsg = result.sentMessages.find((m) => m.type === 'start');
    expect(startMsg).toBeDefined();
    expect(startMsg?.selectedModel).toBe('sonnet');
    expect(startMsg?.thinkingEnabled).toBe(true);
    expect(startMsg?.planModeEnabled).toBe(false);
  });

  it('should send user_input message with original text when thinking disabled', () => {
    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [createQueuedMessage('Hello Claude')],
      chatSettings: {
        ...DEFAULT_CHAT_SETTINGS,
        thinkingEnabled: false,
      },
    });

    const result = simulateDrainQueue(state, 'session-123');

    const userInputMsg = result.sentMessages.find((m) => m.type === 'user_input');
    expect(userInputMsg?.text).toBe('Hello Claude');
  });

  it('should append THINKING_SUFFIX when thinking enabled', () => {
    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [createQueuedMessage('Hello Claude')],
      chatSettings: {
        ...DEFAULT_CHAT_SETTINGS,
        thinkingEnabled: true,
      },
    });

    const result = simulateDrainQueue(state, 'session-123');

    const userInputMsg = result.sentMessages.find((m) => m.type === 'user_input');
    expect(userInputMsg?.text).toBe(`Hello Claude${THINKING_SUFFIX}`);
  });

  it('should dispatch WS_STARTING action', () => {
    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [createQueuedMessage('Hello')],
    });

    const result = simulateDrainQueue(state, 'session-123');

    const startingAction = result.actions.find((a) => a.type === 'WS_STARTING');
    expect(startingAction).toBeDefined();
  });

  it('should dispatch USER_MESSAGE_SENT for optimistic UI', () => {
    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [createQueuedMessage('Hello world')],
    });

    const result = simulateDrainQueue(state, 'session-123');

    const userMsgAction = result.actions.find((a) => a.type === 'USER_MESSAGE_SENT');
    expect(userMsgAction).toBeDefined();
    expect((userMsgAction?.payload as { text: string })?.text).toBe('Hello world');
  });

  it('should clear draft when draining', () => {
    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [createQueuedMessage('Hello')],
    });

    const result = simulateDrainQueue(state, 'session-123');

    expect(result.clearedDraft).toBe(true);
  });
});

// =============================================================================
// sendMessage Pattern Tests
// =============================================================================

describe('sendMessage pattern', () => {
  /**
   * Simulates the sendMessage logic from use-chat-state.ts.
   */
  function simulateSendMessage(
    text: string,
    currentQueue: QueuedMessage[],
    _sessionId: string | null
  ): {
    queued: boolean;
    newQueue: QueuedMessage[] | null;
    queuedMessage: QueuedMessage | null;
  } {
    if (!text.trim()) {
      return { queued: false, newQueue: null, queuedMessage: null };
    }

    const queuedMsg: QueuedMessage = {
      id: generateMessageId(),
      text: text.trim(),
      timestamp: new Date().toISOString(),
    };

    const newQueue = [...currentQueue, queuedMsg];

    return {
      queued: true,
      newQueue,
      queuedMessage: queuedMsg,
    };
  }

  it('should queue message with trimmed text', () => {
    const result = simulateSendMessage('  Hello world  ', [], 'session-123');

    expect(result.queued).toBe(true);
    expect(result.queuedMessage?.text).toBe('Hello world');
  });

  it('should NOT queue empty message', () => {
    const result = simulateSendMessage('', [], 'session-123');

    expect(result.queued).toBe(false);
    expect(result.newQueue).toBeNull();
  });

  it('should NOT queue whitespace-only message', () => {
    const result = simulateSendMessage('   \n\t  ', [], 'session-123');

    expect(result.queued).toBe(false);
    expect(result.newQueue).toBeNull();
  });

  it('should append to existing queue', () => {
    const existingMsg = createQueuedMessage('First');
    const result = simulateSendMessage('Second', [existingMsg], 'session-123');

    expect(result.newQueue).toHaveLength(2);
    expect(result.newQueue?.[0].id).toBe(existingMsg.id);
    expect(result.newQueue?.[1].text).toBe('Second');
  });

  it('should generate unique ID for each message', () => {
    const result1 = simulateSendMessage('First', [], 'session-123');
    const result2 = simulateSendMessage('Second', [], 'session-123');

    expect(result1.queuedMessage?.id).not.toBe(result2.queuedMessage?.id);
  });

  it('should include timestamp', () => {
    const before = new Date();
    const result = simulateSendMessage('Hello', [], 'session-123');
    const after = new Date();

    expect(result.queuedMessage?.timestamp).toBeDefined();
    const timestamp = new Date(result.queuedMessage?.timestamp ?? '');
    expect(timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// =============================================================================
// removeQueuedMessage Pattern Tests
// =============================================================================

describe('removeQueuedMessage pattern', () => {
  /**
   * Simulates the removeQueuedMessage logic from use-chat-state.ts.
   */
  function simulateRemoveQueuedMessage(id: string, currentQueue: QueuedMessage[]): QueuedMessage[] {
    return currentQueue.filter((msg) => msg.id !== id);
  }

  it('should remove message by ID', () => {
    const msg1 = createQueuedMessage('First');
    const msg2 = createQueuedMessage('Second');
    const msg3 = createQueuedMessage('Third');

    const result = simulateRemoveQueuedMessage(msg2.id, [msg1, msg2, msg3]);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(msg1.id);
    expect(result[1].id).toBe(msg3.id);
  });

  it('should return same array if ID not found', () => {
    const msg1 = createQueuedMessage('First');
    const msg2 = createQueuedMessage('Second');
    const queue = [msg1, msg2];

    const result = simulateRemoveQueuedMessage('non-existent-id', queue);

    expect(result).toHaveLength(2);
  });

  it('should handle empty queue', () => {
    const result = simulateRemoveQueuedMessage('any-id', []);

    expect(result).toEqual([]);
  });

  it('should remove first message when ID matches', () => {
    const msg1 = createQueuedMessage('First');
    const msg2 = createQueuedMessage('Second');

    const result = simulateRemoveQueuedMessage(msg1.id, [msg1, msg2]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(msg2.id);
  });

  it('should remove last message when ID matches', () => {
    const msg1 = createQueuedMessage('First');
    const msg2 = createQueuedMessage('Second');

    const result = simulateRemoveQueuedMessage(msg2.id, [msg1, msg2]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(msg1.id);
  });
});

// =============================================================================
// Session Switching Queue Behavior Tests
// =============================================================================

describe('session switching queue behavior', () => {
  it('should clear queue on SESSION_SWITCH_START', () => {
    const state = createInitialChatState({
      queuedMessages: [createQueuedMessage('Queued 1'), createQueuedMessage('Queued 2')],
    });

    const newState = chatReducer(state, { type: 'SESSION_SWITCH_START' });

    expect(newState.queuedMessages).toEqual([]);
  });

  it('should clear queue on RESET_FOR_SESSION_SWITCH', () => {
    const state = createInitialChatState({
      queuedMessages: [createQueuedMessage('Queued')],
    });

    const newState = chatReducer(state, { type: 'RESET_FOR_SESSION_SWITCH' });

    expect(newState.queuedMessages).toEqual([]);
  });

  it('should NOT clear queue on CLEAR_CHAT', () => {
    const msg = createQueuedMessage('Queued');
    const state = createInitialChatState({
      queuedMessages: [msg],
    });

    const newState = chatReducer(state, { type: 'CLEAR_CHAT' });

    // CLEAR_CHAT resets messages but doesn't explicitly clear queue
    // (the actual queue clearing happens via persistence in the hook)
    expect(newState.queuedMessages).toEqual([msg]);
  });
});

// =============================================================================
// Queue State Transitions Tests
// =============================================================================

describe('queue state transitions', () => {
  it('should support full queue lifecycle: add -> drain -> empty', () => {
    // Start with empty state
    let state = createInitialChatState();
    expect(state.queuedMessages).toEqual([]);

    // Add first message
    const msg1 = createQueuedMessage('First');
    state = chatReducer(state, { type: 'QUEUE_MESSAGE', payload: msg1 });
    expect(state.queuedMessages).toHaveLength(1);

    // Add second message
    const msg2 = createQueuedMessage('Second');
    state = chatReducer(state, { type: 'QUEUE_MESSAGE', payload: msg2 });
    expect(state.queuedMessages).toHaveLength(2);

    // Drain first message (simulated via SET_QUEUE)
    state = chatReducer(state, { type: 'SET_QUEUE', payload: [msg2] });
    expect(state.queuedMessages).toHaveLength(1);
    expect(state.queuedMessages[0].id).toBe(msg2.id);

    // Drain second message
    state = chatReducer(state, { type: 'SET_QUEUE', payload: [] });
    expect(state.queuedMessages).toEqual([]);
  });

  it('should maintain queue order when adding multiple messages', () => {
    let state = createInitialChatState();

    const messages = ['First', 'Second', 'Third', 'Fourth', 'Fifth'].map(createQueuedMessage);

    for (const msg of messages) {
      state = chatReducer(state, { type: 'QUEUE_MESSAGE', payload: msg });
    }

    expect(state.queuedMessages).toHaveLength(5);
    expect(state.queuedMessages[0].text).toBe('First');
    expect(state.queuedMessages[4].text).toBe('Fifth');
  });

  it('should not affect queue when receiving WS messages', () => {
    const queuedMsg = createQueuedMessage('Queued');
    const state = createInitialChatState({
      queuedMessages: [queuedMsg],
    });

    // Simulate receiving various WS messages
    let newState = chatReducer(state, { type: 'WS_STATUS', payload: { running: true } });
    expect(newState.queuedMessages).toEqual([queuedMsg]);

    newState = chatReducer(newState, { type: 'WS_STARTING' });
    expect(newState.queuedMessages).toEqual([queuedMsg]);

    newState = chatReducer(newState, { type: 'WS_STOPPED' });
    expect(newState.queuedMessages).toEqual([queuedMsg]);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('queue edge cases', () => {
  it('should handle draining with null sessionId', () => {
    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [createQueuedMessage('Hello')],
    });

    // Should still drain even with null sessionId (persistence just won't happen)
    const result = simulateDrainQueue(state, null);

    expect(result.shouldDrain).toBe(true);
  });

  it('should handle very long message text', () => {
    const longText = 'a'.repeat(10_000);
    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [createQueuedMessage(longText)],
    });

    const result = simulateDrainQueue(state, 'session-123');

    expect(result.shouldDrain).toBe(true);
    const userInputMsg = result.sentMessages.find((m) => m.type === 'user_input');
    expect((userInputMsg?.text as string).length).toBe(10_000);
  });

  it('should handle message with special characters', () => {
    const specialText = 'Hello "world" with \'quotes\' and\nnewlines\tand\ttabs 🎉';
    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [createQueuedMessage(specialText)],
    });

    const result = simulateDrainQueue(state, 'session-123');

    const userInputMsg = result.sentMessages.find((m) => m.type === 'user_input');
    expect(userInputMsg?.text).toBe(specialText);
  });

  it('should handle unicode characters in message', () => {
    const unicodeText = 'Hello 世界 مرحبا שלום';
    const state = createInitialChatState({
      running: false,
      startingSession: false,
      queuedMessages: [createQueuedMessage(unicodeText)],
    });

    const result = simulateDrainQueue(state, 'session-123');

    const userInputMsg = result.sentMessages.find((m) => m.type === 'user_input');
    expect(userInputMsg?.text).toBe(unicodeText);
  });

  it('should handle rapid state transitions', () => {
    // Simulate rapid running state changes
    let state = createInitialChatState({
      queuedMessages: [createQueuedMessage('Message')],
    });

    // Start running
    state = chatReducer(state, { type: 'WS_STATUS', payload: { running: true } });
    expect(shouldDrainOnStateChange(false, state.running, state.startingSession, 1)).toBe(false);

    // Stop running
    state = chatReducer(state, { type: 'WS_STATUS', payload: { running: false } });
    expect(shouldDrainOnStateChange(true, state.running, state.startingSession, 1)).toBe(true);
  });
});
