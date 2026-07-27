import {
  applyRendererMessages,
  generateMessageId,
  handleAssistantTextDelta,
  handleClaudeMessage,
} from '@/client/features/chat/reducer/helpers';
import type { ChatAction, ChatState } from '@/client/features/chat/reducer/types';
import type { AgentMessage, ChatMessage } from '@/lib/chat-protocol';

const ERROR_MESSAGE_ORDER = -1;

export function reduceMessageTransportSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'WS_AGENT_MESSAGE':
      return handleClaudeMessage(
        state,
        action.payload.message,
        action.payload.order,
        action.payload.messageId
      );
    case 'WS_ASSISTANT_TEXT_DELTA':
      return handleAssistantTextDelta(state, action.payload);
    case 'WS_ERROR': {
      const errorMsg: AgentMessage = {
        type: 'error',
        error: action.payload.message,
        timestamp: new Date().toISOString(),
      };
      const errorChatMessage: ChatMessage = {
        id: generateMessageId(),
        source: 'agent',
        message: errorMsg,
        timestamp: new Date().toISOString(),
        order: ERROR_MESSAGE_ORDER,
      };
      // Clear loading state if error occurs while loading (e.g., load_session fails)
      const sessionStatus =
        state.sessionStatus.phase === 'loading' ? { phase: 'ready' as const } : state.sessionStatus;
      return applyRendererMessages(
        {
          ...state,
          sessionStatus,
        },
        [...state.messages, errorChatMessage]
      );
    }
    default:
      return state;
  }
}
