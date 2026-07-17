import {
  applyRendererMessages,
  generateMessageId,
  handleAssistantTextDelta,
  handleClaudeMessage,
} from '@/components/chat/reducer/helpers';
import type { ChatAction, ChatState } from '@/components/chat/reducer/types';
import type { AgentMessage, ChatMessage } from '@/lib/chat-protocol';

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
      const maxOrder = state.messages.reduce((max, m) => Math.max(max, m.order), -1);
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
        order: maxOrder + 1,
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
