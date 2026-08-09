import { isWebSocketMessage } from '@/lib/chat-protocol';
import {
  AcpEventTranslator,
  type AcpTranslationLogger,
  type ChatMessage,
  type SessionDeltaEvent,
  type SubagentTranscriptUpdate,
} from '@/shared/acp-protocol';
import {
  type ChatState,
  chatReducer,
  createActionFromWebSocketMessage,
  createInitialChatState,
} from './reducer';

const TRANSCRIPT_FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

const transcriptLogger: AcpTranslationLogger = {
  warn: () => undefined,
};

function readTextContent(
  update: Extract<SubagentTranscriptUpdate, { sessionUpdate: 'user_message_chunk' }>
): string | null {
  return update.content.type === 'text' ? update.content.text : null;
}

function readThinkingDeltaIndex(delta: SessionDeltaEvent): number | null {
  if (delta.type !== 'agent_message' || delta.data.type !== 'stream_event') {
    return null;
  }
  const event = delta.data.event;
  if (
    event?.type !== 'content_block_delta' ||
    event.delta.type !== 'thinking_delta' ||
    event.delta.thinking.length === 0
  ) {
    return null;
  }
  return event.index;
}

function createThinkingStartDelta(
  index: number
): Extract<SessionDeltaEvent, { type: 'agent_message' }> {
  return {
    type: 'agent_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      },
    },
  };
}

function applySessionDelta(
  state: ChatState,
  delta: SessionDeltaEvent,
  order: number,
  messageId: string
): ChatState {
  const message: SessionDeltaEvent = { ...delta, order, messageId };
  if (!isWebSocketMessage(message)) {
    return state;
  }
  const action = createActionFromWebSocketMessage(message);
  return action ? chatReducer(state, action) : state;
}

function appendUserMessage(
  state: ChatState,
  update: Extract<SubagentTranscriptUpdate, { sessionUpdate: 'user_message_chunk' }>,
  order: number
): ChatState {
  const text = readTextContent(update);
  if (text === null) {
    return state;
  }
  const message: ChatMessage = {
    id: `subagent-user-${order}`,
    source: 'user',
    text,
    timestamp: TRANSCRIPT_FALLBACK_TIMESTAMP,
    order,
  };
  return chatReducer(state, { type: 'USER_MESSAGE_SENT', payload: message });
}

function seedThinkingSequence(
  state: ChatState,
  deltas: SessionDeltaEvent[],
  order: number
): { state: ChatState; seeded: boolean } {
  const thinkingIndex = deltas.map(readThinkingDeltaIndex).find((index) => index !== null);
  if (thinkingIndex === undefined) {
    return { state, seeded: false };
  }
  return {
    state: applySessionDelta(
      state,
      createThinkingStartDelta(thinkingIndex),
      order,
      `subagent-reasoning-${order}`
    ),
    seeded: true,
  };
}

export function projectAcpTranscriptUpdates(updates: SubagentTranscriptUpdate[]): ChatMessage[] {
  const translator = new AcpEventTranslator(transcriptLogger);
  let state = createInitialChatState({
    sessionStatus: { phase: 'ready' },
    rendererTranscriptLimit: null,
  });
  let order = 0;
  let reasoningSequenceOpen = false;

  for (const update of updates) {
    if (update.sessionUpdate === 'user_message_chunk') {
      reasoningSequenceOpen = false;
      state = appendUserMessage(state, update, order);
      order += 1;
      continue;
    }

    if (update.sessionUpdate !== 'agent_thought_chunk') {
      reasoningSequenceOpen = false;
    }

    const deltas = translator.translateSessionUpdate(update);
    if (!reasoningSequenceOpen) {
      const seeded = seedThinkingSequence(state, deltas, order);
      state = seeded.state;
      reasoningSequenceOpen = seeded.seeded;
    }

    for (const delta of deltas) {
      state = applySessionDelta(state, delta, order, `subagent-event-${order}`);
      order += 1;
    }
  }

  return state.messages.map((message, index) => ({
    ...message,
    id: `subagent-message-${message.order}-${index}`,
    timestamp: TRANSCRIPT_FALLBACK_TIMESTAMP,
  }));
}
