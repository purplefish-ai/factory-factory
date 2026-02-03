import { describe, expect, it } from 'vitest';
import type { HistoryMessage, QueuedMessage } from '@/shared/claude';
import { MessageState } from '@/shared/claude';
import { isValidTransition, MessageStateMachine } from './message-state-machine';

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

function createHistoryMessage(type: HistoryMessage['type'], content: string): HistoryMessage {
  return {
    type,
    content,
    timestamp: new Date().toISOString(),
  };
}

describe('MessageStateMachine', () => {
  it('validates user state transitions', () => {
    expect(isValidTransition('user', MessageState.PENDING, MessageState.SENT)).toBe(true);
    expect(isValidTransition('user', MessageState.SENT, MessageState.DISPATCHED)).toBe(false);
    expect(isValidTransition('user', MessageState.ACCEPTED, MessageState.CANCELLED)).toBe(true);
  });

  it('rejects claude state transitions', () => {
    expect(isValidTransition('claude', MessageState.COMPLETE, MessageState.COMPLETE)).toBe(false);
  });

  it('allocates order per session independently', () => {
    const machine = new MessageStateMachine();
    expect(machine.allocateOrder('session-1')).toBe(0);
    expect(machine.allocateOrder('session-1')).toBe(1);
    expect(machine.allocateOrder('session-2')).toBe(0);
  });

  it('assigns queue positions based on accepted messages', () => {
    const machine = new MessageStateMachine();
    machine.createUserMessage('session-1', createTestQueuedMessage('msg-1'));
    machine.updateState('session-1', 'msg-1', MessageState.DISPATCHED);
    const msg2 = machine.createUserMessage('session-1', createTestQueuedMessage('msg-2'));
    expect(msg2.queuePosition).toBe(0);
  });

  it('updates state with metadata', () => {
    const machine = new MessageStateMachine();
    machine.createUserMessage('session-1', createTestQueuedMessage('msg-1'));
    const result = machine.updateState('session-1', 'msg-1', MessageState.DISPATCHED, {
      queuePosition: 2,
      errorMessage: 'oops',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.state).toBe(MessageState.DISPATCHED);
      expect(result.message.queuePosition).toBe(2);
      expect(result.message.errorMessage).toBe('oops');
    }
  });

  it('does not overwrite existing messages on history load', () => {
    const machine = new MessageStateMachine();
    machine.createUserMessage('session-1', createTestQueuedMessage('msg-1'));
    const history = [createHistoryMessage('assistant', 'from history')];
    machine.loadFromHistory('session-1', history);
    expect(machine.getMessageCount('session-1')).toBe(1);
  });
});
