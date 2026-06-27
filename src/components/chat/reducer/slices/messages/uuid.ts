import { debugLog } from '@/components/chat/reducer/helpers';
import type { ChatAction, ChatState } from '@/components/chat/reducer/types';

export function reduceMessageUuidSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'USER_MESSAGE_UUID_RECEIVED': {
      const unmappedUserMessages = state.messages.filter(
        (m) =>
          m.source === 'user' &&
          state.localUserMessageIds.has(m.id) &&
          !state.messageIdToUuid.has(m.id)
      );

      if (unmappedUserMessages.length > 0) {
        const targetMessage = unmappedUserMessages[0];
        if (!targetMessage) {
          return state;
        }
        const newMap = new Map(state.messageIdToUuid);
        newMap.set(targetMessage.id, action.payload.uuid);
        return {
          ...state,
          messageIdToUuid: newMap,
        };
      }

      if (state.pendingMessages.size === 0) {
        debugLog(
          `[chat-reducer] UUID received with no retained local user message, dropping: ${action.payload.uuid}`
        );
        return state.pendingUserMessageUuids.length > 0
          ? { ...state, pendingUserMessageUuids: [] }
          : state;
      }

      debugLog(
        `[chat-reducer] UUID received but no unmapped user message found, queueing: ${action.payload.uuid}`
      );
      return {
        ...state,
        pendingUserMessageUuids: [...state.pendingUserMessageUuids, action.payload.uuid],
      };
    }
    default:
      return state;
  }
}
