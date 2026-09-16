import {
  applyRendererMessages,
  insertMessageByOrder,
} from '@/client/features/chat/reducer/helpers';
import type { ChatAction, ChatState } from '@/client/features/chat/reducer/types';
import type { ChatMessage } from '@/lib/chat-protocol';

export function reduceMessageQueueSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
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
    case 'MESSAGE_USED_AS_RESPONSE': {
      const pendingContent = state.pendingMessages.get(action.payload.id);
      const newPendingMessages = new Map(state.pendingMessages);
      newPendingMessages.delete(action.payload.id);

      if (state.messages.some((m) => m.id === action.payload.id)) {
        return {
          ...state,
          pendingMessages: newPendingMessages,
          pendingRequest: { type: 'none' },
        };
      }

      const userMessage: ChatMessage = {
        id: action.payload.id,
        source: 'user',
        text: action.payload.text,
        timestamp: new Date().toISOString(),
        attachments: pendingContent?.attachments,
        order: action.payload.order,
      };

      return {
        ...applyRendererMessages(state, insertMessageByOrder(state.messages, userMessage)),
        pendingMessages: newPendingMessages,
        pendingRequest: { type: 'none' },
      };
    }
    default:
      return state;
  }
}
