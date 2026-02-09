import { createLogger } from '@/backend/services/logger.service';
import { SessionHydrator } from '@/backend/services/session-store/session-hydrator';
import { handleProcessExit } from '@/backend/services/session-store/session-process-exit';
import { SessionPublisher } from '@/backend/services/session-store/session-publisher';
import {
  clearPendingInteractiveRequest,
  clearPendingInteractiveRequestIfMatches,
  clearQueuedWork,
  dequeueNext,
  enqueueMessage,
  removeQueuedMessage,
  requeueFront,
  setPendingInteractiveRequest,
} from '@/backend/services/session-store/session-queue';
import { SessionRuntimeMachine } from '@/backend/services/session-store/session-runtime-machine';
import type { SessionStore } from '@/backend/services/session-store/session-store.types';
import { SessionStoreRegistry } from '@/backend/services/session-store/session-store-registry';
import {
  appendClaudeEvent,
  commitSentUserMessageWithOrder,
  injectCommittedUserMessage,
} from '@/backend/services/session-store/session-transcript';
import type { ClaudeMessage, QueuedMessage, SessionDeltaEvent } from '@/shared/claude';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import type { SessionRuntimeState } from '@/shared/session-runtime';

const logger = createLogger('session-domain-service');

class SessionDomainService {
  private readonly registry = new SessionStoreRegistry();
  private readonly publisher = new SessionPublisher();
  private readonly nowIso = () => new Date().toISOString();
  private readonly parityLogger = this.publisher.getParityLogger();

  private readonly runtimeMachine = new SessionRuntimeMachine((sessionId, runtime) => {
    this.publisher.emitDelta(sessionId, {
      type: 'session_runtime_updated',
      sessionRuntime: runtime,
    });
  }, this.nowIso);

  private readonly hydrator = new SessionHydrator(this.nowIso, this.parityLogger);

  private transitionRuntime(
    sessionId: string,
    updates: Pick<SessionRuntimeState, 'phase' | 'processState' | 'activity'>
  ): void {
    const store = this.registry.getOrCreate(sessionId);
    this.runtimeMachine.markRuntime(store, updates);
  }

  async subscribe(options: {
    sessionId: string;
    claudeProjectPath: string | null;
    claudeSessionId: string | null;
    sessionRuntime: SessionRuntimeState;
    loadRequestId?: string;
  }): Promise<void> {
    const { sessionId, claudeProjectPath, claudeSessionId, sessionRuntime, loadRequestId } =
      options;
    const store = this.registry.getOrCreate(sessionId);
    store.lastKnownProjectPath = claudeProjectPath;
    store.lastKnownClaudeSessionId = claudeSessionId;

    await this.hydrator.ensureHydrated(store, { claudeSessionId, claudeProjectPath });

    this.runtimeMachine.markRuntime(
      store,
      {
        phase: sessionRuntime.phase,
        processState: sessionRuntime.processState,
        activity: sessionRuntime.activity,
        ...(Object.hasOwn(sessionRuntime, 'lastExit') ? { lastExit: sessionRuntime.lastExit } : {}),
        updatedAt: sessionRuntime.updatedAt,
      },
      { emitDelta: false, replace: true }
    );

    this.publisher.forwardReplayBatch(store, {
      loadRequestId,
      reason: 'subscribe_load',
      includeParitySnapshot: true,
    });

    logger.info('Session subscribed', {
      sessionId,
      sessionRuntime,
      transcriptCount: store.transcript.length,
      queueCount: store.queue.length,
    });
  }

  emitDelta(sessionId: string, event: SessionDeltaEvent): void {
    this.publisher.emitDelta(sessionId, event);
  }

  setRuntimeSnapshot(sessionId: string, runtime: SessionRuntimeState, emitDelta = true): void {
    const store = this.registry.getOrCreate(sessionId);
    this.runtimeMachine.markRuntime(
      store,
      {
        phase: runtime.phase,
        processState: runtime.processState,
        activity: runtime.activity,
        ...(Object.hasOwn(runtime, 'lastExit') ? { lastExit: runtime.lastExit } : {}),
        updatedAt: runtime.updatedAt,
      },
      { emitDelta, replace: true }
    );
  }

  getRuntimeSnapshot(sessionId: string): SessionRuntimeState {
    return { ...this.registry.getOrCreate(sessionId).runtime };
  }

  enqueue(sessionId: string, message: QueuedMessage): { position: number } | { error: string } {
    const store = this.registry.getOrCreate(sessionId);
    const result = enqueueMessage(store, message);
    if ('error' in result) {
      return result;
    }
    this.publisher.forwardSnapshot(store, { reason: 'enqueue' });
    return result;
  }

  removeQueuedMessage(sessionId: string, messageId: string): boolean {
    const store = this.registry.getOrCreate(sessionId);
    const removed = removeQueuedMessage(store, messageId);
    if (!removed) {
      return false;
    }
    this.publisher.forwardSnapshot(store, { reason: 'remove_queued_message' });
    return true;
  }

  dequeueNext(sessionId: string, options?: { emitSnapshot?: boolean }): QueuedMessage | undefined {
    const store = this.registry.getOrCreate(sessionId);
    const next = dequeueNext(store);
    if (next && options?.emitSnapshot !== false) {
      this.publisher.forwardSnapshot(store, { reason: 'dequeue' });
    }
    return next;
  }

  requeueFront(sessionId: string, message: QueuedMessage): void {
    const store = this.registry.getOrCreate(sessionId);
    requeueFront(store, message);
    this.publisher.forwardSnapshot(store, { reason: 'requeue' });
  }

  commitSentUserMessage(
    sessionId: string,
    message: QueuedMessage,
    options?: { emitSnapshot?: boolean }
  ): void {
    const store = this.registry.getOrCreate(sessionId);
    const order = store.nextOrder;
    store.nextOrder += 1;
    this.commitSentUserMessageWithOrder(store, message, order, options);
  }

  commitSentUserMessageAtOrder(
    sessionId: string,
    message: QueuedMessage,
    order: number,
    options?: { emitSnapshot?: boolean }
  ): void {
    const store = this.registry.getOrCreate(sessionId);
    this.commitSentUserMessageWithOrder(store, message, order, options);
  }

  private commitSentUserMessageWithOrder(
    store: SessionStore,
    message: QueuedMessage,
    order: number,
    options?: { emitSnapshot?: boolean }
  ): void {
    commitSentUserMessageWithOrder(store, message, order);

    if (options?.emitSnapshot !== false) {
      this.publisher.forwardSnapshot(store, { reason: 'commit_user_message' });
    }
  }

  appendClaudeEvent(sessionId: string, claudeMessage: ClaudeMessage): number {
    const store = this.registry.getOrCreate(sessionId);
    return appendClaudeEvent(store, claudeMessage, {
      nowIso: this.nowIso,
      onParityTrace: (data) => {
        this.parityLogger(sessionId, data);
      },
    });
  }

  allocateOrder(sessionId: string): number {
    const store = this.registry.getOrCreate(sessionId);
    const order = store.nextOrder;
    store.nextOrder += 1;
    return order;
  }

  setPendingInteractiveRequest(sessionId: string, request: PendingInteractiveRequest): void {
    const store = this.registry.getOrCreate(sessionId);
    setPendingInteractiveRequest(store, request);
    this.publisher.forwardSnapshot(store, { reason: 'pending_request_set' });
  }

  getPendingInteractiveRequest(sessionId: string): PendingInteractiveRequest | null {
    const store = this.registry.getOrCreate(sessionId);
    return store.pendingInteractiveRequest;
  }

  clearPendingInteractiveRequest(sessionId: string): void {
    const store = this.registry.getOrCreate(sessionId);
    if (!clearPendingInteractiveRequest(store)) {
      return;
    }
    this.publisher.forwardSnapshot(store, { reason: 'pending_request_cleared' });
  }

  clearPendingInteractiveRequestIfMatches(sessionId: string, requestId: string): void {
    const store = this.registry.getOrCreate(sessionId);
    if (!clearPendingInteractiveRequestIfMatches(store, requestId)) {
      return;
    }
    this.publisher.forwardSnapshot(store, { reason: 'pending_request_cleared' });
  }

  markProcessExit(sessionId: string, code: number | null): void {
    const store = this.registry.getOrCreate(sessionId);
    handleProcessExit({
      store,
      code,
      nowIso: this.nowIso,
      markRuntime: (targetStore, updates) => {
        this.runtimeMachine.markRuntime(targetStore, updates);
      },
      forwardSnapshot: (targetStore, options) => {
        this.publisher.forwardSnapshot(targetStore, options);
      },
      ensureHydrated: (targetStore, options) => this.hydrator.ensureHydrated(targetStore, options),
      onRehydrateError: (error) => {
        logger.warn('Failed to rehydrate transcript after process exit', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  clearQueuedWork(sessionId: string, options?: { emitSnapshot?: boolean }): void {
    const store = this.registry.getOrCreate(sessionId);
    const hadQueuedWork = clearQueuedWork(store);
    if (!hadQueuedWork || options?.emitSnapshot === false) {
      return;
    }
    this.publisher.forwardSnapshot(store, { reason: 'queue_cleared' });
  }

  markStarting(sessionId: string): void {
    this.transitionRuntime(sessionId, {
      phase: 'starting',
      processState: 'alive',
      activity: 'IDLE',
    });
  }

  markStopping(sessionId: string): void {
    const store = this.registry.getOrCreate(sessionId);
    this.transitionRuntime(sessionId, {
      phase: 'stopping',
      processState: store.runtime.processState,
      activity: store.runtime.activity,
    });
  }

  markRunning(sessionId: string): void {
    this.transitionRuntime(sessionId, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
    });
  }

  markIdle(sessionId: string, processState: 'alive' | 'stopped'): void {
    this.transitionRuntime(sessionId, {
      phase: 'idle',
      processState,
      activity: 'IDLE',
    });
  }

  markError(sessionId: string): void {
    const store = this.registry.getOrCreate(sessionId);
    this.transitionRuntime(sessionId, {
      phase: 'error',
      processState: store.runtime.processState,
      activity: store.runtime.activity,
    });
  }

  emitSessionSnapshot(sessionId: string, loadRequestId?: string): void {
    const store = this.registry.getOrCreate(sessionId);
    this.publisher.forwardSnapshot(store, {
      loadRequestId,
      reason: 'manual_emit',
      includeParitySnapshot: true,
    });
  }

  injectCommittedUserMessage(
    sessionId: string,
    text: string,
    options?: { messageId?: string }
  ): void {
    const store = this.registry.getOrCreate(sessionId);
    injectCommittedUserMessage(store, text, {
      messageId: options?.messageId,
      nowIso: this.nowIso,
      nowMs: () => Date.now(),
    });
    this.publisher.forwardSnapshot(store, { reason: 'inject_user_message' });
  }

  clearSession(sessionId: string): void {
    this.registry.clearSession(sessionId);
  }

  clearAllSessions(): void {
    this.registry.clearAllSessions();
  }

  getAllPendingRequests(): Map<string, PendingInteractiveRequest> {
    return this.registry.getAllPendingRequests();
  }

  getQueueLength(sessionId: string): number {
    return this.registry.getQueueLength(sessionId);
  }
}

export const sessionDomainService = new SessionDomainService();
