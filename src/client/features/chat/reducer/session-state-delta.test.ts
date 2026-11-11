import { describe, expect, it } from 'vitest';
import type {
  ChatMessage,
  PendingInteractiveRequest,
  QueuedMessage,
  SessionRuntimeState,
  WebSocketMessage,
} from '@/lib/chat-protocol';
import { MessageState, QUEUED_MESSAGE_ORDER_BASE } from '@/lib/chat-protocol';
import { parseChatServerMessage } from '@/shared/acp-protocol/protocol/chat-server-message-schema';
import {
  type ChatState,
  chatReducer,
  createActionFromWebSocketMessage,
  createInitialChatState,
} from './index';

const timestamp = '2026-11-03T00:00:00.000Z';
const runtime: SessionRuntimeState = {
  phase: 'running',
  processState: 'alive',
  activity: 'WORKING',
  updatedAt: timestamp,
};

function queued(id: string): QueuedMessage {
  return {
    id,
    text: `text ${id}`,
    timestamp,
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
}

function userEntry(id: string, order: number): ChatMessage {
  return { id, source: 'user', text: `text ${id}`, timestamp, order };
}

function agentEntry(id: string, order: number): ChatMessage {
  return {
    id,
    source: 'agent',
    timestamp,
    order,
    message: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `reply ${id}` }] },
    },
  };
}

const pending: PendingInteractiveRequest = {
  requestId: 'r1',
  toolName: 'Bash',
  toolUseId: 'tool-1',
  input: { command: 'ls' },
  planContent: null,
  acpOptions: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  timestamp,
};

/** Authoritative backend state, mirrored the way the snapshot builder does. */
interface BackendState {
  transcript: ChatMessage[];
  queue: QueuedMessage[];
  pendingInteractiveRequest: PendingInteractiveRequest | null;
}

function snapshotOf(backend: BackendState): WebSocketMessage {
  const messages = [
    ...backend.transcript,
    ...backend.queue.map((message, index): ChatMessage => ({
      id: message.id,
      source: 'user',
      text: message.text,
      attachments: message.attachments,
      timestamp: message.timestamp,
      order: QUEUED_MESSAGE_ORDER_BASE + index,
    })),
  ].sort((left, right) => left.order - right.order);
  return {
    type: 'session_snapshot',
    messages,
    queuedMessages: backend.queue,
    sessionRuntime: runtime,
    pendingInteractiveRequest: backend.pendingInteractiveRequest,
  };
}

/** Feed a wire frame through the same validation and action mapping the transport uses. */
function receive(state: ChatState, frame: WebSocketMessage): ChatState {
  const wire: unknown = JSON.parse(JSON.stringify({ type: 'session_delta', data: frame }));
  const parsed = parseChatServerMessage(wire);
  if (!parsed.success || parsed.message.type !== 'session_delta') {
    throw new Error('Delta frame failed transport validation');
  }
  const action = createActionFromWebSocketMessage(parsed.message.data);
  expect(action).not.toBeNull();
  return action ? chatReducer(state, action) : state;
}

function receiveSnapshot(state: ChatState, backend: BackendState): ChatState {
  const action = createActionFromWebSocketMessage(snapshotOf(backend));
  expect(action?.type).toBe('SESSION_SNAPSHOT');
  return action ? chatReducer(state, action) : state;
}

function viewOf(state: ChatState) {
  return {
    messages: state.messages,
    queuedMessages: [...state.queuedMessages.values()],
    pendingRequest: state.pendingRequest,
    pendingMessageIds: [...state.pendingMessages.keys()],
  };
}

/** Applies `delta` and asserts the result matches applying the equivalent snapshot. */
function expectDeltaMatchesSnapshot(
  state: ChatState,
  delta: WebSocketMessage,
  backend: BackendState
): ChatState {
  const viaDelta = receive(state, delta);
  const viaSnapshot = receiveSnapshot(state, backend);
  expect(viewOf(viaDelta)).toEqual(viewOf(viaSnapshot));
  return viaDelta;
}

function hydrated(backend: BackendState): ChatState {
  return receiveSnapshot(createInitialChatState(), backend);
}

describe('targeted session-state deltas', () => {
  it('reproduces snapshot state for queue changes', () => {
    const backend: BackendState = {
      transcript: [userEntry('u0', 0), agentEntry('a1', 1)],
      queue: [],
      pendingInteractiveRequest: null,
    };
    let state = hydrated(backend);

    backend.queue = [queued('q1')];
    state = expectDeltaMatchesSnapshot(
      state,
      { type: 'queue_updated', queuedMessages: backend.queue },
      backend
    );

    backend.queue = [queued('q1'), queued('q2'), queued('q3')];
    state = expectDeltaMatchesSnapshot(
      state,
      { type: 'queue_updated', queuedMessages: backend.queue },
      backend
    );

    backend.queue = [queued('q1'), queued('q3')];
    state = expectDeltaMatchesSnapshot(
      state,
      { type: 'queue_updated', queuedMessages: backend.queue },
      backend
    );
    expect(state.messages.map(({ id }) => id)).toEqual(['u0', 'a1', 'q1', 'q3']);
  });

  it('reproduces snapshot state when a dispatched message is committed', () => {
    const backend: BackendState = {
      transcript: [userEntry('u0', 0), agentEntry('a1', 1)],
      queue: [queued('q1'), queued('q2')],
      pendingInteractiveRequest: null,
    };
    let state = hydrated(backend);

    // Dispatch takes q1 and announces it; the snapshot no longer follows.
    state = receive(state, {
      type: 'message_state_changed',
      id: 'q1',
      newState: MessageState.DISPATCHED,
      userMessage: { text: 'text q1', timestamp, order: 2 },
    });
    backend.queue = [queued('q2')];
    backend.transcript = [...backend.transcript, userEntry('q1', 2)];
    state = expectDeltaMatchesSnapshot(
      state,
      {
        type: 'transcript_message_committed',
        chatMessage: userEntry('q1', 2),
        queuedMessages: backend.queue,
      },
      backend
    );
    expect(state.messages.map(({ id }) => id)).toEqual(['u0', 'a1', 'q1', 'q2']);
  });

  it('reproduces snapshot state when a steered message commits mid-queue', () => {
    const backend: BackendState = {
      transcript: [userEntry('u0', 0)],
      queue: [queued('first'), queued('selected')],
      pendingInteractiveRequest: null,
    };
    const state = hydrated(backend);

    backend.queue = [queued('first')];
    backend.transcript = [...backend.transcript, userEntry('selected', 1)];
    const next = expectDeltaMatchesSnapshot(
      state,
      {
        type: 'transcript_message_committed',
        chatMessage: userEntry('selected', 1),
        queuedMessages: backend.queue,
      },
      backend
    );
    expect(next.messages.filter(({ id }) => id === 'selected')).toHaveLength(1);
  });

  it('reproduces snapshot state when a committed message is requeued', () => {
    const backend: BackendState = {
      transcript: [userEntry('u0', 0), userEntry('q1', 1)],
      queue: [queued('q2')],
      pendingInteractiveRequest: null,
    };
    const state = hydrated(backend);

    backend.transcript = [userEntry('u0', 0)];
    backend.queue = [queued('q1'), queued('q2')];
    const next = expectDeltaMatchesSnapshot(
      state,
      { type: 'queue_updated', queuedMessages: backend.queue },
      backend
    );
    expect(next.messages.map(({ id, order }) => [id, order])).toEqual([
      ['u0', 0],
      ['q1', QUEUED_MESSAGE_ORDER_BASE],
      ['q2', QUEUED_MESSAGE_ORDER_BASE + 1],
    ]);
  });

  it('reproduces snapshot state for a committed PR update entry', () => {
    const backend: BackendState = {
      transcript: [userEntry('u0', 0)],
      queue: [queued('pr-event-1')],
      pendingInteractiveRequest: null,
    };
    const state = hydrated(backend);
    const prUpdate: ChatMessage = {
      id: 'pr-event-1',
      source: 'agent',
      timestamp,
      order: 1,
      message: { type: 'pr_update', text: 'PR update' },
    };
    backend.queue = [];
    backend.transcript = [...backend.transcript, prUpdate];
    expectDeltaMatchesSnapshot(
      state,
      { type: 'transcript_message_committed', chatMessage: prUpdate, queuedMessages: [] },
      backend
    );
  });

  it('reproduces snapshot state for pending request changes', () => {
    const backend: BackendState = {
      transcript: [userEntry('u0', 0)],
      queue: [],
      pendingInteractiveRequest: null,
    };
    let state = hydrated(backend);

    backend.pendingInteractiveRequest = pending;
    state = expectDeltaMatchesSnapshot(
      state,
      { type: 'pending_request_updated', pendingInteractiveRequest: pending },
      backend
    );
    expect(state.pendingRequest.type).toBe('permission');

    backend.pendingInteractiveRequest = null;
    state = expectDeltaMatchesSnapshot(
      state,
      { type: 'pending_request_updated', pendingInteractiveRequest: null },
      backend
    );
    expect(state.pendingRequest).toEqual({ type: 'none' });
  });

  it('leaves the rest of the transcript untouched', () => {
    const backend: BackendState = {
      transcript: [userEntry('u0', 0), agentEntry('a1', 1)],
      queue: [],
      pendingInteractiveRequest: null,
    };
    const state = hydrated(backend);
    const next = receive(state, { type: 'queue_updated', queuedMessages: [queued('q1')] });
    expect(next.messages[0]).toBe(state.messages[0]);
    expect(next.messages[1]).toBe(state.messages[1]);

    const unchanged = receive(next, { type: 'queue_updated', queuedMessages: [queued('q1')] });
    expect(unchanged.messages).toBe(next.messages);
    expect(
      receive(unchanged, { type: 'pending_request_updated', pendingInteractiveRequest: null })
    ).toBe(unchanged);
  });

  it('replaces a queued row when only attachment metadata changes', () => {
    const attachment = { id: 'a1', name: 'old.png', type: 'image/png', size: 3, data: 'abc' };
    const withAttachment = (name: string): QueuedMessage => ({
      ...queued('q1'),
      attachments: [{ ...attachment, name }],
    });
    let state = hydrated({ transcript: [], queue: [], pendingInteractiveRequest: null });
    state = receive(state, { type: 'queue_updated', queuedMessages: [withAttachment('old.png')] });
    state = receive(state, { type: 'queue_updated', queuedMessages: [withAttachment('new.png')] });
    expect(state.messages[0]?.attachments?.[0]?.name).toBe('new.png');
  });

  it('keeps local recovery metadata a snapshot would discard', () => {
    let state = hydrated({ transcript: [], queue: [], pendingInteractiveRequest: null });
    state = chatReducer(state, {
      type: 'MESSAGE_SENDING',
      payload: { id: 'q1', text: 'text q1', sessionId: 'composer-session' },
    });
    state = receive(state, { type: 'queue_updated', queuedMessages: [queued('q1')] });
    expect(state.pendingMessages.has('q1')).toBe(false);
    expect(state.queuedMessages.get('q1')?.sessionId).toBe('composer-session');
  });

  it('rejects malformed deltas at the transport boundary', () => {
    const accepts = (data: unknown) => parseChatServerMessage(data).success;
    expect(
      accepts({
        type: 'session_delta',
        data: { type: 'queue_updated', queuedMessages: [{ id: 'q1' }] },
      })
    ).toBe(false);
    expect(
      accepts({
        type: 'session_delta',
        data: { type: 'pending_request_updated' },
      })
    ).toBe(false);
    expect(
      accepts({
        type: 'session_delta',
        data: {
          type: 'transcript_message_committed',
          chatMessage: { id: 'x', source: 'robot', timestamp, order: 1 },
          queuedMessages: [],
        },
      })
    ).toBe(false);
  });
});
