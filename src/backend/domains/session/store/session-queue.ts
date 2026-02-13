import { SERVICE_LIMITS } from '@/backend/services/constants';
import type { QueuedMessage } from '@/shared/claude';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import type { SessionStore } from './session-store.types';

export function enqueueMessage(
  store: SessionStore,
  message: QueuedMessage
): { position: number } | { error: string } {
  if (store.queue.length >= SERVICE_LIMITS.sessionStoreMaxQueueSize) {
    return { error: `Queue full (max ${SERVICE_LIMITS.sessionStoreMaxQueueSize} messages)` };
  }

  store.queue.push(message);
  return { position: store.queue.length - 1 };
}

export function removeQueuedMessage(store: SessionStore, messageId: string): boolean {
  const idx = store.queue.findIndex((message) => message.id === messageId);
  if (idx < 0) {
    return false;
  }
  store.queue.splice(idx, 1);
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
  store.queue = [];
  store.pendingInteractiveRequest = null;
  return hadQueuedWork;
}
