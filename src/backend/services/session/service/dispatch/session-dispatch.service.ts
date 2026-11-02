import { WorkspaceInitFenceError } from '@/backend/lib/workspace-init-fence-error';
/** Queue execution and dispatch fencing for session messages. */
import { createLogger } from '@/backend/services/logger.service';
import type { SessionInitPolicyBridge } from '@/backend/services/session/service/bridges';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import { PermanentAttachmentError } from '@/backend/services/session/service/chat/chat-message-handlers/attachment-processing';
import { DEBUG_CHAT_WS } from '@/backend/services/session/service/chat/chat-message-handlers/constants';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { EventSessionFenceError } from '@/backend/services/session/service/lifecycle/event-session-fence-error';
import { toErrorMessage } from '@/backend/services/session/service/lifecycle/session.error-message';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { MessageState, type QueuedMessage } from '@/shared/acp-protocol';
import { UncertainChatDispatchError } from '../chat/chat-intent-errors';
import {
  acknowledgeSentBatch,
  prepareBackgroundForDispatch,
  collectDispatchBatch,
  dispatchCollectedBatch,
  combineBatchContents,
} from './session-dispatch-batch';
import { isClaudeCompactionClient, isThinkingBudgetClient } from './session-dispatch-client';
import type {
  SessionDispatchDependencies,
  SessionDispatchLifecycleDependencies,
  DispatchOptions,
} from './session-dispatch.types';
import {
  publishDispatchedBatch,
  getPermanentBlockedDispatchReason,
} from './session-dispatched-publication';
import { prepareDurableAttempt, prepareDurableBatchContents } from './session-durable-attempt';
import { buildMessageContent } from './session-message-content';
import { SessionQueuedSteering } from './session-queued-steering';

const logger = createLogger('chat-message-handlers');
const TURN_IN_PROGRESS_RETRY_BASE_MS = 1000;
const TURN_IN_PROGRESS_RETRY_MAX_MS = 30_000;

type DispatchGateResult =
  | { policy: 'allowed' }
  | { policy: 'manual_resume' }
  | { policy: 'blocked'; permanent: boolean; reason: string | null };

export class SessionDispatchService {
  private readonly steering = new SessionQueuedSteering({
    chatIntent: () => this.dependencies.chatIntent,
    generation: (id) => this.lifecycle.gate.getGeneration(id),
    isPromptInFlight: (id) => this.dependencies.runtimeManager.isSessionPromptInFlight(id),
    captureGuard: (id) => {
      const generation = this.lifecycle.gate.getGeneration(id);
      return () => this.isDispatchGenerationCurrent(id, generation);
    },
    isAllowed: async (id) => (await this.evaluateDispatchGateSafely(id)).policy === 'allowed',
    send: (id, content) => this.dependencies.promptService.steerSessionMessage(id, content),
    dispatch: (id) => this.tryDispatchNextMessage(id),
  });
  constructor(private readonly dependencies: SessionDispatchDependencies) {}
  steerQueuedMessage(sessionId: string, messageId: string): Promise<void> {
    return this.steering.steer(sessionId, messageId);
  }

  /** Guard to prevent concurrent tryDispatchNextMessage calls per session. */
  private dispatchInProgress = new Map<string, number>();
  /** Monotonic token to invalidate stale dispatch completions. */
  private nextDispatchToken = 1;
  /** Retry timers for provider-side busy responses that are not reflected locally yet. */
  private turnInProgressRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private turnInProgressRetryAttempts = new Map<string, number>();
  private lifecycleGate: SessionDispatchLifecycleDependencies['gate'] | null = null;
  private startupService: SessionDispatchLifecycleDependencies['startup'] | null = null;
  private notificationDeliveryService:
    | SessionDispatchLifecycleDependencies['notificationDelivery']
    | null = null;
  /** Per-session override to allow dispatch under manual_resume policy. */
  private manualDispatchResumed = new Map<string, boolean>();

  /** Cross-domain bridge for workspace init policy (injected by orchestration layer) */
  private initPolicyBridge: SessionInitPolicyBridge | null = null;

  /**
   * Configure cross-domain bridges. Called once at startup by orchestration layer.
   */
  configure(bridges: { initPolicy: SessionInitPolicyBridge }): void {
    this.initPolicyBridge = bridges.initPolicy;
  }

  configureLifecycle(dependencies: {
    gate: SessionDispatchLifecycleDependencies['gate'];
    startup: SessionDispatchLifecycleDependencies['startup'];
    notificationDelivery: SessionDispatchLifecycleDependencies['notificationDelivery'];
  }): void {
    this.lifecycleGate = dependencies.gate;
    this.startupService = dependencies.startup;
    this.notificationDeliveryService = dependencies.notificationDelivery;
  }

  private get initPolicy(): SessionInitPolicyBridge {
    if (!this.initPolicyBridge) {
      throw new Error(
        'SessionDispatchService not configured: initPolicy bridge missing. Call configure() first.'
      );
    }
    return this.initPolicyBridge;
  }

  private get lifecycle(): {
    gate: SessionDispatchLifecycleDependencies['gate'];
    startup: SessionDispatchLifecycleDependencies['startup'];
    notificationDelivery: SessionDispatchLifecycleDependencies['notificationDelivery'];
  } {
    if (!(this.lifecycleGate && this.startupService && this.notificationDeliveryService)) {
      throw new Error('SessionDispatchService not configured: lifecycle gate/startup missing');
    }
    return {
      gate: this.lifecycleGate,
      startup: this.startupService,
      notificationDelivery: this.notificationDeliveryService,
    };
  }

  setManualDispatchResume(sessionId: string, resumed: boolean): void {
    if (resumed) {
      this.manualDispatchResumed.set(sessionId, true);
      return;
    }
    this.manualDispatchResumed.delete(sessionId);
  }

  resetDispatchState(sessionId: string): void {
    this.steering.reset(sessionId);
    this.dispatchInProgress.delete(sessionId);
    this.clearTurnInProgressRetry(sessionId);
    this.notificationDeliveryService?.resetSession(sessionId);
  }

  private isDispatchInProgress(dbSessionId: string): boolean {
    if (!this.dispatchInProgress.has(dbSessionId)) {
      return false;
    }
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Dispatch already in progress, skipping', { dbSessionId });
    }
    return true;
  }

  private reserveDispatchToken(dbSessionId: string): number {
    const token = this.nextDispatchToken;
    this.nextDispatchToken += 1;
    this.dispatchInProgress.set(dbSessionId, token);
    return token;
  }

  private releaseDispatchToken(dbSessionId: string, token: number): void {
    if (this.dispatchInProgress.get(dbSessionId) !== token) {
      return;
    }
    this.dispatchInProgress.delete(dbSessionId);
  }

  /** Keep the queue visible through auto-start; serialize each session dispatch. */
  async tryDispatchNextMessage(dbSessionId: string, options: DispatchOptions = {}): Promise<void> {
    const stopGeneration = this.lifecycle.gate.getGeneration(dbSessionId);
    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      return;
    }

    if (this.turnInProgressRetryTimers.has(dbSessionId)) {
      if (options.bypassTurnInProgressBackoff) {
        this.clearTurnInProgressRetry(dbSessionId);
      } else {
        return;
      }
    }

    // Guard against concurrent dispatch calls for the same session
    if (this.steering.isPending(dbSessionId) || this.isDispatchInProgress(dbSessionId)) {
      return;
    }

    const dispatchToken = this.reserveDispatchToken(dbSessionId);

    try {
      await this.dependencies.chatIntent?.hydrate(dbSessionId);
      // Loop: a dropped duplicate notification advances to the next queued message.
      let outcome: 'continue' | 'done' = 'continue';
      while (outcome === 'continue') {
        await options.guard?.check();
        options.guard?.assertCurrent?.();
        outcome = await this.dispatchHeadOfQueue(dbSessionId, stopGeneration, options.guard);
      }
    } finally {
      this.releaseDispatchToken(dbSessionId, dispatchToken);
    }
  }

  /**
   * Examine the head of the queue: drop it if it is a duplicate workspace
   * notification ('continue' — caller should examine the new head), otherwise
   * dispatch it ('done').
   */
  private async getDispatchableHead(sessionId: string): Promise<QueuedMessage | undefined> {
    const message = sessionDomainService.peekNextMessage(sessionId);
    return message && !(await this.isExternalDeliveryHeld(sessionId, message))
      ? message
      : undefined;
  }

  private async isExternalDeliveryHeld(
    sessionId: string,
    message: QueuedMessage
  ): Promise<boolean> {
    return Boolean(
      (message.source || this.lifecycle.notificationDelivery.isNotificationMessage(message.id)) &&
      (await this.dependencies.chatIntent?.store.hasUncertainAttempt(sessionId))
    );
  }

  private async dispatchHeadOfQueue(
    dbSessionId: string,
    stopGeneration: number,
    guard?: SessionCallerGuard
  ): Promise<'continue' | 'done'> {
    await guard?.check();
    guard?.assertCurrent?.();
    // Peek first — message stays in queue (visible in snapshots during auto-start).
    const peeked = await this.getDispatchableHead(dbSessionId);
    if (!peeked) {
      this.turnInProgressRetryAttempts.delete(dbSessionId);
      return 'done';
    }

    const claim = this.lifecycle.notificationDelivery.claimForDispatch(dbSessionId, peeked.id);
    if (claim.status === 'duplicate') {
      return this.lifecycle.notificationDelivery.removeDuplicateFromQueue(dbSessionId, peeked.id)
        ? 'continue'
        : 'done';
    }

    try {
      if (
        claim.status === 'claimed' &&
        (await this.lifecycle.notificationDelivery.isAlreadyDelivered(claim.notificationId))
      ) {
        if (guard) {
          await guard.check();
          guard.assertCurrent?.();
        }
        return this.lifecycle.notificationDelivery.removeDuplicateFromQueue(dbSessionId, peeked.id)
          ? 'continue'
          : 'done';
      }
      if (
        (await this.dispatchPeekedMessage(dbSessionId, peeked, stopGeneration, guard)) === 'retry'
      ) {
        return 'continue';
      }
      return peeked.source &&
        this.isDispatchGenerationCurrent(dbSessionId, stopGeneration) &&
        sessionDomainService.peekNextMessage(dbSessionId) !== peeked
        ? 'continue'
        : 'done';
    } finally {
      if (claim.status === 'claimed') {
        claim.release();
      }
    }
  }

  private async dispatchPeekedMessage(
    dbSessionId: string,
    peeked: QueuedMessage,
    stopGeneration: number,
    guard?: SessionCallerGuard
  ): Promise<'retry' | undefined> {
    await guard?.check();
    guard?.assertCurrent?.();
    const dispatchGate = await this.evaluateDispatchGateSafely(dbSessionId);
    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      return;
    }
    if (dispatchGate.policy !== 'allowed') {
      await this.handleBlockedDispatchGate(dbSessionId, dispatchGate);
      return;
    }

    if (!(await this.prepareBackgroundForDispatch(dbSessionId, peeked, stopGeneration, guard))) {
      return;
    }
    const clientResult = await this.resolvePreparedClientForDispatch(
      dbSessionId,
      peeked,
      stopGeneration,
      guard
    );
    if (!clientResult) {
      return;
    }

    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      await this.releaseStoppedBackground(peeked);
      return;
    }

    if (peeked.source && sessionDomainService.peekNextMessage(dbSessionId) !== peeked) {
      await this.dependencies.backgroundDelivery.fail(
        peeked,
        new Error('Turn in progress: human message queued during preparation')
      );
      return;
    }
    await guard?.check();
    guard?.assertCurrent?.();
    const batch = await collectDispatchBatch({
      sessionId: dbSessionId,
      first: peeked,
      notifications: this.lifecycle.notificationDelivery,
      isHeld: (message) => this.isExternalDeliveryHeld(dbSessionId, message),
      guard,
      prepareBackground: async (message) => {
        try {
          return await this.prepareBackgroundForDispatch(
            dbSessionId,
            message,
            stopGeneration,
            guard
          );
        } catch (error) {
          logger.warn('PR preparation deferred; dispatching queued human messages', {
            dbSessionId,
            error,
          });
          return false;
        }
      },
      isCurrent: () => this.isDispatchGenerationCurrent(dbSessionId, stopGeneration),
    });
    try {
      await guard?.check();
      guard?.assertCurrent?.();
    } catch (error) {
      batch.release();
      throw error;
    }
    return dispatchCollectedBatch({
      chatIntent: this.dependencies.chatIntent,
      sessionId: dbSessionId,
      batch,
      backgroundDelivery: this.dependencies.backgroundDelivery,
      isCurrent: () => {
        try {
          guard?.assertCurrent?.();
        } catch {
          return false;
        }
        return this.isDispatchGenerationCurrent(dbSessionId, stopGeneration);
      },
      send: (messages) =>
        this.dispatchMessage(dbSessionId, messages, clientResult.client, stopGeneration, guard),
      onError: async (message, error) => {
        this.handleDispatchError(dbSessionId, message, error, stopGeneration, clientResult.client);
        if (
          !(message.source || sessionDomainService.getQueueSnapshot(dbSessionId).includes(message))
        ) {
          await this.dependencies.chatIntent?.cancel(dbSessionId, message.id, 'failed');
        }
      },
      onSuccess: () => {
        this.turnInProgressRetryAttempts.delete(dbSessionId);
      },
    });
  }

  private async releaseStoppedBackground(message: QueuedMessage): Promise<void> {
    if (message.source) {
      await this.dependencies.backgroundDelivery.fail(
        message,
        new Error('Session stopped before dispatch'),
        'cancelled'
      );
    }
  }

  private async resolvePreparedClientForDispatch(
    dbSessionId: string,
    peeked: QueuedMessage,
    stopGeneration: number,
    guard?: SessionCallerGuard
  ): Promise<{ client: unknown } | null> {
    await guard?.check();
    guard?.assertCurrent?.();
    const clientResult = await this.resolveClientForDispatch(dbSessionId, peeked, guard);
    if (!(clientResult && this.isDispatchGenerationCurrent(dbSessionId, stopGeneration))) {
      await this.releaseStoppedBackground(peeked);
      return null;
    }
    if ('blocked' in clientResult) {
      if (peeked.source) {
        await this.dependencies.backgroundDelivery.fail(
          peeked,
          new Error(
            clientResult.blocked === 'busy'
              ? 'A turn is already in progress for this session'
              : 'Required existing conversation could not be restored'
          )
        );
      }
      return null;
    }
    if (peeked.source && !(await this.dependencies.backgroundDelivery.validate(peeked))) {
      if (guard) {
        await guard.check();
        guard.assertCurrent?.();
      }
      await this.dependencies.backgroundDelivery.fail(
        peeked,
        new Error('PR delivery invalidated before dispatch'),
        'cancelled'
      );
      if (guard) {
        await guard.check();
        guard.assertCurrent?.();
      }
      sessionDomainService.removeQueuedMessage(dbSessionId, peeked.id, { expectedMessage: peeked });
      return null;
    }
    return clientResult;
  }

  private prepareBackgroundForDispatch(
    dbSessionId: string,
    peeked: QueuedMessage,
    stopGeneration: number,
    guard?: SessionCallerGuard
  ): Promise<boolean> {
    return prepareBackgroundForDispatch(
      this.dependencies,
      dbSessionId,
      peeked,
      () => this.isDispatchGenerationCurrent(dbSessionId, stopGeneration),
      guard
    );
  }

  // Private: Dispatch Helpers

  /** Reject invalid input, requeue busy sends, and require explicit retry for other failures. */
  private handleDispatchError(
    dbSessionId: string,
    msg: QueuedMessage,
    error: unknown,
    stopGeneration: number,
    capturedClient?: unknown
  ): void {
    if (error instanceof UncertainChatDispatchError) {
      if (!msg.source) {
        sessionDomainService.failMessage(dbSessionId, msg, error.message);
      }
      return;
    }
    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      sessionDomainService.removeTranscriptMessageById(dbSessionId, msg.id, {
        emitSnapshot: false,
        preservePRUpdateOutcome: true,
      });
      return;
    }

    if (error instanceof WorkspaceInitFenceError || error instanceof EventSessionFenceError) {
      sessionDomainService.removeTranscriptMessageById(dbSessionId, msg.id, {
        emitSnapshot: false,
      });
      sessionDomainService.requeueFront(dbSessionId, msg);
      if (
        capturedClient &&
        this.lifecycle.startup.getSessionClient(dbSessionId) === capturedClient &&
        !this.dependencies.runtimeManager.isSessionPromptInFlight(dbSessionId)
      ) {
        sessionDomainService.markIdle(dbSessionId, 'alive');
      }
      return;
    }

    if (error instanceof PermanentAttachmentError) {
      logger.error('[Chat WS] Permanent dispatch error, rejecting message', {
        dbSessionId,
        messageId: msg.id,
        error: error.message,
      });
      sessionDomainService.removeTranscriptMessageById(dbSessionId, msg.id, {
        emitSnapshot: false,
      });
      if (this.dependencies.runtimeManager.isSessionRunning(dbSessionId)) {
        sessionDomainService.markIdle(dbSessionId, 'alive');
      }
      sessionDomainService.emitDelta(dbSessionId, {
        type: 'message_state_changed',
        id: msg.id,
        newState: MessageState.REJECTED,
        errorMessage: error.message,
      });
      return;
    }

    if (this.isTurnAlreadyInProgressError(error)) {
      logger.warn('[Chat WS] ACP turn already in progress, retrying queued message later', {
        dbSessionId,
        messageId: msg.id,
        error: this.formatDispatchError(error),
      });
      sessionDomainService.removeTranscriptMessageById(dbSessionId, msg.id, {
        emitSnapshot: false,
      });
      if (this.dependencies.runtimeManager.isSessionRunning(dbSessionId)) {
        sessionDomainService.markRunning(dbSessionId);
      }
      sessionDomainService.requeueFront(dbSessionId, msg);
      this.scheduleTurnInProgressRetry(dbSessionId);
      return;
    }

    // Dispatch can fail after we pessimistically committed the user message to
    // transcript for refresh safety. Roll it back before surfacing the failure.
    const errorMessage = this.formatDispatchError(error);
    logger.error('[Chat WS] Failed to dispatch message', {
      dbSessionId,
      messageId: msg.id,
      error: errorMessage,
    });
    sessionDomainService.removeTranscriptMessageById(dbSessionId, msg.id, {
      emitSnapshot: false,
    });
    this.markDispatchError(dbSessionId, errorMessage);
    this.turnInProgressRetryAttempts.delete(dbSessionId);
    sessionDomainService.failMessage(dbSessionId, msg, errorMessage);
  }

  private markDispatchError(sessionId: string, errorMessage: string): void {
    // Preserve process exits and prompt errors already finalized with fresh work details.
    if (!this.dependencies.runtimeManager.isSessionRunning(sessionId)) {
      return;
    }
    const runtime = sessionDomainService.getRuntimeSnapshot(sessionId);
    if (runtime.phase === 'error' && runtime.errorMessage === errorMessage) {
      return;
    }
    sessionDomainService.markError(sessionId, errorMessage);
  }

  private scheduleTurnInProgressRetry(dbSessionId: string): void {
    if (this.turnInProgressRetryTimers.has(dbSessionId)) {
      return;
    }

    const attempts = this.turnInProgressRetryAttempts.get(dbSessionId) ?? 0;
    const delayMs = Math.min(
      TURN_IN_PROGRESS_RETRY_BASE_MS * 2 ** attempts,
      TURN_IN_PROGRESS_RETRY_MAX_MS
    );
    this.turnInProgressRetryAttempts.set(dbSessionId, attempts + 1);

    const timer = setTimeout(() => {
      this.turnInProgressRetryTimers.delete(dbSessionId);
      void this.tryDispatchNextMessage(dbSessionId);
    }, delayMs);
    this.turnInProgressRetryTimers.set(dbSessionId, timer);
  }

  private clearTurnInProgressRetry(dbSessionId: string): void {
    const timer = this.turnInProgressRetryTimers.get(dbSessionId);
    if (timer) {
      clearTimeout(timer);
      this.turnInProgressRetryTimers.delete(dbSessionId);
    }
    this.turnInProgressRetryAttempts.delete(dbSessionId);
  }

  private isTurnAlreadyInProgressError(error: unknown): boolean {
    const message = this.formatDispatchError(error);
    return message.includes('A turn is already in progress for this session');
  }

  private formatDispatchError(error: unknown): string {
    return toErrorMessage(error);
  }

  /**
   * Resolve (or auto-start) the client for dispatching a queued message.
   * Returns null if the message should not be dispatched (requeue reason found).
   */
  private async resolveClientForDispatch(
    dbSessionId: string,
    msg: QueuedMessage,
    guard?: SessionCallerGuard
  ): Promise<{ client: unknown } | { blocked: 'busy' | 'resume_failed' } | null> {
    let client = this.lifecycle.startup.getSessionClient(dbSessionId);

    if (!client || msg.source) {
      const started = await this.autoStartClientForQueue(dbSessionId, msg, guard);
      if (!started) {
        return msg.source ? { blocked: 'resume_failed' } : null;
      }
      client = this.lifecycle.startup.getSessionClient(dbSessionId);
    }

    // Check the prompt slot even after startup: another caller may have acquired it
    // while startup/configuration was awaited. Background activity is only a UI signal.
    const reason = this.getRequeueReason(dbSessionId, client);
    if (reason) {
      return msg.source && reason !== 'stopped' ? { blocked: 'busy' } : null;
    }

    return { client };
  }

  /**
   * Auto-start a client for queue dispatch using settings from the provided message.
   */
  private async autoStartClientForQueue(
    dbSessionId: string,
    msg: QueuedMessage,
    guard?: SessionCallerGuard
  ): Promise<boolean> {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Auto-starting client for queued message', { dbSessionId });
    }

    try {
      if (!msg.source) {
        msg.settings = this.dependencies.configService.resolveQueuedMessageSettings(
          dbSessionId,
          msg
        );
      }
      await this.lifecycle.startup.getOrCreateSessionClient(
        dbSessionId,
        msg.source
          ? {
              resumePolicy: 'require_existing',
              ...(guard && { assertCurrent: guard.check, assertCurrentSync: guard.assertCurrent }),
            }
          : {
              ...(guard && { assertCurrent: guard.check, assertCurrentSync: guard.assertCurrent }),
              thinkingEnabled: msg.settings.thinkingEnabled,
              planModeEnabled: msg.settings.planModeEnabled,
              model: msg.settings.selectedModel ?? undefined,
              reasoningEffort: msg.settings.reasoningEffort ?? undefined,
            }
      );
      return true;
    } catch (error) {
      await guard?.check();
      guard?.assertCurrent?.();
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to auto-start client for queue dispatch', {
        dbSessionId,
        error: errorMessage,
      });
      sessionDomainService.markError(dbSessionId, `Failed to start agent: ${errorMessage}`);
      sessionDomainService.emitDelta(dbSessionId, {
        type: 'error',
        message: `Failed to start agent: ${errorMessage}`,
      });
      return false;
    }
  }

  /**
   * Dispatch a message to the client.
   */
  private async dispatchMessage(
    dbSessionId: string,
    messages: QueuedMessage[],
    client: unknown,
    stopGeneration: number,
    guard?: SessionCallerGuard
  ): Promise<void> {
    await guard?.check();
    guard?.assertCurrent?.();
    const contents = await prepareDurableBatchContents(
      this.dependencies.chatIntent,
      dbSessionId,
      messages,
      buildMessageContent,
      (message, error) => this.handleDispatchError(dbSessionId, message, error, stopGeneration)
    );
    const msg =
      [...messages]
        .reverse()
        .find(
          (message) =>
            !(
              message.source ||
              this.lifecycle.notificationDelivery.isNotificationMessage(message.id)
            )
        ) ?? messages[0];
    if (!msg) {
      return;
    }
    const isCompactCommand = this.isCompactCommand(msg.text);
    const compactionClient = isClaudeCompactionClient(client) ? client : null;

    if (
      !(await this.configureBatchForDispatch(
        dbSessionId,
        messages,
        msg,
        client,
        stopGeneration,
        guard
      ))
    ) {
      return;
    }

    await guard?.check();
    guard?.assertCurrent?.();
    sessionDomainService.markRunning(dbSessionId);

    const content = combineBatchContents(messages, contents);
    const attempt = await prepareDurableAttempt({
      owner: this.dependencies.chatIntent,
      sessionId: dbSessionId,
      messages,
      content,
      settings: msg.settings,
      generation: stopGeneration,
      isCurrent: () => this.isDispatchGenerationCurrent(dbSessionId, stopGeneration),
      guard,
    });
    const dispatched = publishDispatchedBatch(dbSessionId, messages, msg.settings);

    if (isCompactCommand && compactionClient) {
      compactionClient.startCompaction();
    }

    try {
      const sendPromise = attempt.invoke(() =>
        this.dependencies.promptService.sendSessionMessage(
          dbSessionId,
          content,
          ...(guard ? ([guard] as const) : [])
        )
      );
      // Persist immediately after dispatch so refresh/replay keeps this user message
      // visible while the provider is still working on the turn.
      for (const { message, order } of dispatched) {
        sessionDomainService.commitSentUserMessageAtOrder(dbSessionId, message, order, {
          emitSnapshot: false,
        });
      }
      sessionDomainService.emitSessionSnapshot(dbSessionId);
      await sendPromise;
      for (const { message, userMessage } of dispatched) {
        sessionDomainService.emitDelta(dbSessionId, {
          type: 'message_state_changed',
          id: message.id,
          newState: MessageState.COMMITTED,
          userMessage,
        });
      }
      await acknowledgeSentBatch({
        sessionId: dbSessionId,
        messages,
        backgroundDelivery: this.dependencies.backgroundDelivery,
        notifications: this.lifecycle.notificationDelivery,
        isCurrent: () => this.isDispatchGenerationCurrent(dbSessionId, stopGeneration),
      });
    } catch (error) {
      if (isCompactCommand && compactionClient) {
        compactionClient.endCompaction();
      }
      throw error;
    }

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Dispatched queued message to Claude', {
        dbSessionId,
        messageId: msg.id,
        remainingInQueue: sessionDomainService.getQueueLength(dbSessionId),
      });
    }
  }

  private async configureBatchForDispatch(
    dbSessionId: string,
    messages: QueuedMessage[],
    msg: QueuedMessage,
    client: unknown,
    stopGeneration: number,
    guard?: SessionCallerGuard
  ): Promise<boolean> {
    if (
      !(await this.configureMessageForDispatch(dbSessionId, msg, client, stopGeneration, guard))
    ) {
      await this.failStoppedBatch(
        dbSessionId,
        messages.filter((other) => other !== msg)
      );
      return false;
    }

    for (const background of messages.filter((message) => message.source && message !== msg)) {
      if (
        !(await this.configureMessageForDispatch(
          dbSessionId,
          background,
          client,
          stopGeneration,
          guard
        ))
      ) {
        messages.splice(messages.indexOf(background), 1);
      }
    }
    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      await this.failStoppedBatch(dbSessionId, messages);
      return false;
    }

    return true;
  }

  private async failStoppedBatch(dbSessionId: string, messages: QueuedMessage[]): Promise<void> {
    for (const message of messages) {
      if (message.source) {
        await this.releaseStoppedBackground(message);
      } else {
        this.failStoppedUserMessage(dbSessionId, message);
      }
    }
  }

  private async configureMessageForDispatch(
    dbSessionId: string,
    msg: QueuedMessage,
    client: unknown,
    stopGeneration: number,
    guard?: SessionCallerGuard
  ): Promise<boolean> {
    if (msg.source) {
      const valid = await this.dependencies.backgroundDelivery.validate(msg);
      if (!(valid && this.isDispatchGenerationCurrent(dbSessionId, stopGeneration))) {
        await this.dependencies.backgroundDelivery.fail(
          msg,
          new Error('PR delivery invalidated before provider enqueue'),
          'cancelled'
        );
        return false;
      }
      return true;
    }
    try {
      msg.settings = await this.dependencies.configService.configureQueuedMessage(
        dbSessionId,
        msg,
        isThinkingBudgetClient(client),
        ...(guard ? ([guard] as const) : [])
      );
    } catch (error) {
      if (this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
        throw error;
      }
      this.failStoppedUserMessage(dbSessionId, msg);
      return false;
    }

    // Configuration calls above yield. Re-check the lifecycle barrier before any
    // dispatch state mutation so a stop cannot be crossed by this dequeued turn.
    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      this.failStoppedUserMessage(dbSessionId, msg);
      return false;
    }
    return true;
  }

  private failStoppedUserMessage(dbSessionId: string, msg: QueuedMessage): void {
    if (this.lifecycle.notificationDelivery.isNotificationMessage(msg.id)) {
      sessionDomainService.emitSessionSnapshot(dbSessionId);
      return;
    }
    sessionDomainService.failMessage(
      dbSessionId,
      msg,
      'Message was not sent because the session stopped during dispatch.'
    );
  }

  private isDispatchGenerationCurrent(dbSessionId: string, stopGeneration: number): boolean {
    return (
      !this.lifecycle.gate.isSessionStopping(dbSessionId) &&
      this.lifecycle.gate.isGenerationCurrent(dbSessionId, stopGeneration)
    );
  }

  private getRequeueReason(
    dbSessionId: string,
    client?: unknown
  ): 'working' | 'compacting' | 'stopped' | null {
    if (this.dependencies.runtimeManager.isSessionPromptInFlight(dbSessionId)) {
      return 'working';
    }
    if (!this.dependencies.runtimeManager.isSessionRunning(dbSessionId)) {
      return 'stopped';
    }
    if (isClaudeCompactionClient(client) && client.isCompactingActive()) {
      return 'compacting';
    }
    return null;
  }

  private isCompactCommand(text: string): boolean {
    const trimmed = text.trim();
    return trimmed === '/compact' || trimmed.startsWith('/compact ');
  }

  private async handleBlockedDispatchGate(
    dbSessionId: string,
    dispatchGate: Exclude<DispatchGateResult, { policy: 'allowed' }>
  ): Promise<void> {
    if (!(dispatchGate.policy === 'blocked' && dispatchGate.permanent)) {
      return;
    }

    const blockedMessage = sessionDomainService.dequeueNext(dbSessionId, {
      emitSnapshot: false,
    });
    if (!blockedMessage) {
      return;
    }

    await this.dependencies.chatIntent?.cancel(dbSessionId, blockedMessage.id, 'failed');
    sessionDomainService.emitDelta(dbSessionId, {
      type: 'message_state_changed',
      id: blockedMessage.id,
      newState: MessageState.REJECTED,
      errorMessage:
        dispatchGate.reason ?? 'Cannot send messages for this workspace in its current state.',
    });
  }

  private async evaluateDispatchGate(dbSessionId: string): Promise<DispatchGateResult> {
    if (this.dependencies.eventAuthority) {
      await this.dependencies.eventAuthority.assertOrdinary(dbSessionId);
    }
    const session = await sessionDataService.findAgentSessionById(dbSessionId);
    if (!session) {
      return {
        policy: 'blocked',
        permanent: true,
        reason: 'Session not found.',
      };
    }

    const dispatchPolicy = this.initPolicy.getWorkspaceInitPolicy(session.workspace).dispatchPolicy;
    if (dispatchPolicy !== 'manual_resume') {
      this.manualDispatchResumed.delete(dbSessionId);
      if (dispatchPolicy === 'allowed') {
        return { policy: 'allowed' };
      }
      const reason = getPermanentBlockedDispatchReason(session.workspace);
      return {
        policy: 'blocked',
        permanent: !!reason,
        reason,
      };
    }

    return this.manualDispatchResumed.get(dbSessionId)
      ? { policy: 'allowed' }
      : { policy: 'manual_resume' };
  }

  /**
   * Evaluate dispatch gate without touching the queue.
   * Message stays in queue — no requeue needed on block.
   */
  private async evaluateDispatchGateSafely(dbSessionId: string): Promise<DispatchGateResult> {
    try {
      return await this.evaluateDispatchGate(dbSessionId);
    } catch (error) {
      if (error instanceof EventSessionFenceError) {
        logger.debug('[Chat WS] Initial delivery holds queued messages', { dbSessionId });
        return { policy: 'blocked', permanent: false, reason: error.message };
      }
      logger.error('[Chat WS] Failed to evaluate dispatch gate', {
        dbSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        policy: 'blocked',
        permanent: false,
        reason: null,
      };
    }
  }
}
