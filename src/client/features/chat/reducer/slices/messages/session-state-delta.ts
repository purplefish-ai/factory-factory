import {
  applyRendererMessages,
  convertPendingRequest,
  insertMessageByOrder,
} from '@/client/features/chat/reducer/helpers';
import type {
  ChatAction,
  ChatState,
  PendingMessageContent,
  RecoverableQueuedMessage,
} from '@/client/features/chat/reducer/types';
import type { ChatMessage, MessageAttachment, QueuedMessage } from '@/lib/chat-protocol';
import { QUEUED_MESSAGE_ORDER_BASE } from '@/lib/chat-protocol';

/**
 * Applies targeted session-state deltas. Each reproduces the queue, transcript
 * entry, or pending request a full `session_snapshot` would have carried, while
 * leaving the rest of the transcript (and local-only state) untouched.
 */
export function reduceSessionStateDeltaSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'QUEUE_UPDATED':
      return applyQueue(state, action.payload.queuedMessages);
    case 'TRANSCRIPT_MESSAGE_COMMITTED':
      return applyCommittedMessage(
        applyQueue(state, action.payload.queuedMessages),
        action.payload.message
      );
    case 'PENDING_REQUEST_UPDATED': {
      const pendingRequest = convertPendingRequest(action.payload.pendingInteractiveRequest);
      if (pendingRequest.type === 'none' && state.pendingRequest.type === 'none') {
        return state;
      }
      return { ...state, pendingRequest };
    }
    default:
      return state;
  }
}

function isQueuedPlaceholder(message: ChatMessage): boolean {
  return message.source === 'user' && message.order >= QUEUED_MESSAGE_ORDER_BASE;
}

function sameAttachments(
  left: MessageAttachment[] | undefined,
  right: MessageAttachment[] | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!(left && right) || left.length !== right.length) {
    return false;
  }
  return left.every((attachment, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      attachment.id === other.id &&
      attachment.size === other.size &&
      attachment.data === other.data
    );
  });
}

/** True when a user transcript entry already renders exactly as `next`. */
function isSameUserMessage(existing: ChatMessage | undefined, next: ChatMessage): boolean {
  return (
    existing !== undefined &&
    existing.source === 'user' &&
    next.source === 'user' &&
    existing.message === undefined &&
    next.message === undefined &&
    existing.id === next.id &&
    existing.order === next.order &&
    existing.text === next.text &&
    existing.timestamp === next.timestamp &&
    sameAttachments(existing.attachments, next.attachments)
  );
}

function withoutPendingIds(
  pendingMessages: Map<string, PendingMessageContent>,
  ids: Iterable<string>
): Map<string, PendingMessageContent> {
  let next = pendingMessages;
  for (const id of ids) {
    if (next.has(id)) {
      if (next === pendingMessages) {
        next = new Map(pendingMessages);
      }
      next.delete(id);
    }
  }
  return next;
}

function sameMessageList(left: ChatMessage[], right: ChatMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

/** Replace the queue and its transcript placeholders, as a snapshot would. */
function applyQueue(state: ChatState, queue: QueuedMessage[]): ChatState {
  const queuedIds = new Set(queue.map((queued) => queued.id));
  const queuedMessages = new Map<string, RecoverableQueuedMessage>();
  for (const queued of queue) {
    // Keep this tab's composer session for rejection recovery.
    const sessionId =
      state.queuedMessages.get(queued.id)?.sessionId ??
      state.pendingMessages.get(queued.id)?.sessionId;
    queuedMessages.set(queued.id, sessionId === undefined ? queued : { ...queued, sessionId });
  }

  const existingById = new Map(
    state.messages.filter((message) => queuedIds.has(message.id)).map((m) => [m.id, m] as const)
  );
  let messages = state.messages.filter(
    (message) => !(queuedIds.has(message.id) || isQueuedPlaceholder(message))
  );
  queue.forEach((queued, index) => {
    const placeholder: ChatMessage = {
      id: queued.id,
      source: 'user',
      text: queued.text,
      attachments: queued.attachments,
      timestamp: queued.timestamp,
      order: QUEUED_MESSAGE_ORDER_BASE + index,
    };
    const existing = existingById.get(queued.id);
    messages = insertMessageByOrder(
      messages,
      isSameUserMessage(existing, placeholder) && existing ? existing : placeholder
    );
  });

  const nextState: ChatState = {
    ...state,
    queuedMessages,
    pendingMessages: withoutPendingIds(state.pendingMessages, queuedIds),
  };
  return sameMessageList(state.messages, messages)
    ? nextState
    : applyRendererMessages(nextState, messages);
}

/** Upsert one committed transcript entry by id, as a snapshot would. */
function applyCommittedMessage(state: ChatState, message: ChatMessage): ChatState {
  const pendingMessages = withoutPendingIds(state.pendingMessages, [message.id]);
  const nextState: ChatState = {
    ...state,
    pendingMessages,
    // A committed user message starts a new turn; drop the previous turn's preview.
    ...(message.source === 'user' ? { latestThinking: null, latestThinkingDeltaOrder: null } : {}),
  };
  const existingIndex = state.messages.findIndex((entry) => entry.id === message.id);
  if (existingIndex >= 0 && isSameUserMessage(state.messages[existingIndex], message)) {
    return nextState;
  }
  const withoutExisting =
    existingIndex >= 0 ? state.messages.filter((entry) => entry.id !== message.id) : state.messages;
  return applyRendererMessages(nextState, insertMessageByOrder(withoutExisting, message));
}
