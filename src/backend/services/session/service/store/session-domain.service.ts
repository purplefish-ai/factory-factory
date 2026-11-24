import { EventEmitter } from 'node:events';
import { applicationUpdateAdmission } from '@/backend/services/application-update-admission.service';
import { createLogger } from '@/backend/services/logger.service';
import type {
  AgentMessage,
  ChatMessage,
  QueuedMessage,
  SessionDeltaEvent,
} from '@/shared/acp-protocol';
import { MessageState } from '@/shared/acp-protocol';
import { parseAcpPlanNotification } from '@/shared/acp-protocol/task-plan';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX } from '@/shared/workspace-notifications';
import { SessionHistoryFences } from './session-history-fences';
import { mergeLifecycleMessage } from './session-lifecycle-transcript';
import { survivesProviderIdentityRollover } from './session-local-transcript';
import { buildMessageFailure, recordPRUpdateOutcome } from './session-pr-update';
import { handleProcessExit } from './session-process-exit';
import { SessionPublisher } from './session-publisher';
import {
  foldQuestionToolUpdate,
  type QuestionMessage,
  recordQuestionResponse,
} from './session-question-transcript';
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
} from './session-queue';
import { buildReplayEvents } from './session-replay-builder';
import { sessionResumeFences } from './session-resume-fence';
import { SessionRuntimeMachine } from './session-runtime-machine';
import { SessionStoreRegistry } from './session-store-registry';
import { type RetainedStoreClaim, SessionStoreRetention } from './session-store-retention';
import type {
  HistoryFileIdentity,
  RecentMessageRejection,
  SessionStore,
} from './session-store.types';
import { existingSubmission, rejectionEvent, retainSubmissionOptions } from './session-submission';
import {
  appendClaudeEvent,
  commitSentUserMessageWithOrder,
  injectCommittedUserMessage,
  messageSort,
  rebuildTranscriptIndex,
  removeTranscriptMessageById,
  setNextOrderFromTranscript,
  upsertTranscriptMessage,
} from './session-transcript';

const logger = createLogger('session-domain-service');
const RECENT_REJECTION_TTL_MS = 60_000;
const MAX_RECENT_REJECTIONS = 100;

export class SessionDomainService extends EventEmitter {
  private readonly pendingAdmissions = new WeakMap<QueuedMessage, Promise<void>>();

  // Dispatch may replace a batch member's settings with the provider's effective settings.
  private readonly submittedOptions = new WeakMap<
    QueuedMessage | ChatMessage,
    Pick<QueuedMessage, 'settings' | 'voiceMode'>
  >();

  existingSubmission(sessionId: string, candidate: QueuedMessage) {
    const store = this.registry.getExisting(sessionId);
    return (
      store && existingSubmission(store, candidate, this.pendingAdmissions, this.submittedOptions)
    );
  }

  trackDispatchBatch(sessionId: string, messages: readonly QueuedMessage[]): () => void {
    const store = this.registry.getOrCreateActive(sessionId);
    store.dispatching ??= new Map();
    const dispatching = store.dispatching;
    const token = Symbol();
    const batch = [...messages];
    for (const message of batch) {
      dispatching.set(message, token);
    }
    return () => {
      if (!this.registry.isCurrentStore(sessionId, store)) {
        return;
      }
      let changed = false;
      for (const message of batch) {
        if (dispatching.get(message) === token) {
          dispatching.delete(message);
          changed = true;
        }
      }
      if (changed) {
        this.publishQueue(sessionId);
      }
    };
  }

  finishDispatchPreparation(sessionId: string, message: QueuedMessage): void {
    this.registry.getExisting(sessionId)?.dispatching?.delete(message);
  }

  holdMessageForAdmission(message: QueuedMessage): () => void {
    this.submittedOptions.set(message, {
      settings: { ...message.settings },
      voiceMode: message.voiceMode,
    });
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    this.pendingAdmissions.set(message, pending);
    return () => {
      this.pendingAdmissions.delete(message);
      resolve();
    };
  }

  waitForMessageAdmission(
    sessionId: string,
    messageId: string
  ): { settled: Promise<void>; message: QueuedMessage } | undefined {
    const message = this.registry
      .getExisting(sessionId)
      ?.queue.find((queued) => queued.id === messageId);
    const settled = message ? this.pendingAdmissions.get(message) : undefined;
    return message && settled ? { settled, message } : undefined;
  }

  isMessageAdmissionPending(message: QueuedMessage): boolean {
    return this.pendingAdmissions.has(message);
  }
  private readonly registry = new SessionStoreRegistry();
  private readonly retention = new SessionStoreRetention(this.registry, (id) =>
    this.clearSession(id, { preserveRejections: true })
  );
  private readonly historyFences = new SessionHistoryFences(this.registry);
  private readonly publisher = new SessionPublisher();
  private readonly nowIso = () => new Date().toISOString();
  private readonly parityLogger = this.publisher.getParityLogger();

  /** In-memory store for initial messages to auto-enqueue on first load_session */
  private readonly initialMessages = new Map<string, string>();
  // Retain publication evidence through cancellation and ordinary store eviction.
  private readonly publishedInitialMessages = new Map<string, string>();

  hasPendingUpdateWork(): boolean {
    return this.initialMessages.size > 0 || this.registry.hasQueuedWork();
  }

  storeInitialMessage(sessionId: string, text: string): void {
    applicationUpdateAdmission.assertOpen();
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

  private readonly runtimeMachine = new SessionRuntimeMachine(
    (sessionId, runtime) => {
      this.publisher.emitDelta(sessionId, {
        type: 'session_runtime_updated',
        sessionRuntime: runtime,
      });
      this.emit('runtime_changed', {
        sessionId,
        runtime,
      });
    },
    this.nowIso,
    (sessionId) => {
      this.publisher.emitDelta(sessionId, { type: 'slash_commands', slashCommands: [] });
    }
  );

  private transitionRuntime(
    sessionId: string,
    updates: Pick<SessionRuntimeState, 'phase' | 'processState' | 'activity'> & {
      lastExit?: SessionRuntimeState['lastExit'];
      errorMessage?: SessionRuntimeState['errorMessage'];
      work?: SessionRuntimeState['work'];
    }
  ): void {
    const store = this.registry.getOrCreateActive(sessionId);
    this.runtimeMachine.markRuntime(store, updates);
  }

  prepareLoad(sessionId: string, sessionRuntime: SessionRuntimeState) {
    const store = this.registry.getOrCreateActive(sessionId);
    if (!store.initialized) {
      store.initialized = true;
    }

    this.runtimeMachine.markRuntime(
      store,
      {
        phase: sessionRuntime.phase,
        processState: sessionRuntime.processState,
        activity: sessionRuntime.activity,
        work: sessionRuntime.work,
        ...(Object.hasOwn(sessionRuntime, 'lastExit') ? { lastExit: sessionRuntime.lastExit } : {}),
        ...(Object.hasOwn(sessionRuntime, 'errorMessage')
          ? { errorMessage: sessionRuntime.errorMessage }
          : {}),
        updatedAt: sessionRuntime.updatedAt,
      },
      { emitDelta: false, replace: true }
    );

    logger.info('Session load prepared', {
      sessionId,
      sessionRuntime,
      transcriptCount: store.transcript.length,
      queueCount: store.queue.length,
    });
    return { replayEvents: buildReplayEvents(store), sessionRuntime: store.runtime };
  }

  finishLoad(sessionId: string): void {
    const store = this.registry.getOrCreateActive(sessionId);
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
  }

  emitDelta(sessionId: string, event: SessionDeltaEvent): void {
    if (event.type === 'task_notification') {
      const plan = parseAcpPlanNotification(event.message);
      if (plan) {
        this.registry.getOrCreateActive(sessionId).taskPlan = plan;
      }
    }
    if (event.type === 'slash_commands') {
      this.registry.getOrCreateActive(sessionId).liveSlashCommands = structuredClone(
        event.slashCommands ?? []
      );
    }
    this.publisher.emitDelta(sessionId, event);
  }
  rejectMessage(sessionId: string, messageId: string, errorMessage: string): void {
    this.recordRecentMessageRejection(sessionId, {
      id: messageId,
      errorMessage,
    });
  }
  rejectQueuedAdmission(sessionId: string, message: QueuedMessage, errorMessage: string): void {
    const store = this.registry.getExisting(sessionId);
    if (store && removeQueuedMessage(store, message.id, { expectedMessage: message })) {
      this.recordRecentMessageRejection(sessionId, {
        ...buildMessageFailure(sessionId, message, errorMessage),
        submittedOptions: this.submittedOptions.get(message),
        state: MessageState.REJECTED,
      });
    }
  }

  failMessage(
    sessionId: string,
    message: QueuedMessage,
    errorMessage: string,
    deliveryState: 'failed' | 'cancelled' = 'failed'
  ): void {
    this.finishDispatchPreparation(sessionId, message);
    if (message.source?.type === 'pr_event') {
      const store = this.registry.getOrCreateActive(sessionId);
      if (!recordPRUpdateOutcome(store, message, deliveryState, errorMessage)) {
        return;
      }
      removeQueuedMessage(store, message.id, { recordCancellation: false });
      this.publisher.forwardSnapshot(store, { reason: 'manual_emit' });
      return;
    }
    this.recordRecentMessageRejection(sessionId, {
      ...buildMessageFailure(sessionId, message, errorMessage),
      submittedOptions: this.submittedOptions.get(message),
    });
  }

  private recordRecentMessageRejection(
    sessionId: string,
    rejection: Omit<RecentMessageRejection, 'rejectedAt' | 'expiresAt'>
  ): void {
    const store = this.registry.getOrCreate(sessionId);
    const now = Date.now();
    store.recentRejections = store.recentRejections.filter(
      (recentRejection) => recentRejection.expiresAt > now && recentRejection.id !== rejection.id
    );
    store.recentRejections.push({
      ...rejection,
      rejectedAt: this.nowIso(),
      expiresAt: now + RECENT_REJECTION_TTL_MS,
    });

    if (store.recentRejections.length > MAX_RECENT_REJECTIONS) {
      store.recentRejections = store.recentRejections.slice(-MAX_RECENT_REJECTIONS);
    }

    this.publisher.emitDelta(sessionId, rejectionEvent(rejection));
  }

  setRuntimeSnapshot(sessionId: string, runtime: SessionRuntimeState, emitDelta = true): void {
    const store = this.registry.getOrCreateActive(sessionId);
    this.runtimeMachine.markRuntime(
      store,
      {
        phase: runtime.phase,
        processState: runtime.processState,
        activity: runtime.activity,
        work: runtime.work,
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

  beginInitialLaunch(sessionId: string): () => void {
    const store = this.registry.getOrCreateActive(sessionId);
    const release = this.runtimeMachine.beginInitialLaunch(store);
    return () => {
      if (this.registry.isCurrentStore(sessionId, store)) {
        release();
      }
    };
  }

  enqueue(sessionId: string, message: QueuedMessage): { position: number } | { error: string } {
    if (applicationUpdateAdmission.isClosed()) {
      return { error: 'An application update is preparing. Try again after reconnecting.' };
    }
    const store = this.registry.getOrCreateActive(sessionId);
    const result = enqueueMessage(store, message);
    if ('error' in result) {
      return result;
    }
    if (message.source) {
      // Background enqueue can replace a prior PR outcome entry in the transcript.
      this.publisher.forwardSnapshot(store, { reason: 'enqueue' });
    } else {
      this.publisher.forwardQueue(store);
    }
    return { position: result.position + (store.dispatching?.size ?? 0) };
  }

  enqueueInitialMessage(
    sessionId: string,
    message: QueuedMessage
  ): { position: number } | { error: string } | null {
    if (this.publishedInitialMessages.has(sessionId)) {
      return null;
    }
    const result = this.enqueue(sessionId, message);
    if (!('error' in result)) {
      this.publishedInitialMessages.set(sessionId, message.id);
    }
    return result;
  }

  removeQueuedMessage(
    sessionId: string,
    messageId: string,
    options?: { expectedMessage?: QueuedMessage; recordCancellation?: boolean }
  ): boolean {
    const store = this.registry.getExisting(sessionId);
    if (!store) {
      return false;
    }
    const queued = store.queue.find((message) => message.id === messageId);
    const removed = removeQueuedMessage(store, messageId, options);
    if (!removed) {
      return false;
    }
    if (queued?.source && options?.recordCancellation !== false) {
      // Cancelling a PR delivery records its outcome in the transcript.
      this.publisher.forwardSnapshot(store, { reason: 'remove_queued_message' });
    } else {
      this.publisher.forwardQueue(store);
    }
    return true;
  }

  peekNextMessage(sessionId: string): QueuedMessage | undefined {
    const store = this.registry.getOrCreate(sessionId);
    const message = peekNext(store);
    return message && !this.pendingAdmissions.has(message) ? message : undefined;
  }

  dequeueNext(sessionId: string, options?: { publish?: boolean }): QueuedMessage | undefined {
    const store = this.registry.getOrCreateActive(sessionId);
    const head = store.queue[0];
    if (head && this.pendingAdmissions.has(head)) {
      return undefined;
    }
    const next = dequeueNext(store);
    if (next && options?.publish !== false) {
      this.publisher.forwardQueue(store);
    }
    return next;
  }

  requeueFront(sessionId: string, message: QueuedMessage): void {
    const store = this.registry.getOrCreateActive(sessionId);
    requeueFront(store, message);
    // The requeued entry replaces any committed copy with the same id on viewers.
    this.publisher.forwardQueue(store);
  }

  /** Publish the current queue after it changed without its own publication. */
  publishQueue(sessionId: string): void {
    const store = this.registry.getExisting(sessionId);
    if (store) {
      this.publisher.forwardQueue(store);
    }
  }

  commitSentUserMessage(
    sessionId: string,
    message: QueuedMessage,
    options?: { publish?: boolean }
  ): void {
    const store = this.registry.getOrCreateActive(sessionId);
    const order = store.nextOrder;
    store.nextOrder += 1;
    this.commitSentUserMessageWithOrder(store, message, order, options);
  }

  /** Confirm a late provider receipt only in the originally retained conversation store. */
  captureLateMessageCommit(sessionId: string, message: QueuedMessage): () => boolean {
    const store = this.registry.getExisting(sessionId);
    return () => {
      if (!(store && this.registry.isCurrentStore(sessionId, store))) {
        return false;
      }
      store.queue = store.queue.filter((queued) => queued !== message);
      const order = store.nextOrder;
      store.nextOrder += 1;
      this.commitSentUserMessageWithOrder(store, message, order);
      return true;
    };
  }

  commitSentUserMessageAtOrder(
    sessionId: string,
    message: QueuedMessage,
    order: number,
    options?: { publish?: boolean }
  ): void {
    const store = this.registry.getOrCreateActive(sessionId);
    this.commitSentUserMessageWithOrder(store, message, order, options);
  }

  private commitSentUserMessageWithOrder(
    store: SessionStore,
    message: QueuedMessage,
    order: number,
    options?: { publish?: boolean }
  ): void {
    store.dispatching?.delete(message);
    const committed = commitSentUserMessageWithOrder(store, message, order);
    const optionsAtAdmission = this.submittedOptions.get(message);
    if (optionsAtAdmission) {
      this.submittedOptions.set(committed, optionsAtAdmission);
    }
    this.emit('user_message_committed', { sessionId: store.sessionId });

    if (options?.publish !== false) {
      this.publisher.forwardCommittedMessage(store, committed);
    }
  }

  removeTranscriptMessageById(
    sessionId: string,
    messageId: string,
    options?: { emitSnapshot?: boolean; preservePRUpdateOutcome?: boolean }
  ): boolean {
    const store = this.registry.getExisting(sessionId);
    if (!store) {
      return false;
    }
    const removed = removeTranscriptMessageById(store, messageId, options);
    if (removed && options?.emitSnapshot !== false) {
      this.publisher.forwardSnapshot(store, {
        reason: 'remove_transcript_message',
        removedMessageIds: [messageId],
      });
    }
    return removed;
  }

  appendClaudeEvent(
    sessionId: string,
    claudeMessage: AgentMessage
  ): {
    order: number;
    messageId?: string;
    replacement?: AgentMessage;
  } {
    const store = this.registry.getOrCreateActive(sessionId);
    return (
      foldQuestionToolUpdate(store, claudeMessage) ??
      appendClaudeEvent(store, claudeMessage, {
        nowIso: this.nowIso,
        onParityTrace: (data) => {
          this.parityLogger(sessionId, data);
        },
      })
    );
  }

  upsertQuestionResponse(sessionId: string, order: number, data: QuestionMessage): ChatMessage {
    const store = this.registry.getOrCreateActive(sessionId);
    const { row, obsoleteIds } = recordQuestionResponse(
      store,
      order,
      data,
      data.timestamp ?? this.nowIso()
    );
    for (const id of obsoleteIds) {
      removeTranscriptMessageById(store, id);
    }
    if (obsoleteIds.length > 0) {
      this.publisher.forwardSnapshot(store, { removedMessageIds: obsoleteIds });
    } else {
      this.publisher.emitDelta(sessionId, {
        type: 'agent_message',
        messageId: row.id,
        order: row.order,
        data: row.message ?? data,
      });
    }
    return row;
  }

  /**
   * Upsert a Claude event at a specific order (for ACP text accumulation).
   * Creates or replaces the transcript entry at the given order.
   */
  upsertClaudeEvent(sessionId: string, claudeMessage: AgentMessage, order: number): string {
    const store = this.registry.getOrCreateActive(sessionId);
    const id = `${store.sessionId}-${order}`;
    upsertTranscriptMessage(store, {
      id,
      source: 'agent',
      message: claudeMessage,
      timestamp: claudeMessage.timestamp ?? this.nowIso(),
      order,
    });
    return id;
  }

  upsertProviderNotice(
    sessionId: string,
    message: Extract<AgentMessage, { type: 'session_notice' }>,
    resolving = false
  ): boolean {
    const store = this.registry.getOrCreateActive(sessionId);
    const id = `provider-notice:${message.notice.id}`;
    const index = store.transcriptIdToIndex.get(id);
    const existing = index === undefined ? undefined : store.transcript[index];
    const previous =
      existing?.message?.type === 'session_notice' ? existing.message.notice : undefined;
    const isCurrentRetry =
      previous?.reconnect === 'retrying' && previous.revision === message.notice.revision;
    if (resolving ? !isCurrentRetry : previous && previous.revision >= message.notice.revision) {
      return false;
    }
    const timestamp = existing?.timestamp ?? this.nowIso();
    const order = existing?.order ?? this.allocateOrder(sessionId);
    const data = { ...message, timestamp };
    upsertTranscriptMessage(store, { id, source: 'agent', message: data, timestamp, order });
    this.publisher.emitDelta(sessionId, { type: 'agent_message', data, messageId: id, order });
    return true;
  }

  upsertLifecycleMessage(sessionId: string, message: ChatMessage): boolean {
    const store = this.registry.getOrCreateActive(sessionId);
    const existed = store.transcript.some((entry) => entry.id === message.id);
    store.transcript = mergeLifecycleMessage(store.transcript, message);
    rebuildTranscriptIndex(store);
    setNextOrderFromTranscript(store);
    return !existed;
  }

  allocateOrder(sessionId: string): number {
    const store = this.registry.getOrCreateActive(sessionId);
    const order = store.nextOrder;
    store.nextOrder += 1;
    return order;
  }

  setPendingInteractiveRequest(sessionId: string, request: PendingInteractiveRequest): void {
    const store = this.registry.getOrCreateActive(sessionId);
    setPendingInteractiveRequest(store, request);
    this.publisher.forwardPendingRequest(store);
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
    const store = this.registry.getOrCreateActive(sessionId);
    const pendingRequest = store.pendingInteractiveRequest;
    if (!pendingRequest) {
      return;
    }

    if (!clearPendingInteractiveRequest(store)) {
      return;
    }
    this.publisher.forwardPendingRequest(store);
    this.emit('pending_request_changed', {
      sessionId,
      requestId: pendingRequest.requestId,
      hasPending: false,
    });
  }

  /** Returns whether `requestId` was the pending request and has been cleared. */
  clearPendingInteractiveRequestIfMatches(sessionId: string, requestId: string): boolean {
    const store = this.registry.getOrCreateActive(sessionId);
    if (!clearPendingInteractiveRequestIfMatches(store, requestId)) {
      return false;
    }
    this.publisher.forwardPendingRequest(store);
    this.emit('pending_request_changed', { sessionId, requestId, hasPending: false });
    return true;
  }

  markProcessExit(
    sessionId: string,
    code: number | null,
    options?: { preserveQueuedInput?: boolean }
  ): void {
    const store = this.registry.getOrCreateActive(sessionId);
    const pendingRequest = store.pendingInteractiveRequest;
    // An exit that does not preserve the queue discards it; return typed human
    // input for retry instead of silently dropping it. Background and notification messages own
    // their own recovery.
    const discardedHumanMessages = options?.preserveQueuedInput
      ? []
      : store.queue.filter(
          (message) =>
            !(message.source || message.id.startsWith(WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX))
        );
    handleProcessExit({
      store,
      code,
      preserveQueuedInput: options?.preserveQueuedInput,
      nowIso: this.nowIso,
      markRuntime: (targetStore, updates) => {
        this.runtimeMachine.markRuntime(targetStore, updates);
      },
      forwardSnapshot: (targetStore, options) => {
        this.publisher.forwardSnapshot(targetStore, options);
      },
    });

    const notSentReason =
      code === 0
        ? 'Message was not sent because the agent process exited.'
        : 'Message was not sent because the agent process exited unexpectedly.';
    for (const message of discardedHumanMessages) {
      this.failMessage(sessionId, message, notSentReason);
    }

    if (pendingRequest) {
      this.emit('pending_request_changed', {
        sessionId,
        requestId: pendingRequest.requestId,
        hasPending: false,
      });
    }
  }

  clearQueuedWork(sessionId: string, options?: { emitSnapshot?: boolean }): void {
    this.initialMessages.delete(sessionId);
    // Cleanup must not revive a deleted or preservation-only session.
    const store = this.registry.getExisting(sessionId);
    if (!store) {
      return;
    }
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

  markRunning(sessionId: string, work?: SessionRuntimeState['work']): void {
    const previousWork = this.registry.getOrCreate(sessionId).runtime.work;
    this.transitionRuntime(sessionId, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      work: work ?? (previousWork ? { ...previousWork, promptInFlight: true } : undefined),
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
    const store = this.registry.getOrCreateActive(sessionId);
    this.transitionRuntime(sessionId, {
      phase: 'error',
      processState: store.runtime.processState,
      activity: store.runtime.activity,
      ...(errorMessage ? { errorMessage } : {}),
    });
  }

  emitSessionSnapshot(
    sessionId: string,
    loadRequestId?: string,
    removedMessageIds?: string[]
  ): void {
    const store = this.registry.getOrCreate(sessionId);
    this.publisher.forwardSnapshot(store, {
      loadRequestId,
      ...(removedMessageIds ? { removedMessageIds } : {}),
      reason: 'manual_emit',
      includeParitySnapshot: true,
    });
  }

  injectCommittedUserMessage(
    sessionId: string,
    text: string,
    options?: { messageId?: string; appendTo?: string }
  ): string {
    const store = this.registry.getOrCreateActive(sessionId);
    const id = injectCommittedUserMessage(store, text, {
      ...options,
      nowIso: this.nowIso,
      nowMs: () => Date.now(),
    });
    this.publisher.forwardSnapshot(store, { reason: 'inject_user_message' });
    return id;
  }

  /** The last viewer left a session with no running runtime; see `SessionStoreRetention`. */
  releaseViewerless(sessionId: string, isIdle: () => boolean): void {
    this.retention.release(sessionId, isIdle);
  }

  claimRetainedStore(sessionId: string): RetainedStoreClaim | undefined {
    return this.retention.claim(sessionId);
  }

  stopStoreRetention(): void {
    this.retention.stop();
  }

  /** Clears a session's store; `clearAllSessions` is the only other way to clear one. */
  clearSession(
    sessionId: string,
    options?: { preserveRejections?: boolean; permanentlyDeleted?: boolean }
  ): void {
    this.retention.cancel(sessionId);
    const initialMessageId = this.publishedInitialMessages.get(sessionId);
    const queuedMessages =
      initialMessageId === undefined ? [] : this.registry.getQueueSnapshot(sessionId);
    const hasPendingInitialMessage = queuedMessages.some(
      (message) => message.id === initialMessageId
    );
    // Inactive-viewer cleanup must not discard a task still waiting for workspace setup.
    const preserveQueue =
      hasPendingInitialMessage && options?.preserveRejections && !options.permanentlyDeleted;
    this.initialMessages.delete(sessionId);
    this.registry.clearSession(sessionId, options);
    if (preserveQueue) {
      this.registry.getOrCreateActive(sessionId).queue = queuedMessages;
    } else if (hasPendingInitialMessage) {
      this.publishedInitialMessages.delete(sessionId);
    }
    // Lets retained provider-history projections start their expiry.
    this.emit('session_cleared', sessionId);
    if (options?.permanentlyDeleted) {
      this.forgetProviderHistoryIdentity(sessionId);
    }
  }

  clearAllSessions(): void {
    this.initialMessages.clear();
    this.publishedInitialMessages.clear();
    this.historyFences.clear();
    this.retention.cancelAll();
    this.registry.clearAllSessions();
  }

  /** Call only after durable deletion; ordinary store eviction must retain this fence. */
  forgetProviderHistoryIdentity(sessionId: string): void {
    this.publishedInitialMessages.delete(sessionId);
    this.historyFences.forget(sessionId);
    sessionResumeFences.forget(sessionId);
    this.emit('session_permanently_deleted', sessionId);
  }

  getAllPendingRequests(): Map<string, PendingInteractiveRequest> {
    return this.registry.getAllPendingRequests();
  }

  getQueueLength(sessionId: string): number {
    return this.registry.getQueueLength(sessionId);
  }

  captureStoreGuard(sessionId: string): () => boolean {
    const store = this.registry.getExisting(sessionId);
    return () => Boolean(store && this.registry.isCurrentStore(sessionId, store));
  }

  getQueueSnapshot(sessionId: string): QueuedMessage[] {
    return this.registry.getQueueSnapshot(sessionId);
  }

  takeQueuedMessages(sessionId: string, messages: readonly QueuedMessage[]): boolean {
    const store = this.registry.getOrCreateActive(sessionId);
    if (
      messages.some(
        (message) => !store.queue.includes(message) || this.pendingAdmissions.has(message)
      )
    ) {
      return false;
    }
    const selected = new Set(messages);
    store.queue = store.queue.filter((message) => !selected.has(message));
    return true;
  }

  /** Dispatch consumes only a unique, contiguous prefix; steering may select nonhead messages. */
  takeQueuedPrefix(sessionId: string, messages: readonly QueuedMessage[]): boolean {
    const store = this.registry.getExisting(sessionId);
    if (
      !store ||
      messages.length === 0 ||
      new Set(messages).size !== messages.length ||
      messages.some(
        (message, index) => store.queue[index] !== message || this.pendingAdmissions.has(message)
      )
    ) {
      return false;
    }
    store.queue.splice(0, messages.length);
    return true;
  }

  hasQueuedMessage(sessionId: string, messageId: string, expectedMessage?: QueuedMessage): boolean {
    return this.registry
      .getQueueSnapshot(sessionId)
      .some(
        (message) => message.id === messageId && (!expectedMessage || message === expectedMessage)
      );
  }

  getTranscriptSnapshot(sessionId: string): ChatMessage[] {
    const store = this.registry.getOrCreate(sessionId);
    return [...store.transcript].sort(messageSort);
  }

  acceptProviderHistoryIdentity(sessionId: string, providerSessionId: string): boolean {
    return this.historyFences.accept(sessionId, providerSessionId);
  }

  createProviderHistoryFence(
    sessionId: string,
    providerSessionId: string | null
  ): (() => boolean) | null {
    return this.historyFences.create(sessionId, providerSessionId);
  }

  suspendProviderHistory(sessionId: string): () => void {
    return this.historyFences.suspend(sessionId);
  }

  resetProviderHistory(sessionId: string, providerSessionId: string): void {
    const store = this.historyFences.repair(sessionId, providerSessionId);
    store.taskPlan = undefined;
    this.clearHistoryRetryCooldown(sessionId);
    // Stop evidence belongs to the AgentSession; provider messages belong to the archived identity.
    this.replaceTranscript(sessionId, store.transcript.filter(survivesProviderIdentityRollover));
    this.publisher.forwardSnapshot(store, { reason: 'manual_emit', resetTranscript: true });
  }

  isHistoryHydrated(sessionId: string): boolean {
    const store = this.registry.getOrCreate(sessionId);
    return store.historyHydrated === true;
  }

  getHistoryHydrationSource(sessionId: string): 'jsonl' | 'acp_fallback' | 'none' | undefined {
    const store = this.registry.getOrCreate(sessionId);
    return store.historyHydrationSource;
  }

  setHistoryRetryAt(sessionId: string, retryAt: number): void {
    this.registry.setHistoryRetryAt(sessionId, retryAt);
  }

  canAttemptHistoryHydration(sessionId: string): boolean {
    return this.registry.canAttemptHistoryHydration(sessionId);
  }

  clearHistoryRetryCooldown(sessionId: string): void {
    this.registry.clearHistoryRetryCooldown(sessionId);
  }

  markHistoryHydrated(
    sessionId: string,
    source: 'jsonl' | 'acp_fallback' | 'none',
    options?: { hydratedAt?: string; historyFile?: HistoryFileIdentity }
  ): void {
    const store = this.registry.getOrCreateActive(sessionId);
    store.historyHydrated = true;
    store.historyHydrationSource = source;
    store.historyFile = options?.historyFile;
    store.historyHydratedAt = options?.hydratedAt ?? this.nowIso();
  }

  replaceTranscript(
    sessionId: string,
    transcript: ChatMessage[],
    options?: {
      historySource?: 'jsonl' | 'acp_fallback' | 'none';
      historyFile?: HistoryFileIdentity;
    }
  ): void {
    const store = this.registry.getOrCreateActive(sessionId);
    retainSubmissionOptions(store, transcript, this.submittedOptions);
    store.transcript = [...transcript].sort(messageSort);
    rebuildTranscriptIndex(store);
    setNextOrderFromTranscript(store);

    if (options?.historySource) {
      this.markHistoryHydrated(sessionId, options.historySource, {
        historyFile: options.historyFile,
      });
    }
  }
}

function createSessionDomainService(): SessionDomainService {
  return new SessionDomainService();
}

export const sessionDomainService = createSessionDomainService();
