import { describe, expect, it } from 'vitest';
import { MessageState } from '@/lib/chat-protocol';
import { chatReducer, createInitialChatState } from './index';

const id = 'pr-event-delivery';
const text = '<!-- factory-factory-pr-event:delivery -->\nCI failed';
const timestamp = '2026-10-27T00:00:00Z';

describe('PR update terminal delivery states', () => {
  it.each([
    [MessageState.FAILED, 'failed'],
    [MessageState.REJECTED, 'failed'],
    [MessageState.CANCELLED, 'cancelled'],
  ] as const)('retains a %s card without recovering an agent prompt', (newState, deliveryState) => {
    let state = chatReducer(createInitialChatState(), {
      type: 'MESSAGE_STATE_CHANGED',
      payload: { id, newState: MessageState.ACCEPTED, userMessage: { text, timestamp } },
    });
    state = chatReducer(state, {
      type: 'MESSAGE_STATE_CHANGED',
      payload: { id, newState, errorMessage: 'Delivery unavailable' },
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id,
      source: 'agent',
      message: {
        type: 'pr_update',
        text,
        prDeliveryState: deliveryState,
        error: 'Delivery unavailable',
      },
    });
    expect(state.lastRejectedMessage).toBeNull();
    expect(state.queuedMessages.has(id)).toBe(false);
    expect(state.pendingMessages.has(id)).toBe(false);
  });
});
