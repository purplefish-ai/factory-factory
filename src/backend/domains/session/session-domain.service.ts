import { sessionStoreService } from '@/backend/services/session-store.service';
import type { ChatMessage, ClaudeMessage, QueuedMessage, SessionDeltaEvent } from '@/shared/claude';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';

class SessionDomainService {
  emitDelta(sessionId: string, event: SessionDeltaEvent): void {
    sessionStoreService.emitDelta(sessionId, event);
  }

  subscribe(options: {
    sessionId: string;
    claudeProjectPath: string | null;
    claudeSessionId: string | null;
    isRunning: boolean;
    isWorking: boolean;
    loadRequestId?: string;
  }): Promise<void> {
    return sessionStoreService.subscribe(options);
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

  commitSentUserMessage(
    sessionId: string,
    message: QueuedMessage,
    options?: { emitSnapshot?: boolean }
  ): void {
    sessionStoreService.commitSentUserMessage(sessionId, message, options);
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

  markProcessExit(sessionId: string, code: number | null): void {
    sessionStoreService.markProcessExit(sessionId, code);
  }

  emitSessionSnapshot(sessionId: string, loadRequestId?: string): void {
    sessionStoreService.emitSessionSnapshot(sessionId, loadRequestId);
  }

  injectCommittedUserMessage(
    sessionId: string,
    text: string,
    options?: { messageId?: string }
  ): void {
    sessionStoreService.injectCommittedUserMessage(sessionId, text, options);
  }

  getConnectionCount(sessionId: string): number {
    return sessionStoreService.getConnectionCount(sessionId);
  }

  clearSession(sessionId: string): void {
    sessionStoreService.clearSession(sessionId);
  }

  clearAllSessions(): void {
    sessionStoreService.clearAllSessions();
  }

  getAllPendingRequests(): Map<string, PendingInteractiveRequest> {
    return sessionStoreService.getAllPendingRequests();
  }

  getQueueLength(sessionId: string): number {
    return sessionStoreService.getQueueLength(sessionId);
  }

  getQueueSnapshot(sessionId: string): QueuedMessage[] {
    return sessionStoreService.getQueueSnapshot(sessionId);
  }
}

export const sessionDomainService = new SessionDomainService();

export type { ChatMessage };
