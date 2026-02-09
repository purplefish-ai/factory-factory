import { sessionStoreService } from '@/backend/services/session-store.service';
import type { ClaudeMessage, QueuedMessage, SessionDeltaEvent } from '@/shared/claude';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import type { SessionRuntimeState } from '@/shared/session-runtime';

class SessionDomainService {
  subscribe(options: {
    sessionId: string;
    claudeProjectPath: string | null;
    claudeSessionId: string | null;
    sessionRuntime: SessionRuntimeState;
    loadRequestId?: string;
  }): Promise<void> {
    return sessionStoreService.subscribe(options);
  }

  emitDelta(sessionId: string, event: SessionDeltaEvent): void {
    sessionStoreService.emitDelta(sessionId, event);
  }

  setRuntimeSnapshot(sessionId: string, runtime: SessionRuntimeState, emitDelta = true): void {
    sessionStoreService.setRuntimeSnapshot(sessionId, runtime, emitDelta);
  }

  getRuntimeSnapshot(sessionId: string): SessionRuntimeState {
    return sessionStoreService.getRuntimeSnapshot(sessionId);
  }

  enqueue(sessionId: string, message: QueuedMessage): { position: number } | { error: string } {
    return sessionStoreService.enqueue(sessionId, message);
  }

  removeQueuedMessage(sessionId: string, messageId: string): boolean {
    return sessionStoreService.removeQueuedMessage(sessionId, messageId);
  }

  dequeueNext(sessionId: string, options?: { emitSnapshot?: boolean }): QueuedMessage | undefined {
    return sessionStoreService.dequeueNext(sessionId, options);
  }

  requeueFront(sessionId: string, message: QueuedMessage): void {
    sessionStoreService.requeueFront(sessionId, message);
  }

  commitSentUserMessageAtOrder(
    sessionId: string,
    message: QueuedMessage,
    order: number,
    options?: { emitSnapshot?: boolean }
  ): void {
    sessionStoreService.commitSentUserMessageAtOrder(sessionId, message, order, options);
  }

  appendClaudeEvent(sessionId: string, claudeMessage: ClaudeMessage): number {
    return sessionStoreService.appendClaudeEvent(sessionId, claudeMessage);
  }

  allocateOrder(sessionId: string): number {
    return sessionStoreService.allocateOrder(sessionId);
  }

  setPendingInteractiveRequest(sessionId: string, request: PendingInteractiveRequest): void {
    sessionStoreService.setPendingInteractiveRequest(sessionId, request);
  }

  getPendingInteractiveRequest(sessionId: string): PendingInteractiveRequest | null {
    return sessionStoreService.getPendingInteractiveRequest(sessionId);
  }

  clearPendingInteractiveRequest(sessionId: string): void {
    sessionStoreService.clearPendingInteractiveRequest(sessionId);
  }

  clearPendingInteractiveRequestIfMatches(sessionId: string, requestId: string): void {
    sessionStoreService.clearPendingInteractiveRequestIfMatches(sessionId, requestId);
  }

  markProcessExit(sessionId: string, code: number | null): void {
    sessionStoreService.markProcessExit(sessionId, code);
  }

  clearQueuedWork(sessionId: string, options?: { emitSnapshot?: boolean }): void {
    sessionStoreService.clearQueuedWork(sessionId, options);
  }

  markStarting(sessionId: string): void {
    sessionStoreService.markStarting(sessionId);
  }

  markStopping(sessionId: string): void {
    sessionStoreService.markStopping(sessionId);
  }

  markRunning(sessionId: string): void {
    sessionStoreService.markRunning(sessionId);
  }

  markIdle(sessionId: string, processState: 'alive' | 'stopped'): void {
    sessionStoreService.markIdle(sessionId, processState);
  }

  markError(sessionId: string): void {
    sessionStoreService.markError(sessionId);
  }

  injectCommittedUserMessage(
    sessionId: string,
    text: string,
    options?: { messageId?: string }
  ): void {
    sessionStoreService.injectCommittedUserMessage(sessionId, text, options);
  }

  clearSession(sessionId: string): void {
    sessionStoreService.clearSession(sessionId);
  }

  getAllPendingRequests(): Map<string, PendingInteractiveRequest> {
    return sessionStoreService.getAllPendingRequests();
  }

  getQueueLength(sessionId: string): number {
    return sessionStoreService.getQueueLength(sessionId);
  }
}

export const sessionDomainService = new SessionDomainService();
