/** Queue execution and dispatch fencing for session messages. */
import { createLogger } from '@/backend/services/logger.service';
import type { SessionInitPolicyBridge } from '@/backend/services/session/service/bridges';
import {
  PermanentAttachmentError,
  processAttachmentsAndBuildContent,
} from '@/backend/services/session/service/chat/chat-message-handlers/attachment-processing';
import { DEBUG_CHAT_WS } from '@/backend/services/session/service/chat/chat-message-handlers/constants';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { toErrorMessage } from '@/backend/services/session/service/lifecycle/session.error-message';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { VOICE_MODE_BREVITY_INSTRUCTION } from '@/backend/services/session/service/voice/voice-mode-instructions';
import {
  type AgentContentItem,
  MessageState,
  type QueuedMessage,
  resolveSelectedModel,
} from '@/shared/acp-protocol';
import {
  acknowledgeSentBatch,
  collectDispatchBatch,
  dispatchCollectedBatch,
  prepareBatchContents,
  combineBatchContents,
} from './session-dispatch-batch';
import type {
  SessionDispatchDependencies,
  SessionDispatchLifecycleDependencies,
  DispatchOptions,
} from './session-dispatch.types';

const logger = createLogger('chat-message-handlers');
const TURN_IN_PROGRESS_RETRY_BASE_MS = 1000;
const TURN_IN_PROGRESS_RETRY_MAX_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

interface ClaudeCompactionClient {
  isCompactingActive: () => boolean;
  startCompaction: () => void;
  endCompaction: () => void;
}

interface ThinkingBudgetClient {
  setMaxThinkingTokens: (tokens: number | null) => Promise<void>;
}

type DispatchGateResult =
  | { policy: 'allowed' }
  | { policy: 'manual_resume' }
  | { policy: 'blocked'; permanent: boolean; reason: string | null };

function isClaudeCompactionClient(value: unknown): value is ClaudeCompactionClient {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ClaudeCompactionClient>;
  return (
    typeof candidate.isCompactingActive === 'function' &&
    typeof candidate.startCompaction === 'function' &&
    typeof candidate.endCompaction === 'function'
  );
}

function isThinkingBudgetClient(value: unknown): value is ThinkingBudgetClient {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ThinkingBudgetClient>;
  return typeof candidate.setMaxThinkingTokens === 'function';
}

// ============================================================================
// Service
// ============================================================================

export class SessionDispatchService {
  constructor(private readonly dependencies: SessionDispatchDependencies) {}

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

  /**
   * Try to dispatch the next queued message to Claude.
   * Auto-starts the client if needed.
   * Uses a guard to prevent concurrent dispatch calls for the same session.
   *
   * The message stays in the queue (visible in snapshots) until we're ready
   * to dispatch, so a page refresh during auto-start won't lose it.
   */
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
    if (this.isDispatchInProgress(dbSessionId)) {
      return;
    }

    const dispatchToken = this.reserveDispatchToken(dbSessionId);

    try {
      // Loop: a dropped duplicate notification advances to the next queued message.
      let outcome: 'continue' | 'done' = 'continue';
      while (outcome === 'continue') {
        outcome = await this.dispatchHeadOfQueue(dbSessionId, stopGeneration);
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
  private async dispatchHeadOfQueue(
    dbSessionId: string,
    stopGeneration: number
  ): Promise<'continue' | 'done'> {
    // Peek first — message stays in queue (visible in snapshots during auto-start).
    const peeked = sessionDomainService.peekNextMessage(dbSessionId);
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
        return this.lifecycle.notificationDelivery.removeDuplicateFromQueue(dbSessionId, peeked.id)
          ? 'continue'
          : 'done';
      }
      if ((await this.dispatchPeekedMessage(dbSessionId, peeked, stopGeneration)) === 'retry') {
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
    stopGeneration: number
  ): Promise<'retry' | undefined> {
    const dispatchGate = await this.evaluateDispatchGateSafely(dbSessionId);
    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      return;
    }
    if (dispatchGate.policy !== 'allowed') {
      this.handleBlockedDispatchGate(dbSessionId, dispatchGate);
      return;
    }

    if (!(await this.prepareBackgroundForDispatch(dbSessionId, peeked, stopGeneration))) {
      return;
    }
    const clientResult = await this.resolvePreparedClientForDispatch(
      dbSessionId,
      peeked,
      stopGeneration
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
    const batch = await collectDispatchBatch({
      sessionId: dbSessionId,
      first: peeked,
      notifications: this.lifecycle.notificationDelivery,
      prepareBackground: async (message) => {
        try {
          return await this.prepareBackgroundForDispatch(dbSessionId, message, stopGeneration);
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
    return dispatchCollectedBatch({
      sessionId: dbSessionId,
      batch,
      backgroundDelivery: this.dependencies.backgroundDelivery,
      isCurrent: () => this.isDispatchGenerationCurrent(dbSessionId, stopGeneration),
      send: (messages) =>
        this.dispatchMessage(dbSessionId, messages, clientResult.client, stopGeneration),
      onError: (message, error) =>
        this.handleDispatchError(dbSessionId, message, error, stopGeneration),
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
    stopGeneration: number
  ): Promise<{ client: unknown } | null> {
    const clientResult = await this.resolveClientForDispatch(dbSessionId, peeked);
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
      await this.dependencies.backgroundDelivery.fail(
        peeked,
        new Error('PR delivery invalidated before dispatch'),
        'cancelled'
      );
      sessionDomainService.removeQueuedMessage(dbSessionId, peeked.id, { expectedMessage: peeked });
      return null;
    }
    return clientResult;
  }

  private async prepareBackgroundForDispatch(
    dbSessionId: string,
    peeked: QueuedMessage,
    stopGeneration: number
  ): Promise<boolean> {
    if (peeked.source) {
      if (
        this.dependencies.runtimeManager.isSessionPromptInFlight(dbSessionId) ||
        sessionDomainService.getPendingInteractiveRequest(dbSessionId)
      ) {
        return false;
      }
      const prepared = await this.dependencies.backgroundDelivery.prepare(dbSessionId, peeked);
      if (prepared.status === 'discard') {
        sessionDomainService.removeQueuedMessage(dbSessionId, peeked.id, {
          expectedMessage: peeked,
        });
        return false;
      }
      if (prepared.status !== 'ready') {
        return false;
      }
      if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
        await this.dependencies.backgroundDelivery.fail(
          peeked,
          new Error('Session stopped before dispatch'),
          'cancelled'
        );
        return false;
      }
    }
    return true;
  }

  // ============================================================================
  // Private: Dispatch Helpers
  // ============================================================================

  /**
   * Handle a dispatch error. Permanent input errors are rejected, provider-busy
   * errors are re-queued with backoff, and all other errors fail for explicit retry.
   */
  private handleDispatchError(
    dbSessionId: string,
    msg: QueuedMessage,
    error: unknown,
    stopGeneration: number
  ): void {
    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      sessionDomainService.removeTranscriptMessageById(dbSessionId, msg.id, {
        emitSnapshot: false,
        preservePRUpdateOutcome: true,
      });
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
    msg: QueuedMessage
  ): Promise<{ client: unknown } | { blocked: 'busy' | 'resume_failed' } | null> {
    let client = this.lifecycle.startup.getSessionClient(dbSessionId);

    if (!client || msg.source) {
      const started = await this.autoStartClientForQueue(dbSessionId, msg);
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
  private async autoStartClientForQueue(dbSessionId: string, msg: QueuedMessage): Promise<boolean> {
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
          ? { resumePolicy: 'require_existing' }
          : {
              thinkingEnabled: msg.settings.thinkingEnabled,
              planModeEnabled: msg.settings.planModeEnabled,
              model: msg.settings.selectedModel ?? undefined,
              reasoningEffort: msg.settings.reasoningEffort ?? undefined,
            }
      );
      return true;
    } catch (error) {
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
    stopGeneration: number
  ): Promise<void> {
    const contents = prepareBatchContents(
      messages,
      (message) => this.buildMessageContent(message),
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
      !(await this.configureBatchForDispatch(dbSessionId, messages, msg, client, stopGeneration))
    ) {
      return;
    }

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

    if (isCompactCommand && compactionClient) {
      compactionClient.startCompaction();
    }

    try {
      const sendPromise = this.dependencies.promptService.sendSessionMessage(dbSessionId, content);
      // Persist immediately after dispatch so refresh/replay keeps this user message
      // visible while the provider is still working on the turn.
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
    stopGeneration: number
  ): Promise<boolean> {
    if (!(await this.configureMessageForDispatch(dbSessionId, msg, client, stopGeneration))) {
      await this.failStoppedBatch(
        dbSessionId,
        messages.filter((other) => other !== msg)
      );
      return false;
    }

    for (const background of messages.filter((message) => message.source && message !== msg)) {
      if (
        !(await this.configureMessageForDispatch(dbSessionId, background, client, stopGeneration))
      ) {
        messages.splice(messages.indexOf(background), 1);
      }
    }
    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      await this.failStoppedBatch(
        dbSessionId,
        messages.filter((message) => !message.source)
      );
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
    stopGeneration: number
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
        isThinkingBudgetClient(client)
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

  /**
   * Build message content for sending to Claude.
   * Note: Thinking is now controlled via setMaxThinkingTokens, not message suffix.
   *
   * Text attachments are combined into the main text content with a prefix.
   * Image attachments are sent as separate image content blocks.
   */
  private buildMessageContent(msg: QueuedMessage): string | AgentContentItem[] {
    const content = processAttachmentsAndBuildContent(msg.text, msg.attachments);
    if (!msg.voiceMode) {
      return content;
    }
    const blocks: AgentContentItem[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    return [...blocks, { type: 'text', text: VOICE_MODE_BREVITY_INSTRUCTION }];
  }

  private handleBlockedDispatchGate(
    dbSessionId: string,
    dispatchGate: Exclude<DispatchGateResult, { policy: 'allowed' }>
  ): void {
    if (!(dispatchGate.policy === 'blocked' && dispatchGate.permanent)) {
      return;
    }

    const blockedMessage = sessionDomainService.dequeueNext(dbSessionId, {
      emitSnapshot: false,
    });
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

  private getPermanentBlockedDispatchReason(workspace: {
    status?: string | null;
    worktreePath?: string | null;
  }): string | null {
    if (workspace.status === 'ARCHIVING' || workspace.status === 'ARCHIVED') {
      return 'Workspace is archived or archiving and cannot accept new messages.';
    }

    if (workspace.status === 'FAILED' && !workspace.worktreePath) {
      return 'Workspace setup failed before worktree creation. Retry setup before sending messages.';
    }

    return null;
  }

  private async evaluateDispatchGate(dbSessionId: string): Promise<DispatchGateResult> {
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
      const reason = this.getPermanentBlockedDispatchReason(session.workspace);
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
