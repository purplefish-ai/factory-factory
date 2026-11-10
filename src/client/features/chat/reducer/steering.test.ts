import { describe, expect, it } from 'vitest';
import { chatReducer, createActionFromWebSocketMessage, createInitialChatState } from './index';

const pending = () =>
  chatReducer(createInitialChatState(), {
    type: 'STEER_REQUESTED',
    messageId: 'message',
    requestId: 'request',
  });

describe('pending steering', () => {
  it('settles only the matching server acknowledgment', () => {
    const state = pending();
    const stale = createActionFromWebSocketMessage({ type: 'steer_settled', requestId: 'old' })!;
    expect(chatReducer(state, stale).pendingSteer).toEqual(state.pendingSteer);
    const ack = createActionFromWebSocketMessage({ type: 'steer_settled', requestId: 'request' })!;
    expect(chatReducer(state, ack).pendingSteer).toBeNull();
  });
  it('allows retry after a matching failure and ignores unrelated errors', () => {
    const state = pending();
    expect(
      chatReducer(state, { type: 'WS_ERROR', payload: { message: 'Unrelated' } }).pendingSteer
    ).toEqual(state.pendingSteer);
    expect(
      chatReducer(state, { type: 'WS_ERROR', payload: { message: 'Failed', requestId: 'request' } })
        .pendingSteer
    ).toBeNull();
  });
  it('clears lost requests on disconnect and session switch', () => {
    expect(chatReducer(pending(), { type: 'CONFIG_OPTIONS_DISCONNECTED' }).pendingSteer).toBeNull();
    expect(chatReducer(pending(), { type: 'SESSION_SWITCH_START' }).pendingSteer).toBeNull();
  });
});
