import { applyRendererMessages } from '@/client/features/chat/reducer/helpers';
import type { ChatAction, ChatState } from '@/client/features/chat/reducer/types';

export function reduceMessageQueueSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'STEER_REQUESTED':
      return {
        ...state,
        pendingSteer: { messageId: action.messageId, requestId: action.requestId },
      };
    case 'STEER_SETTLED':
    case 'WS_ERROR':
      return state.pendingSteer?.requestId ===
        (action.type === 'WS_ERROR' ? action.payload.requestId : action.requestId)
        ? { ...state, pendingSteer: null }
        : state;
    case 'CONFIG_OPTIONS_DISCONNECTED':
      return { ...state, pendingSteer: null };
    case 'USER_MESSAGE_SENT':
      return applyRendererMessages(state, [...state.messages, action.payload]);
    case 'MESSAGE_SENDING': {
      const { id, text, attachments, sessionId } = action.payload;
      const newPendingMessages = new Map(state.pendingMessages);
      newPendingMessages.set(id, { text, attachments, sessionId });
      return {
        ...state,
        pendingMessages: newPendingMessages,
      };
    }
    case 'CLEAR_REJECTED_MESSAGE':
      return {
        ...state,
        lastRejectedMessage: null,
      };
    default:
      return state;
  }
}
