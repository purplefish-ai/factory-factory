import type { ChatMessage } from '@/lib/claude-types';
import { MessageState, QUEUED_MESSAGE_ORDER_BASE } from '@/lib/claude-types';
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
  const { id, newState, userMessage, errorMessage, queuePosition } = payload;

  switch (newState) {
    case MessageState.ACCEPTED:
      return userMessage ? handleAcceptedState(state, id, userMessage, queuePosition) : state;
    case MessageState.DISPATCHED:
      return userMessage
        ? handleDispatchedState(state, id, userMessage)
        : handleRemoveFromQueue(state, id);
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
  >,
  queuePosition?: number
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
    // Order is undefined for queued messages - use a large base value plus queuePosition
    // to ensure they appear at the end in queue order until dispatched with real order
    // Using 1 billion as base to leave room for real messages before queued messages
    order: userMessage.order ?? QUEUED_MESSAGE_ORDER_BASE + (queuePosition ?? 0),
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
  // Replay hydration reuses ACCEPTED transitions to reconstruct UI state. Those
  // messages are historical and must not be treated as locally-sent in this tab.
  if (state.sessionStatus.phase !== 'loading') {
    newLocalUserMessageIds.add(id);
  }

  let newMessageIdToUuid = state.messageIdToUuid;
  let newPendingUuids = state.pendingUserMessageUuids;
  if (state.pendingUserMessageUuids.length > 0) {
    const [uuid, ...remainingUuids] = state.pendingUserMessageUuids;
    newPendingUuids = remainingUuids;
    if (uuid) {
      newMessageIdToUuid = new Map(state.messageIdToUuid);
      newMessageIdToUuid.set(id, uuid);
    }
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

function handleDispatchedState(
  state: ChatState,
  id: string,
  userMessage: Extract<
    Extract<ChatAction, { type: 'MESSAGE_STATE_CHANGED' }>['payload']['userMessage'],
    object
  >
): ChatState {
  // Remove from queue styling
  const newQueuedMessages = new Map(state.queuedMessages);
  newQueuedMessages.delete(id);

  // DISPATCHED messages must have an order assigned
  if (userMessage.order === undefined) {
    return { ...state, queuedMessages: newQueuedMessages };
  }

  // Find the existing message and update its order
  const existingMessageIndex = state.messages.findIndex((m) => m.id === id);
  if (existingMessageIndex === -1) {
    // Message not found in transcript yet - shouldn't happen but handle gracefully
    return { ...state, queuedMessages: newQueuedMessages };
  }

  // Update the message with the new order and re-insert at correct position
  const existingMessage = state.messages[existingMessageIndex];
  if (!existingMessage) {
    return { ...state, queuedMessages: newQueuedMessages };
  }

  const updatedMessage: ChatMessage = {
    ...existingMessage,
    order: userMessage.order,
  };

  // Remove old message and insert at new position based on order
  const messagesWithoutOld = [
    ...state.messages.slice(0, existingMessageIndex),
    ...state.messages.slice(existingMessageIndex + 1),
  ];
  const newMessages = insertMessageByOrder(messagesWithoutOld, updatedMessage);

  return {
    ...state,
    messages: newMessages,
    queuedMessages: newQueuedMessages,
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
