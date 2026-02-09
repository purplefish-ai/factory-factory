import type { ClaudeMessage, QueuedMessage, SessionDeltaEvent } from '@/shared/claude';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import type { ConnectionInfo } from './chat-connection.service';
import { chatConnectionService } from './chat-connection.service';
import { createLogger } from './logger.service';
import { SessionHydrator } from './session-store/session-hydrator';
import { SessionPublisher } from './session-store/session-publisher';
import {
  clearPendingInteractiveRequest,
  clearPendingInteractiveRequestIfMatches,
  clearQueuedWork,
  dequeueNext,
  enqueueMessage,
  removeQueuedMessage,
  requeueFront,
  setPendingInteractiveRequest,
} from './session-store/session-queue';
import { SessionRuntimeMachine } from './session-store/session-runtime-machine';
import { SessionStoreRegistry } from './session-store/session-store-registry';
import {
  appendClaudeEvent,
  commitSentUserMessageWithOrder,
  injectCommittedUserMessage,
} from './session-store/session-transcript';

const logger = createLogger('session-store-service');

class SessionStoreService {
  private readonly registry = new SessionStoreRegistry();
  private readonly publisher = new SessionPublisher();
  private readonly runtimeMachine = new SessionRuntimeMachine(
    (sessionId, runtime) => {
      this.publisher.emitDelta(sessionId, {
        type: 'session_runtime_updated',
        sessionRuntime: runtime,
      });
    },
    () => new Date().toISOString()
  );
  private readonly hydrator = new SessionHydrator(
    () => new Date().toISOString(),
    this.publisher.getParityLogger()
  );

  private logParityTrace(sessionId: string, data: Record<string, unknown>): void {
    this.publisher.getParityLogger()(sessionId, data);
  }

  emitDelta(sessionId: string, event: SessionDeltaEvent): void {
    this.publisher.emitDelta(sessionId, event);
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
    commitSentUserMessageWithOrder(store, message, order);

    if (options?.emitSnapshot !== false) {
      this.publisher.forwardSnapshot(store, { reason: 'commit_user_message' });
    }
  }

  commitSentUserMessageAtOrder(
    sessionId: string,
    message: QueuedMessage,
    order: number,
    options?: { emitSnapshot?: boolean }
  ): void {
    const store = this.registry.getOrCreate(sessionId);
    commitSentUserMessageWithOrder(store, message, order);

    if (options?.emitSnapshot !== false) {
      this.publisher.forwardSnapshot(store, { reason: 'commit_user_message' });
    }
  }

  appendClaudeEvent(sessionId: string, claudeMessage: ClaudeMessage): number {
    const store = this.registry.getOrCreate(sessionId);
    return appendClaudeEvent(store, claudeMessage, {
      nowIso: () => new Date().toISOString(),
      onParityTrace: (data) => {
        this.logParityTrace(sessionId, data);
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

  markStarting(sessionId: string): void {
    const store = this.registry.getOrCreate(sessionId);
    this.runtimeMachine.markRuntime(store, {
      phase: 'starting',
      processState: 'alive',
      activity: 'IDLE',
    });
  }

  markStopping(sessionId: string): void {
    const store = this.registry.getOrCreate(sessionId);
    this.runtimeMachine.markRuntime(store, {
      phase: 'stopping',
      processState: store.runtime.processState,
      activity: store.runtime.activity,
    });
  }

  markRunning(sessionId: string): void {
    const store = this.registry.getOrCreate(sessionId);
    this.runtimeMachine.markRuntime(store, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
    });
  }

  markIdle(sessionId: string, processState: 'alive' | 'stopped'): void {
    const store = this.registry.getOrCreate(sessionId);
    this.runtimeMachine.markRuntime(store, {
      phase: 'idle',
      processState,
      activity: 'IDLE',
    });
  }

  markError(sessionId: string): void {
    const store = this.registry.getOrCreate(sessionId);
    this.runtimeMachine.markRuntime(store, {
      phase: 'error',
      processState: store.runtime.processState,
      activity: store.runtime.activity,
    });
  }

  markProcessExit(sessionId: string, code: number | null): void {
    const store = this.registry.getOrCreate(sessionId);
    const unexpected = code === null || code !== 0;

    store.queue = [];
    store.pendingInteractiveRequest = null;
    store.transcript = [];
    store.nextOrder = 0;
    store.initialized = false;
    store.hydratedKey = null;
    store.hydrateGeneration += 1;
    store.hydratePromise = null;

    this.runtimeMachine.markRuntime(store, {
      phase: unexpected ? 'error' : 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      lastExit: {
        code,
        timestamp: new Date().toISOString(),
        unexpected,
      },
    });

    this.publisher.forwardSnapshot(store, {
      reason: 'process_exit_reset',
      includeParitySnapshot: true,
    });

    const { lastKnownClaudeSessionId, lastKnownProjectPath } = store;
    if (lastKnownClaudeSessionId && lastKnownProjectPath) {
      void this.hydrator
        .ensureHydrated(store, {
          claudeSessionId: lastKnownClaudeSessionId,
          claudeProjectPath: lastKnownProjectPath,
        })
        .then(() => {
          this.publisher.forwardSnapshot(store, {
            reason: 'process_exit_rehydrate',
            includeParitySnapshot: true,
          });
        })
        .catch((error) => {
          logger.warn('Failed to rehydrate transcript after process exit', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  clearQueuedWork(sessionId: string, options?: { emitSnapshot?: boolean }): void {
    const store = this.registry.getOrCreate(sessionId);
    const hadQueuedWork = clearQueuedWork(store);
    if (!hadQueuedWork || options?.emitSnapshot === false) {
      return;
    }
    this.publisher.forwardSnapshot(store, { reason: 'queue_cleared' });
  }

  getRuntimeSnapshot(sessionId: string): SessionRuntimeState {
    return { ...this.registry.getOrCreate(sessionId).runtime };
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
      nowIso: () => new Date().toISOString(),
      nowMs: () => Date.now(),
    });
    this.publisher.forwardSnapshot(store, { reason: 'inject_user_message' });
  }

  getConnectionCount(sessionId: string): number {
    let count = 0;
    for (const info of chatConnectionService.values() as IterableIterator<ConnectionInfo>) {
      if (info.dbSessionId === sessionId) {
        count += 1;
      }
    }
    return count;
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

  getQueueSnapshot(sessionId: string): QueuedMessage[] {
    return this.registry.getQueueSnapshot(sessionId);
  }
}

export const sessionStoreService = new SessionStoreService();
