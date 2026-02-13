import { generateMessageId, handleClaudeMessage } from '@/components/chat/reducer/helpers';
import type { ChatAction, ChatState } from '@/components/chat/reducer/types';
import type { ChatMessage, ClaudeMessage } from '@/lib/chat-protocol';

export function reduceMessageTransportSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'WS_AGENT_MESSAGE':
      return handleClaudeMessage(state, action.payload.message, action.payload.order);
    case 'WS_ERROR': {
      const maxOrder = state.messages.reduce((max, m) => Math.max(max, m.order), -1);
      const errorMsg: ClaudeMessage = {
        type: 'error',
        error: action.payload.message,
        timestamp: new Date().toISOString(),
      };
      const errorChatMessage: ChatMessage = {
        id: generateMessageId(),
        source: 'claude',
        message: errorMsg,
        timestamp: new Date().toISOString(),
        order: maxOrder + 1,
      };
      // Clear loading state if error occurs while loading (e.g., load_session fails)
      const sessionStatus =
        state.sessionStatus.phase === 'loading' ? { phase: 'ready' as const } : state.sessionStatus;
      return {
        ...state,
        messages: [...state.messages, errorChatMessage],
        sessionStatus,
      };
    }
    default:
      return state;
  }
}
