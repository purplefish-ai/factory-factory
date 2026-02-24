import { EventEmitter } from 'node:events';
import { createLogger } from '@/backend/services/logger.service';
import type {
  AgentMessage,
  ChatMessage,
  QueuedMessage,
  SessionDeltaEvent,
} from '@/shared/acp-protocol';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { handleProcessExit } from './store/session-process-exit';
import { SessionPublisher } from './store/session-publisher';
import {
  clearPendingInteractiveRequest,
  clearPendingInteractiveRequestIfMatches,
  clearQueuedWork,
  dequeueNext,
  enqueueMessage,
  peekNext,
  removeQueuedMessage,
  requeueFront,
  setPendingInteractiveRequest,
} from './store/session-queue';
import { SessionRuntimeMachine } from './store/session-runtime-machine';
import type { SessionStore } from './store/session-store.types';
import { SessionStoreRegistry } from './store/session-store-registry';
import {
  appendClaudeEvent,
  commitSentUserMessageWithOrder,
  injectCommittedUserMessage,
  messageSort,
  removeTranscriptMessageById,
  setNextOrderFromTranscript,
  upsertTranscriptMessage,
} from './store/session-transcript';

const logger = createLogger('session-domain-service');

export class SessionDomainService extends EventEmitter {
  private readonly registry = new SessionStoreRegistry();
  private readonly publisher = new SessionPublisher();
  private readonly nowIso = () => new Date().toISOString();
  private readonly parityLogger = this.publisher.getParityLogger();

  /** In-memory store for initial messages to auto-enqueue on first load_session */
  private readonly initialMessages = new Map<string, string>();

  storeInitialMessage(sessionId: string, text: string): void {
    this.initialMessages.set(sessionId, text);
  }

  consumeInitialMessage(sessionId: string): string | null {
    const text = this.initialMessages.get(sessionId);
    if (text !== undefined) {
      this.initialMessages.delete(sessionId);
      return text;
    }
    return null;
  }

  private readonly runtimeMachine = new SessionRuntimeMachine((sessionId, runtime) => {
    this.publisher.emitDelta(sessionId, {
      type: 'session_runtime_updated',
      sessionRuntime: runtime,
    });
    this.emit('runtime_changed', {
      sessionId,
      runtime,
    });
  }, this.nowIso);

  private transitionRuntime(
    sessionId: string,
    updates: Pick<SessionRuntimeState, 'phase' | 'processState' | 'activity'> & {
      lastExit?: SessionRuntimeState['lastExit'];
      errorMessage?: SessionRuntimeState['errorMessage'];
    }
  ): void {
    const store = this.registry.getOrCreate(sessionId);
    this.runtimeMachine.markRuntime(store, updates);
  }

  subscribe(options: {
    sessionId: string;
    sessionRuntime: SessionRuntimeState;
    loadRequestId?: string;
  }): void {
    const { sessionId, sessionRuntime, loadRequestId } = options;
    const store = this.registry.getOrCreate(sessionId);
    if (!store.initialized) {
      store.initialized = true;
    }

    this.runtimeMachine.markRuntime(
      store,
      {
        phase: sessionRuntime.phase,
        processState: sessionRuntime.processState,
        activity: sessionRuntime.activity,
        ...(Object.hasOwn(sessionRuntime, 'lastExit') ? { lastExit: sessionRuntime.lastExit } : {}),
        ...(Object.hasOwn(sessionRuntime, 'errorMessage')
          ? { errorMessage: sessionRuntime.errorMessage }
          : {}),
        updatedAt: sessionRuntime.updatedAt,
      },
      { emitDelta: false, replace: true }
    );

    this.publisher.forwardReplayBatch(store, {
      loadRequestId,
      reason: 'subscribe_load',
      includeParitySnapshot: true,
    });

    // After hydration and replay, emit a delta to ensure the client transitions
    // out of 'loading' phase. If still in 'loading' after hydration (brand new session),
    // transition to 'idle'. Otherwise, emit the current runtime state.
    if (store.runtime.phase === 'loading') {
      this.runtimeMachine.markRuntime(store, {
        phase: 'idle',
        processState: store.runtime.processState,
        activity: store.runtime.activity,
      });
    } else {
      this.publisher.emitDelta(sessionId, {
        type: 'session_runtime_updated',
        sessionRuntime: store.runtime,
      });
    }

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
        ...(Object.hasOwn(runtime, 'errorMessage') ? { errorMessage: runtime.errorMessage } : {}),
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

  peekNextMessage(sessionId: string): QueuedMessage | undefined {
    const store = this.registry.getOrCreate(sessionId);
    return peekNext(store);
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

  removeTranscriptMessageById(
    sessionId: string,
    messageId: string,
    options?: { emitSnapshot?: boolean }
  ): boolean {
    const store = this.registry.getOrCreate(sessionId);
    const removed = removeTranscriptMessageById(store, messageId);
    if (!removed) {
      return false;
    }

    if (options?.emitSnapshot !== false) {
      this.publisher.forwardSnapshot(store, { reason: 'remove_transcript_message' });
    }

    return true;
  }

  appendClaudeEvent(sessionId: string, claudeMessage: AgentMessage): number {
    const store = this.registry.getOrCreate(sessionId);
    return appendClaudeEvent(store, claudeMessage, {
      nowIso: this.nowIso,
      onParityTrace: (data) => {
        this.parityLogger(sessionId, data);
      },
    });
  }

  /**
   * Upsert a Claude event at a specific order (for ACP text accumulation).
   * Creates or replaces the transcript entry at the given order.
   */
  upsertClaudeEvent(sessionId: string, claudeMessage: AgentMessage, order: number): void {
    const store = this.registry.getOrCreate(sessionId);
    upsertTranscriptMessage(store, {
      id: `${store.sessionId}-${order}`,
      source: 'agent',
      message: claudeMessage,
      timestamp: claudeMessage.timestamp ?? this.nowIso(),
      order,
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
    this.emit('pending_request_changed', {
      sessionId,
      requestId: request.requestId,
      hasPending: true,
    });
  }

  getPendingInteractiveRequest(sessionId: string): PendingInteractiveRequest | null {
    const store = this.registry.getOrCreate(sessionId);
    return store.pendingInteractiveRequest;
  }

  clearPendingInteractiveRequest(sessionId: string): void {
    const store = this.registry.getOrCreate(sessionId);
    const pendingRequest = store.pendingInteractiveRequest;
    if (!pendingRequest) {
      return;
    }

    if (!clearPendingInteractiveRequest(store)) {
      return;
    }
    this.publisher.forwardSnapshot(store, { reason: 'pending_request_cleared' });
    this.emit('pending_request_changed', {
      sessionId,
      requestId: pendingRequest.requestId,
      hasPending: false,
    });
  }

  clearPendingInteractiveRequestIfMatches(sessionId: string, requestId: string): void {
    const store = this.registry.getOrCreate(sessionId);
    if (!clearPendingInteractiveRequestIfMatches(store, requestId)) {
      return;
    }
    this.publisher.forwardSnapshot(store, { reason: 'pending_request_cleared' });
    this.emit('pending_request_changed', { sessionId, requestId, hasPending: false });
  }

  markProcessExit(sessionId: string, code: number | null): void {
    const store = this.registry.getOrCreate(sessionId);
    const pendingRequest = store.pendingInteractiveRequest;
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
    });

    if (pendingRequest) {
      this.emit('pending_request_changed', {
        sessionId,
        requestId: pendingRequest.requestId,
        hasPending: false,
      });
    }
  }

  clearQueuedWork(sessionId: string, options?: { emitSnapshot?: boolean }): void {
    const store = this.registry.getOrCreate(sessionId);
    const pendingRequest = store.pendingInteractiveRequest;
    const hadQueuedWork = clearQueuedWork(store);

    if (pendingRequest) {
      this.emit('pending_request_changed', {
        sessionId,
        requestId: pendingRequest.requestId,
        hasPending: false,
      });
    }

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

  markError(sessionId: string, errorMessage?: string): void {
    const store = this.registry.getOrCreate(sessionId);
    this.transitionRuntime(sessionId, {
      phase: 'error',
      processState: store.runtime.processState,
      activity: store.runtime.activity,
      ...(errorMessage ? { errorMessage } : {}),
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
    this.initialMessages.delete(sessionId);
    this.registry.clearSession(sessionId);
  }

  clearAllSessions(): void {
    this.initialMessages.clear();
    this.registry.clearAllSessions();
  }

  getAllPendingRequests(): Map<string, PendingInteractiveRequest> {
    return this.registry.getAllPendingRequests();
  }

  getQueueLength(sessionId: string): number {
    return this.registry.getQueueLength(sessionId);
  }

  getTranscriptSnapshot(sessionId: string): ChatMessage[] {
    const store = this.registry.getOrCreate(sessionId);
    return [...store.transcript].sort(messageSort);
  }

  isHistoryHydrated(sessionId: string): boolean {
    const store = this.registry.getOrCreate(sessionId);
    return store.historyHydrated === true;
  }

  markHistoryHydrated(
    sessionId: string,
    source: 'jsonl' | 'acp_fallback' | 'none',
    options?: { hydratedAt?: string }
  ): void {
    const store = this.registry.getOrCreate(sessionId);
    store.historyHydrated = true;
    store.historyHydrationSource = source;
    store.historyHydratedAt = options?.hydratedAt ?? this.nowIso();
  }

  replaceTranscript(
    sessionId: string,
    transcript: ChatMessage[],
    options?: { historySource?: 'jsonl' | 'acp_fallback' | 'none' }
  ): void {
    const store = this.registry.getOrCreate(sessionId);
    store.transcript = [...transcript].sort(messageSort);
    setNextOrderFromTranscript(store);

    if (options?.historySource) {
      this.markHistoryHydrated(sessionId, options.historySource);
    }
  }
}

function createSessionDomainService(): SessionDomainService {
  return new SessionDomainService();
}

export const sessionDomainService = createSessionDomainService();
