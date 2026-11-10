import { WorkspaceInitFenceError } from '@/backend/lib/workspace-init-fence-error';
import { applicationUpdateAdmission } from '@/backend/services/application-update-admission.service';
/** Queue execution and dispatch fencing for session messages. */
import { createLogger } from '@/backend/services/logger.service';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { AcpSteeringNotSentError } from '@/backend/services/session/service/acp/acp-steering';
import type { SessionInitPolicyBridge } from '@/backend/services/session/service/bridges';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import { PermanentAttachmentError } from '@/backend/services/session/service/chat/chat-message-handlers/attachment-processing';
import { DEBUG_CHAT_WS } from '@/backend/services/session/service/chat/chat-message-handlers/constants';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { EventSessionFenceError } from '@/backend/services/session/service/lifecycle/event-session-fence-error';
import { createPRDeliveryBlockedError } from '@/backend/services/session/service/lifecycle/pr-delivery-failure';
import {
  isTurnAlreadyInProgressError,
  toErrorMessage,
} from '@/backend/services/session/service/lifecycle/session.error-message';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { MessageState, type QueuedMessage, resolveSelectedModel } from '@/shared/acp-protocol';
import {
  acknowledgeSentBatch,
  rollbackStoppedDispatchMessage,
  prepareBackgroundForDispatch,
  collectDispatchBatch,
  dispatchCollectedBatch,
  prepareBatchContents,
  combineBatchContents,
} from './session-dispatch-batch';
import { SessionDispatchClaim } from './session-dispatch-claim';
import {
  type DispatchGateResult,
  getPermanentBlockedDispatchReason,
} from './session-dispatch-gate';
import { SessionDispatchRetry } from './session-dispatch-retry';
import type {
  SessionDispatchDependencies,
  SessionDispatchLifecycleDependencies,
  DispatchOptions,
} from './session-dispatch.types';
import {
  mailRecoveryRetryGuard,
  wrapUnsentDispatchGuard,
  steerOwnedWorkspaceMailSignal,
  requeueProvenUnsentMessage,
  sendArmedWorkspaceMailBatch,
  reportAmbiguousWorkspaceMailFailure,
} from './session-mail-signal-dispatch';
import { buildMessageContent } from './session-message-content';
import { SessionQueuedSteering } from './session-queued-steering';

const logger = createLogger('chat-message-handlers');

export class SessionDispatchService {
  private readonly steering = new SessionQueuedSteering({
    isPromptInFlight: (id) => this.dependencies.runtimeManager.isSessionPromptInFlight(id),
    captureGuard: (id) => {
      const generation = this.lifecycle.gate.getGeneration(id);
      return () => this.isDispatchGenerationCurrent(id, generation);
    },
    isAllowed: async (id) => (await this.evaluateDispatchGateSafely(id)).policy === 'allowed',
    send: (id, content, options) =>
      this.dependencies.promptService.steerSessionMessage(
        id,
        content,
        ...(options ? [options] : [])
      ),
    dispatch: (id) => this.tryDispatchNextMessage(id),
  });
  constructor(private readonly dependencies: SessionDispatchDependencies) {}
  steerQueuedMessage(sessionId: string, messageId: string): Promise<void> {
    return this.steering.steer(sessionId, messageId);
  }

  /** Only the exact body-free signal held by notification delivery may use this path. */
  steerWorkspaceMailSignal(sessionId: string, messageId: string): Promise<void> {
    return steerOwnedWorkspaceMailSignal(
      sessionId,
      messageId,
      this.lifecycle.notificationDelivery,
      this.steering
    );
  }

  private readonly dispatchClaim = new SessionDispatchClaim();
  private readonly retry = new SessionDispatchRetry((id, options) =>
    this.tryDispatchNextMessage(id, options)
  );
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
    dependencies.notificationDelivery.configureRetry((input) => {
      const generation = this.lifecycle.gate.getGeneration(input.sessionId);
      this.retry.schedule(
        input.sessionId,
        {
          guard: mailRecoveryRetryGuard(input, () =>
            this.isDispatchGenerationCurrent(input.sessionId, generation)
          ),
        },
        Math.max(0, input.retryAt.getTime() - Date.now())
      );
    });
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

  /** Runs at the end of every stop (session scope `completeStop`). */
  resetDispatchState(sessionId: string): void {
    this.steering.reset(sessionId);
    this.dispatchClaim.reset(sessionId);
    this.retry.clear(sessionId);
    this.notificationDeliveryService?.resetSession(sessionId);
  }

  /** Drops everything retained for a deleted session (session scope `forget`). */
  forgetSession(sessionId: string): void {
    this.resetDispatchState(sessionId);
    this.manualDispatchResumed.delete(sessionId);
  }

  /**
   * Application shutdown: cancel pending queue retries, refuse new ones and
   * wait for retries already dispatching. Stopping all clients does not run
   * per-session stops, so their retry timers would otherwise keep firing.
   */
  shutdown(): Promise<void> {
    return this.retry.stop();
  }

  /** Keep messages queued during preparation so refresh cannot lose them. */
  tryDispatchNextMessage(dbSessionId: string, options: DispatchOptions = {}): Promise<void> {
    return applicationUpdateAdmission.run(() => this.dispatchAdmitted(dbSessionId, options));
  }

  private async dispatchAdmitted(dbSessionId: string, options: DispatchOptions): Promise<void> {
    const stopGeneration = this.lifecycle.gate.getGeneration(dbSessionId);
    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      return;
    }

    if (this.retry.has(dbSessionId)) {
      if (options.bypassTurnInProgressBackoff) {
        this.retry.clear(dbSessionId);
      } else {
        return;
      }
    }

    // Guard against concurrent dispatch calls for the same session
    if (this.steering.isPending(dbSessionId) || this.dispatchClaim.request(dbSessionId)) {
      return;
    }

    const dispatchToken = this.dispatchClaim.reserve(dbSessionId);

    try {
      await this.lifecycle.notificationDelivery.recoverSession(dbSessionId, async () => {
        await options.guard?.check();
        options.guard?.assertCurrent?.();
        if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
          throw new Error('Session stopped before mail recovery');
        }
      });
      // Loop: a dropped duplicate notification advances to the next queued message.
      let outcome: 'continue' | 'done' = 'continue';
      while (outcome === 'continue') {
        await options.guard?.check();
        options.guard?.assertCurrent?.();
        outcome = await this.dispatchHeadOfQueue(dbSessionId, stopGeneration, options.guard);
      }
    } finally {
      const requested = this.dispatchClaim.release(dbSessionId, dispatchToken);
      if (requested && this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
        await this.tryDispatchNextMessage(dbSessionId, options).catch((error) => {
          logger.debug('Deferred dispatch rejected by original caller authority', {
            dbSessionId,
            error,
          });
        });
      }
    }
  }

  /**
   * Examine the head of the queue: drop it if it is a duplicate workspace
   * notification ('continue' — caller should examine the new head), otherwise
   * dispatch it ('done').
   */
  private async dispatchHeadOfQueue(
    dbSessionId: string,
    stopGeneration: number,
    guard?: SessionCallerGuard
  ): Promise<'continue' | 'done'> {
    await guard?.check();
    guard?.assertCurrent?.();
    // Peek first — message stays in queue (visible in snapshots during auto-start).
    const peeked = sessionDomainService.peekNextMessage(dbSessionId);
    if (!peeked) {
      this.retry.resetAttempts(dbSessionId);
      return 'done';
    }

    const claim = this.lifecycle.notificationDelivery.claimForDispatch(dbSessionId, peeked.id);
    switch (claim.status) {
      case 'quarantined':
        return 'done';
      case 'duplicate':
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
      this.handleBlockedDispatchGate(dbSessionId, dispatchGate);
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
        createPRDeliveryBlockedError('preempted')
      );
      return;
    }
    await guard?.check();
    guard?.assertCurrent?.();
    const batch = await collectDispatchBatch({
      sessionId: dbSessionId,
      first: peeked,
      notifications: this.lifecycle.notificationDelivery,
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
    const isStoreCurrent = sessionDomainService.captureStoreGuard(dbSessionId);
    return dispatchCollectedBatch({
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
      send: (messages) => this.dispatchMessage(dbSessionId, messages, stopGeneration, guard),
      onError: (message, error) =>
        isStoreCurrent() &&
        this.handleDispatchError(
          dbSessionId,
          message,
          error,
          stopGeneration,
          clientResult.client,
          guard
        ),
      onSuccess: () => {
        this.retry.resetAttempts(dbSessionId);
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
  ): Promise<{ client: AcpProcessHandle } | null> {
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
          createPRDeliveryBlockedError(clientResult.blocked)
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

  /** Reject permanent input, retry proven-unsent work, and quarantine ambiguous mail. */
  private handleDispatchError(
    dbSessionId: string,
    msg: QueuedMessage,
    error: unknown,
    stopGeneration: number,
    capturedClient?: AcpProcessHandle,
    guard?: SessionCallerGuard
  ): void {
    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      rollbackStoppedDispatchMessage(dbSessionId, msg, this.notificationDeliveryService, error);
      return;
    }

    if (this.lifecycle.notificationDelivery.isMailSignalQuarantined(msg.id)) {
      reportAmbiguousWorkspaceMailFailure(dbSessionId, msg, error, () => {
        if (
          capturedClient === this.lifecycle.startup.getSessionClient(dbSessionId) &&
          !this.dependencies.runtimeManager.isSessionPromptInFlight(dbSessionId)
        ) {
          this.markDispatchError(dbSessionId, this.formatDispatchError(error));
        }
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

    if (isTurnAlreadyInProgressError(error)) {
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
      this.retry.schedule(dbSessionId, { guard });
      return;
    }

    if (error instanceof AcpSteeringNotSentError) {
      requeueProvenUnsentMessage(
        dbSessionId,
        msg,
        this.dependencies.runtimeManager.isSessionRunning(dbSessionId),
        () => this.retry.schedule(dbSessionId, { guard })
      );
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
    this.retry.resetAttempts(dbSessionId);
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

  private formatDispatchError(error: unknown): string {
    return toErrorMessage(error);
  }

  /** Resolve or start a dispatch client; null means dispatch remains blocked. */
  private async resolveClientForDispatch(
    dbSessionId: string,
    msg: QueuedMessage,
    guard?: SessionCallerGuard
  ): Promise<{ client: AcpProcessHandle } | { blocked: 'busy' | 'resume_failed' } | null> {
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
    const reason = this.getRequeueReason(dbSessionId);
    if (reason || !client) {
      return msg.source && reason && reason !== 'stopped' ? { blocked: 'busy' } : null;
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

  private async dispatchMessage(
    dbSessionId: string,
    messages: QueuedMessage[],
    stopGeneration: number,
    callerGuard?: SessionCallerGuard
  ): Promise<void> {
    const guard = wrapUnsentDispatchGuard(callerGuard);
    await guard?.check();
    guard?.assertCurrent?.();
    const contents = prepareBatchContents(
      messages,
      (message) => buildMessageContent(message),
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
    if (
      !(await this.configureBatchForDispatch(dbSessionId, messages, msg, stopGeneration, guard))
    ) {
      return;
    }

    await guard?.check();
    guard?.assertCurrent?.();
    sessionDomainService.markRunning(dbSessionId);

    const content = combineBatchContents(messages, contents);
    const dispatched = messages.map((message) => {
      if (!message.source) {
        message.settings = { ...msg.settings };
      }
      const order = sessionDomainService.allocateOrder(dbSessionId);
      const userMessage = {
        text: message.text,
        timestamp: message.timestamp,
        attachments: message.attachments,
        settings: {
          ...msg.settings,
          selectedModel: resolveSelectedModel(msg.settings.selectedModel),
        },
        order,
      };
      sessionDomainService.emitDelta(dbSessionId, {
        type: 'message_state_changed',
        id: message.id,
        newState: MessageState.DISPATCHED,
        userMessage,
      });
      return { message, order, userMessage };
    });

    const sendPromise = sendArmedWorkspaceMailBatch({
      sessionId: dbSessionId,
      messages,
      notifications: this.lifecycle.notificationDelivery,
      assertCurrent: () => {
        guard?.assertCurrent?.();
        if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
          throw new AcpSteeringNotSentError('Session stopped before mail dispatch');
        }
      },
      send: () =>
        this.dependencies.promptService.sendSessionMessage(
          dbSessionId,
          content,
          ...(guard ? ([guard] as const) : [])
        ),
    });
    // Persist immediately after dispatch so refresh/replay keeps this user message
    // visible while the provider is still working on the turn. Each commit
    // publishes only its entry and the remaining queue.
    for (const { message, order } of dispatched) {
      sessionDomainService.commitSentUserMessageAtOrder(dbSessionId, message, order);
    }
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
    stopGeneration: number,
    guard?: SessionCallerGuard
  ): Promise<boolean> {
    if (!(await this.configureMessageForDispatch(dbSessionId, msg, stopGeneration, guard))) {
      await this.failStoppedBatch(
        dbSessionId,
        messages.filter((other) => other !== msg)
      );
      return false;
    }

    for (const background of messages.filter((message) => message.source && message !== msg)) {
      if (
        !(await this.configureMessageForDispatch(dbSessionId, background, stopGeneration, guard))
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
      // The notification was taken from the queue without publication.
      sessionDomainService.publishQueue(dbSessionId);
      return;
    }
    sessionDomainService.failMessage(
      dbSessionId,
      msg,
      'Message was not sent because the session stopped during dispatch.'
    );
  }

  /** Dispatch yields only to stops; startup-lease churn must not strand the queue. */
  private isDispatchGenerationCurrent(dbSessionId: string, stopGeneration: number): boolean {
    return !(
      this.lifecycle.gate.isSessionStopping(dbSessionId) ||
      this.lifecycle.gate.hasStopSince(dbSessionId, stopGeneration)
    );
  }

  private getRequeueReason(dbSessionId: string): 'working' | 'stopped' | null {
    if (this.dependencies.runtimeManager.isSessionPromptInFlight(dbSessionId)) {
      return 'working';
    }
    if (!this.dependencies.runtimeManager.isSessionRunning(dbSessionId)) {
      return 'stopped';
    }
    return null;
  }

  private handleBlockedDispatchGate(
    dbSessionId: string,
    dispatchGate: Exclude<DispatchGateResult, { policy: 'allowed' }>
  ): void {
    if (!(dispatchGate.policy === 'blocked' && dispatchGate.permanent)) {
      return;
    }

    const blockedMessage = sessionDomainService.dequeueNext(dbSessionId, { publish: false });
    if (!blockedMessage) {
      return;
    }

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
