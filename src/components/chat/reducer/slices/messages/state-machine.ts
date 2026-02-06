import type { ChatMessage } from '@/lib/claude-types';
import { MessageState } from '@/lib/claude-types';
import { debugLog, insertMessageByOrder } from '../../helpers';
import type { ChatAction, ChatState } from '../../types';

export function reduceMessageStateMachineSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'MESSAGE_STATE_CHANGED':
      return applyMessageStateChange(state, action.payload);
    default:
      return state;
  }
}

function applyMessageStateChange(
  state: ChatState,
  payload: Extract<ChatAction, { type: 'MESSAGE_STATE_CHANGED' }>['payload']
): ChatState {
  const { id, newState, userMessage, errorMessage } = payload;

  switch (newState) {
    case MessageState.ACCEPTED:
      return userMessage ? handleAcceptedState(state, id, userMessage) : state;
    case MessageState.DISPATCHED:
    case MessageState.COMMITTED:
    case MessageState.COMPLETE:
      return handleRemoveFromQueue(state, id);
    case MessageState.CANCELLED:
      return handleCancelledState(state, id);
    case MessageState.REJECTED:
    case MessageState.FAILED:
      return handleRejectedOrFailedState(state, id, errorMessage);
    default:
      debugLog(`[chat-reducer] Ignoring state transition to ${newState} for message ${id}`);
      return state;
  }
}

function handleAcceptedState(
  state: ChatState,
  id: string,
  userMessage: Extract<
    Extract<ChatAction, { type: 'MESSAGE_STATE_CHANGED' }>['payload']['userMessage'],
    object
  >
): ChatState {
  const newPendingMessages = new Map(state.pendingMessages);
  newPendingMessages.delete(id);

  if (state.messages.some((m) => m.id === id)) {
    const newQueuedMessages = new Map(state.queuedMessages);
    newQueuedMessages.set(id, {
      id,
      text: userMessage.text,
      timestamp: userMessage.timestamp,
      attachments: userMessage.attachments,
      settings: userMessage.settings ?? {
        selectedModel: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    return {
      ...state,
      queuedMessages: newQueuedMessages,
      pendingMessages: newPendingMessages,
    };
  }

  const newMessage: ChatMessage = {
    id,
    source: 'user',
    text: userMessage.text,
    timestamp: userMessage.timestamp,
    attachments: userMessage.attachments,
    order: userMessage.order,
  };

  const newQueuedMessages = new Map(state.queuedMessages);
  newQueuedMessages.set(id, {
    id,
    text: userMessage.text,
    timestamp: userMessage.timestamp,
    attachments: userMessage.attachments,
    settings: userMessage.settings ?? {
      selectedModel: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  });

  const newLocalUserMessageIds = new Set(state.localUserMessageIds);
  newLocalUserMessageIds.add(id);

  let newMessageIdToUuid = state.messageIdToUuid;
  let newPendingUuids = state.pendingUserMessageUuids;
  if (state.pendingUserMessageUuids.length > 0) {
    const [uuid, ...remainingUuids] = state.pendingUserMessageUuids;
    newMessageIdToUuid = new Map(state.messageIdToUuid);
    // biome-ignore lint/style/noNonNullAssertion: destructured from non-empty array (length > 0 checked)
    newMessageIdToUuid.set(id, uuid!);
    newPendingUuids = remainingUuids;
  }

  return {
    ...state,
    messages: insertMessageByOrder(state.messages, newMessage),
    queuedMessages: newQueuedMessages,
    pendingMessages: newPendingMessages,
    messageIdToUuid: newMessageIdToUuid,
    pendingUserMessageUuids: newPendingUuids,
    localUserMessageIds: newLocalUserMessageIds,
  };
}

function handleRemoveFromQueue(state: ChatState, id: string): ChatState {
  const newQueuedMessages = new Map(state.queuedMessages);
  newQueuedMessages.delete(id);
  return { ...state, queuedMessages: newQueuedMessages };
}

function handleCancelledState(state: ChatState, id: string): ChatState {
  const newQueuedMessages = new Map(state.queuedMessages);
  newQueuedMessages.delete(id);
  return {
    ...state,
    messages: state.messages.filter((m) => m.id !== id),
    queuedMessages: newQueuedMessages,
  };
}

function handleRejectedOrFailedState(
  state: ChatState,
  id: string,
  errorMessage?: string
): ChatState {
  const queuedMessage = state.queuedMessages.get(id);
  const pendingContent = state.pendingMessages.get(id);
  const recoveryContent = queuedMessage ?? pendingContent;

  const newQueuedMessages = new Map(state.queuedMessages);
  newQueuedMessages.delete(id);

  const newPendingMessages = new Map(state.pendingMessages);
  newPendingMessages.delete(id);

  return {
    ...state,
    messages: state.messages.filter((m) => m.id !== id),
    queuedMessages: newQueuedMessages,
    pendingMessages: newPendingMessages,
    lastRejectedMessage: recoveryContent
      ? {
          text: queuedMessage?.text ?? pendingContent?.text ?? '',
          attachments: recoveryContent.attachments,
          error: errorMessage ?? 'Message failed',
        }
      : null,
  };
}
