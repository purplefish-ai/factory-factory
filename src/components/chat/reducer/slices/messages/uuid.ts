import { debugLog } from '../../helpers';
import type { ChatAction, ChatState } from '../../types';

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
        const newMap = new Map(state.messageIdToUuid);
        newMap.set(targetMessage.id, action.payload.uuid);
        return {
          ...state,
          messageIdToUuid: newMap,
        };
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
