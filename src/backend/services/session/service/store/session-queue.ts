import { SERVICE_LIMITS } from '@/backend/services/constants';
import type { QueuedMessage } from '@/shared/acp-protocol';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import { PR_EVENT_MESSAGE_ID_PREFIX } from '@/shared/pr-monitoring';
import { WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX } from '@/shared/workspace-notifications';
import { recordPRUpdateOutcome } from './session-pr-update';
import type { SessionStore } from './session-store.types';
import { removeTranscriptMessageById } from './session-transcript';

export function enqueueMessage(
  store: SessionStore,
  message: QueuedMessage,
  options?: { restoreAccepted?: boolean }
): { position: number } | { error: string } {
  const existing = store.queue.findIndex((item) => item.id === message.id);
  if (existing >= 0) {
    return { position: existing };
  }
  if (!options?.restoreAccepted && store.queue.length >= SERVICE_LIMITS.sessionStoreMaxQueueSize) {
    return { error: `Queue full (max ${SERVICE_LIMITS.sessionStoreMaxQueueSize} messages)` };
  }

  const prior = store.transcript.find((entry) => entry.id === message.id);
  if (message.source && prior?.message?.prDeliveryState) {
    removeTranscriptMessageById(store, message.id);
  }
  const firstBackground = store.queue.findIndex(isExternalQueuedMessage);
  if (!isExternalQueuedMessage(message) && firstBackground >= 0) {
    store.queue.splice(firstBackground, 0, message);
    return { position: firstBackground };
  }
  store.queue.push(message);
  return { position: store.queue.length - 1 };
}

export function removeQueuedMessage(
  store: SessionStore,
  messageId: string,
  options?: { recordCancellation?: boolean; expectedMessage?: QueuedMessage }
): boolean {
  const idx = store.queue.findIndex((message) => message.id === messageId);
  if (idx < 0 || (options?.expectedMessage && store.queue[idx] !== options.expectedMessage)) {
    return false;
  }
  const [message] = store.queue.splice(idx, 1);
  if (options?.recordCancellation !== false && message?.source?.type === 'pr_event') {
    recordPRUpdateOutcome(store, message, 'cancelled');
  }
  return true;
}

export function peekNext(store: SessionStore): QueuedMessage | undefined {
  return store.queue[0];
}

export function dequeueNext(store: SessionStore): QueuedMessage | undefined {
  return store.queue.shift();
}

export function requeueFront(store: SessionStore, message: QueuedMessage): void {
  store.queue.unshift(message);
}

export function setPendingInteractiveRequest(
  store: SessionStore,
  request: PendingInteractiveRequest
): void {
  store.pendingInteractiveRequest = request;
}

export function clearPendingInteractiveRequest(store: SessionStore): boolean {
  if (!store.pendingInteractiveRequest) {
    return false;
  }
  store.pendingInteractiveRequest = null;
  return true;
}

export function clearPendingInteractiveRequestIfMatches(
  store: SessionStore,
  requestId: string
): boolean {
  if (store.pendingInteractiveRequest?.requestId !== requestId) {
    return false;
  }
  store.pendingInteractiveRequest = null;
  return true;
}

export function clearQueuedWork(store: SessionStore): boolean {
  const hadQueuedWork = store.queue.length > 0 || store.pendingInteractiveRequest !== null;
  for (const message of store.queue) {
    if (message.source?.type === 'pr_event') {
      recordPRUpdateOutcome(store, message, 'cancelled');
    }
  }
  store.queue = [];
  store.pendingInteractiveRequest = null;
  return hadQueuedWork;
}

/** Reserved external identities must not take priority over accepted human input. */
export function isExternalQueuedMessage(message: QueuedMessage): boolean {
  return (
    Boolean(message.source) ||
    message.id.startsWith(PR_EVENT_MESSAGE_ID_PREFIX) ||
    message.id.startsWith(WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX)
  );
}

/** Repair retained queue order without cloning messages or changing external ownership. */
export function prioritizeQueuedHumanMessages(store: SessionStore): boolean {
  const humans = store.queue.filter((message) => !isExternalQueuedMessage(message));
  const external = store.queue.filter(isExternalQueuedMessage);
  const ordered = [...humans, ...external];
  if (ordered.every((message, index) => message === store.queue[index])) {
    return false;
  }
  store.queue = ordered;
  return true;
}
