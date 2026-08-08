import { isWebSocketMessage } from '@/lib/chat-protocol';
import {
  AcpEventTranslator,
  type AcpTranslationLogger,
  type ChatMessage,
  type SessionDeltaEvent,
  type SubagentTranscriptUpdate,
} from '@/shared/acp-protocol';
import { chatReducer, createActionFromWebSocketMessage, createInitialChatState } from './reducer';

const TRANSCRIPT_FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

const transcriptLogger: AcpTranslationLogger = {
  warn: () => undefined,
};

function readTextContent(
  update: Extract<SubagentTranscriptUpdate, { sessionUpdate: 'user_message_chunk' }>
): string | null {
  return update.content.type === 'text' ? update.content.text : null;
}

export function projectAcpTranscriptUpdates(updates: SubagentTranscriptUpdate[]): ChatMessage[] {
  const translator = new AcpEventTranslator(transcriptLogger);
  let state = createInitialChatState({ sessionStatus: { phase: 'ready' } });
  let order = 0;

  for (const update of updates) {
    if (update.sessionUpdate === 'user_message_chunk') {
      const text = readTextContent(update);
      if (text !== null) {
        const message: ChatMessage = {
          id: `subagent-user-${order}`,
          source: 'user',
          text,
          timestamp: TRANSCRIPT_FALLBACK_TIMESTAMP,
          order,
        };
        state = chatReducer(state, { type: 'USER_MESSAGE_SENT', payload: message });
      }
      order += 1;
      continue;
    }

    for (const delta of translator.translateSessionUpdate(update)) {
      const message: SessionDeltaEvent = {
        ...delta,
        order,
        messageId: `subagent-event-${order}`,
      };
      if (isWebSocketMessage(message)) {
        const action = createActionFromWebSocketMessage(message);
        if (action) {
          state = chatReducer(state, action);
        }
      }
      order += 1;
    }
  }

  return state.messages.map((message, index) => ({
    ...message,
    id: `subagent-message-${message.order}-${index}`,
    timestamp: TRANSCRIPT_FALLBACK_TIMESTAMP,
  }));
}
