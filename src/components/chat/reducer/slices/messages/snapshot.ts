import { convertPendingRequest } from '../../helpers';
import type { ChatAction, ChatState, PendingMessageContent } from '../../types';

export function reduceMessageSnapshotSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'MESSAGES_SNAPSHOT': {
      const snapshotMessages = action.payload.messages;
      const snapshotIds = new Set(snapshotMessages.map((m) => m.id));
      const newPendingMessages = new Map<string, PendingMessageContent>();
      for (const [id, content] of state.pendingMessages) {
        if (!snapshotIds.has(id)) {
          newPendingMessages.set(id, content);
        }
      }

      const pendingRequest = convertPendingRequest(action.payload.pendingInteractiveRequest);

      return {
        ...state,
        messages: snapshotMessages,
        queuedMessages: new Map(),
        pendingRequest,
        toolUseIdToIndex: new Map(),
        pendingMessages: newPendingMessages,
        lastRejectedMessage: null,
        messageIdToUuid: new Map(),
        pendingUserMessageUuids: [],
        localUserMessageIds: new Set(),
        rewindPreview: null,
      };
    }
    default:
      return state;
  }
}
