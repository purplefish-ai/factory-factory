import { expect, it } from 'vitest';
import { type ChatMessage, MessageState, type SessionRuntimeState } from '@/lib/chat-protocol';
import { type ChatState, chatReducer, createInitialChatState } from './index';

const timestamp = '2026-11-13T00:00:00.000Z';
const sessionRuntime: SessionRuntimeState = {
  phase: 'idle',
  processState: 'alive',
  activity: 'IDLE',
  updatedAt: timestamp,
};

function send(state: ChatState, id: string): ChatState {
  return chatReducer(state, {
    type: 'MESSAGE_SENDING',
    payload: { id, text: `text ${id}`, sessionId: 'session-A' },
  });
}

function confirmed(id: string): ChatMessage {
  return { id, source: 'user', text: `text ${id}`, timestamp, order: 0 };
}

it('keeps unconfirmed sends through snapshots and replay, dropping one a snapshot includes', () => {
  const sending = send(send(createInitialChatState(), 'first'), 'second');

  const refreshed = chatReducer(sending, {
    type: 'SESSION_SNAPSHOT',
    payload: { messages: [confirmed('first')], queuedMessages: [], sessionRuntime },
  });
  expect([...refreshed.pendingMessages.keys()]).toEqual(['second']);

  const replayed = chatReducer(refreshed, {
    type: 'SESSION_REPLAY_BATCH',
    payload: { replayEvents: [{ type: 'session_runtime_snapshot', sessionRuntime }] },
  });
  expect(replayed.pendingMessages.get('second')).toEqual({
    text: 'text second',
    attachments: undefined,
    sessionId: 'session-A',
  });
});

it('replaces confirmed queue membership on replay and preserves recovery for surviving submissions', () => {
  const settings = {
    selectedModel: null,
    reasoningEffort: null,
    thinkingEnabled: false,
    planModeEnabled: false,
  };
  const entry = (id: string) => ({ id, text: id, timestamp, settings });
  let viewer = send(send(createInitialChatState(), 'cancelled'), 'still-queued');
  viewer = chatReducer(viewer, {
    type: 'QUEUE_UPDATED',
    payload: { queuedMessages: [entry('cancelled'), entry('still-queued')] },
  });
  const reconnect = chatReducer(viewer, {
    type: 'SESSION_REPLAY_BATCH',
    payload: {
      replayEvents: [
        { type: 'session_runtime_snapshot', sessionRuntime },
        {
          type: 'message_state_changed',
          id: 'still-queued',
          newState: MessageState.ACCEPTED,
          queuePosition: 0,
          userMessage: { text: 'still-queued', timestamp, settings },
        },
      ],
    },
  });
  expect([...reconnect.queuedMessages.keys()]).toEqual(['still-queued']);
  expect(reconnect.queuedMessages.get('still-queued')?.sessionId).toBe('session-A');
});
