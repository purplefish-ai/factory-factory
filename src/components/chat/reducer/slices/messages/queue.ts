import { insertMessageByOrder } from '@/components/chat/reducer/helpers';
import type { ChatAction, ChatState } from '@/components/chat/reducer/types';
import type { ChatMessage } from '@/lib/claude-types';

export function reduceMessageQueueSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'USER_MESSAGE_SENT':
      return { ...state, messages: [...state.messages, action.payload] };
    case 'ADD_TO_QUEUE': {
      const newQueuedMessages = new Map(state.queuedMessages);
      newQueuedMessages.set(action.payload.id, action.payload);
      return {
        ...state,
        queuedMessages: newQueuedMessages,
      };
    }
    case 'MESSAGE_SENDING': {
      const { id, text, attachments } = action.payload;
      const newPendingMessages = new Map(state.pendingMessages);
      newPendingMessages.set(id, { text, attachments });
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
        ...state,
        messages: insertMessageByOrder(state.messages, userMessage),
        pendingMessages: newPendingMessages,
        pendingRequest: { type: 'none' },
      };
    }
    default:
      return state;
  }
}
