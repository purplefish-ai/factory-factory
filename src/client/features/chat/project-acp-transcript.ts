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

function* coalesceAgentTextChunks(
  updates: SubagentTranscriptUpdate[]
): Generator<{ update: SubagentTranscriptUpdate; chunkCount: number }> {
  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index];
    if (!update) {
      continue;
    }
    if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') {
      yield { update, chunkCount: 1 };
      continue;
    }

    const chunks = [update.content.text];
    let nextIndex = index + 1;
    while (nextIndex < updates.length) {
      const next = updates[nextIndex];
      if (
        next?.sessionUpdate !== 'agent_message_chunk' ||
        next.content.type !== 'text' ||
        (next.messageId ?? null) !== (update.messageId ?? null)
      ) {
        break;
      }
      chunks.push(next.content.text);
      nextIndex += 1;
    }

    yield {
      update: { ...update, content: { ...update.content, text: chunks.join('') } },
      chunkCount: chunks.length,
    };
    index = nextIndex - 1;
  }
}

function upsertPendingTool(
  messages: ChatMessage[],
  pendingTools: Map<string, number>,
  message: ChatMessage
): boolean {
  const event = message.message?.event;
  if (event?.type !== 'content_block_start' || event.content_block.type !== 'tool_use') {
    return false;
  }
  const toolId = event.content_block.id;
  const previousIndex = pendingTools.get(toolId);
  if (previousIndex === undefined) {
    pendingTools.set(toolId, messages.length);
    return false;
  }
  const previous = messages[previousIndex];
  if (!previous) {
    return false;
  }
  messages[previousIndex] = { ...message, id: previous.id, order: previous.order };
  return true;
}

function collectProjectedMessage(
  messages: ChatMessage[],
  pendingTools: Map<string, number>,
  message: ChatMessage
): void {
  if (upsertPendingTool(messages, pendingTools, message)) {
    return;
  }
  const content = message.message?.message?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'tool_result') {
        pendingTools.delete(item.tool_use_id);
      }
    }
  }
  messages.push(message);
}

export function projectAcpTranscriptUpdates(updates: SubagentTranscriptUpdate[]): ChatMessage[] {
  const translator = new AcpEventTranslator(transcriptLogger);
  const emptyState = createInitialChatState({
    sessionStatus: { phase: 'ready' },
    rendererTranscriptLimit: null,
  });
  let state = emptyState;
  const messages: ChatMessage[] = [];
  const pendingTools = new Map<string, number>();
  // Keep only the current reasoning sequence in the reducer. Collect other
  // messages once and enrich pending tools by index, keeping projection linear.
  const collectMessages = () => {
    for (const message of state.messages) {
      collectProjectedMessage(messages, pendingTools, message);
    }
    state = emptyState;
  };
  let order = 0;
  let reasoningSequenceOpen = false;

  // Translate one complete text sequence so streamed tokens share a markdown
  // message. Join once, keeping projection linear even for long replies.
  for (const { update, chunkCount } of coalesceAgentTextChunks(updates)) {
    if (update.sessionUpdate !== 'agent_thought_chunk') {
      collectMessages();
      reasoningSequenceOpen = false;
    }

    if (update.sessionUpdate === 'user_message_chunk') {
      state = appendUserMessage(state, update, order);
      collectMessages();
      order += 1;
      continue;
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
    order += chunkCount - 1;
    if (update.sessionUpdate !== 'agent_thought_chunk') {
      collectMessages();
    }
  }
  collectMessages();

  return messages.map((message, index) => ({
    ...message,
    id: `subagent-message-${message.order}-${index}`,
    timestamp: TRANSCRIPT_FALLBACK_TIMESTAMP,
  }));
}
