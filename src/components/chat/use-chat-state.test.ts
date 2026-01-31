/**
 * Tests for the useChatState hook.
 *
 * These tests verify the chat state management logic including:
 * - Queue management (now backend-managed)
 * - Session switching effects
 * - sendMessage behavior
 * - Reducer state transitions
 *
 * Note: The queue is now managed by the backend. The frontend only displays
 * pending messages received from session_loaded and clears them on WS_STARTED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedMessage } from '@/lib/claude-types';
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
// Helper Functions
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

// =============================================================================
// Backend Queue Display Tests
// =============================================================================

describe('backend queue display', () => {
  it('should set queuedMessages from session_loaded pendingMessages', () => {
    const state = createInitialChatState({ loadingSession: true });
    const pendingMessages = [createQueuedMessage('Pending 1'), createQueuedMessage('Pending 2')];

    const newState = chatReducer(state, {
      type: 'WS_SESSION_LOADED',
      payload: {
        messages: [],
        pendingMessages,
        gitBranch: null,
        running: false,
      },
    });

    expect(newState.queuedMessages).toHaveLength(2);
    expect(newState.queuedMessages[0].text).toBe('Pending 1');
    expect(newState.queuedMessages[1].text).toBe('Pending 2');
  });

  it('should set empty queuedMessages when no pendingMessages in session_loaded', () => {
    const state = createInitialChatState({
      loadingSession: true,
      queuedMessages: [createQueuedMessage('Old')],
    });

    const newState = chatReducer(state, {
      type: 'WS_SESSION_LOADED',
      payload: {
        messages: [],
        gitBranch: null,
        running: false,
      },
    });

    expect(newState.queuedMessages).toEqual([]);
  });

  it('should clear queuedMessages on WS_STARTED (backend drained queue)', () => {
    const state = createInitialChatState({
      queuedMessages: [createQueuedMessage('Pending')],
      startingSession: true,
    });

    const newState = chatReducer(state, { type: 'WS_STARTED' });

    expect(newState.queuedMessages).toEqual([]);
    expect(newState.running).toBe(true);
    expect(newState.startingSession).toBe(false);
  });
});

// =============================================================================
// WS_MESSAGE_QUEUED Tests
// =============================================================================

describe('WS_MESSAGE_QUEUED action', () => {
  it('should add message to queue', () => {
    const state = createInitialChatState();
    const msg = createQueuedMessage('New message');

    const newState = chatReducer(state, { type: 'WS_MESSAGE_QUEUED', payload: msg });

    expect(newState.queuedMessages).toHaveLength(1);
    expect(newState.queuedMessages[0].text).toBe('New message');
  });

  it('should append to existing queue', () => {
    const existing = createQueuedMessage('Existing');
    const state = createInitialChatState({ queuedMessages: [existing] });
    const newMsg = createQueuedMessage('New message');

    const newState = chatReducer(state, { type: 'WS_MESSAGE_QUEUED', payload: newMsg });

    expect(newState.queuedMessages).toHaveLength(2);
    expect(newState.queuedMessages[0].id).toBe(existing.id);
    expect(newState.queuedMessages[1].id).toBe(newMsg.id);
  });
});

// =============================================================================
// removeQueuedMessage Pattern Tests
// =============================================================================

describe('removeQueuedMessage pattern', () => {
  it('should remove message by ID using REMOVE_QUEUED_MESSAGE', () => {
    const msg1 = createQueuedMessage('First');
    const msg2 = createQueuedMessage('Second');
    const msg3 = createQueuedMessage('Third');
    const state = createInitialChatState({ queuedMessages: [msg1, msg2, msg3] });

    const newState = chatReducer(state, {
      type: 'REMOVE_QUEUED_MESSAGE',
      payload: { id: msg2.id },
    });

    expect(newState.queuedMessages).toHaveLength(2);
    expect(newState.queuedMessages[0].id).toBe(msg1.id);
    expect(newState.queuedMessages[1].id).toBe(msg3.id);
  });

  it('should not change queue if ID not found', () => {
    const msg1 = createQueuedMessage('First');
    const msg2 = createQueuedMessage('Second');
    const state = createInitialChatState({ queuedMessages: [msg1, msg2] });

    const newState = chatReducer(state, {
      type: 'REMOVE_QUEUED_MESSAGE',
      payload: { id: 'non-existent' },
    });

    expect(newState.queuedMessages).toHaveLength(2);
  });

  it('should handle empty queue', () => {
    const state = createInitialChatState({ queuedMessages: [] });

    const newState = chatReducer(state, {
      type: 'REMOVE_QUEUED_MESSAGE',
      payload: { id: 'any-id' },
    });

    expect(newState.queuedMessages).toEqual([]);
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

    // CLEAR_CHAT resets messages but doesn't clear queue
    expect(newState.queuedMessages).toEqual([msg]);
  });
});

// =============================================================================
// Queue State Transitions Tests
// =============================================================================

describe('queue state transitions', () => {
  it('should support queue lifecycle: load from backend -> display -> clear on started', () => {
    // Start with empty state
    let state = createInitialChatState({ loadingSession: true });
    expect(state.queuedMessages).toEqual([]);

    // Session loaded with pending messages from backend
    const pendingMessages = [createQueuedMessage('Pending 1'), createQueuedMessage('Pending 2')];
    state = chatReducer(state, {
      type: 'WS_SESSION_LOADED',
      payload: {
        messages: [],
        pendingMessages,
        gitBranch: null,
        running: false,
      },
    });
    expect(state.queuedMessages).toHaveLength(2);

    // Agent starts, queue is drained by backend
    state = chatReducer(state, { type: 'WS_STARTED' });
    expect(state.queuedMessages).toEqual([]);
  });

  it('should not affect queue when receiving other WS messages', () => {
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
// DEQUEUE_MESSAGE Tests
// =============================================================================

describe('DEQUEUE_MESSAGE action', () => {
  it('should remove first message from queue', () => {
    const msg1 = createQueuedMessage('First');
    const msg2 = createQueuedMessage('Second');
    const msg3 = createQueuedMessage('Third');
    const state = createInitialChatState({ queuedMessages: [msg1, msg2, msg3] });

    const newState = chatReducer(state, { type: 'DEQUEUE_MESSAGE' });

    expect(newState.queuedMessages).toHaveLength(2);
    expect(newState.queuedMessages[0].id).toBe(msg2.id);
    expect(newState.queuedMessages[1].id).toBe(msg3.id);
  });

  it('should handle empty queue', () => {
    const state = createInitialChatState({ queuedMessages: [] });

    const newState = chatReducer(state, { type: 'DEQUEUE_MESSAGE' });

    expect(newState.queuedMessages).toEqual([]);
  });

  it('should handle single-item queue', () => {
    const msg = createQueuedMessage('Only');
    const state = createInitialChatState({ queuedMessages: [msg] });

    const newState = chatReducer(state, { type: 'DEQUEUE_MESSAGE' });

    expect(newState.queuedMessages).toEqual([]);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('queue edge cases', () => {
  it('should handle session_loaded with running=true and pending messages', () => {
    const state = createInitialChatState({ loadingSession: true });
    const pendingMessages = [createQueuedMessage('Pending')];

    const newState = chatReducer(state, {
      type: 'WS_SESSION_LOADED',
      payload: {
        messages: [],
        pendingMessages,
        gitBranch: null,
        running: true,
      },
    });

    // Queue should be set from pending messages
    expect(newState.queuedMessages).toHaveLength(1);
    expect(newState.running).toBe(true);
  });

  it('should handle message with special characters', () => {
    const specialText = 'Hello "world" with \'quotes\' and\nnewlines\tand\ttabs 🎉';
    const msg = createQueuedMessage(specialText);
    const state = createInitialChatState();

    const newState = chatReducer(state, { type: 'QUEUE_MESSAGE', payload: msg });

    expect(newState.queuedMessages[0].text).toBe(specialText);
  });

  it('should handle unicode characters in message', () => {
    const unicodeText = 'Hello 世界 مرحبا שלום';
    const msg = createQueuedMessage(unicodeText);
    const state = createInitialChatState();

    const newState = chatReducer(state, { type: 'QUEUE_MESSAGE', payload: msg });

    expect(newState.queuedMessages[0].text).toBe(unicodeText);
  });
});
