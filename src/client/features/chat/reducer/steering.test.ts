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
    const failed = chatReducer(state, {
      type: 'WS_ERROR',
      payload: { message: 'Failed', requestId: 'request' },
    });
    expect(failed.pendingSteer).toBeNull();
    expect(
      chatReducer(failed, { type: 'STEER_REQUESTED', messageId: 'message', requestId: 'retry' })
        .pendingSteer
    ).toEqual({ messageId: 'message', requestId: 'retry' });
  });
  it('preserves a pending steer during session replay', () => {
    const state = pending();
    const replayed = chatReducer(state, {
      type: 'SESSION_REPLAY_BATCH',
      payload: { replayEvents: [] },
    });
    expect(replayed.pendingSteer).toEqual(state.pendingSteer);
  });
  it('clears lost requests on disconnect and session switch', () => {
    expect(chatReducer(pending(), { type: 'CONFIG_OPTIONS_DISCONNECTED' }).pendingSteer).toBeNull();
    expect(chatReducer(pending(), { type: 'SESSION_SWITCH_START' }).pendingSteer).toBeNull();
  });
});
