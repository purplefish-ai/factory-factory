/**
 * Chat Message Handlers Service
 *
 * Handles message dispatch and all message type handlers for chat sessions.
 * Responsible for:
 * - Message queue dispatch logic
 * - All message type handlers (start, queue_message, stop, etc.)
 * - Model validation
 */

import type { WebSocket } from 'ws';
import { createLogger } from '@/backend/services/logger.service';
import type { SessionInitPolicyBridge } from '@/backend/services/session/service/bridges';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { toErrorMessage } from '@/backend/services/session/service/lifecycle/session.error-message';
import { sessionService } from '@/backend/services/session/service/lifecycle/session.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { workspaceNotificationAccessor } from '@/backend/services/workspace';
import {
  type AgentContentItem,
  DEFAULT_THINKING_BUDGET,
  MessageState,
  type QueuedMessage,
  resolveSelectedModel,
} from '@/shared/acp-protocol';
import type { ChatMessageInput } from '@/shared/websocket';
import { WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX } from '@/shared/workspace-notifications';
import {
  PermanentAttachmentError,
  processAttachmentsAndBuildContent,
} from './chat-message-handlers/attachment-processing';
import { DEBUG_CHAT_WS } from './chat-message-handlers/constants';
import { createChatMessageHandlerRegistry } from './chat-message-handlers/registry';
import type { ClientCreator } from './chat-message-handlers/types';

const logger = createLogger('chat-message-handlers');
const TURN_IN_PROGRESS_RETRY_BASE_MS = 1000;
const TURN_IN_PROGRESS_RETRY_MAX_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

export type { ClientCreator } from './chat-message-handlers/types';

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

type DispatchOptions = {
  bypassTurnInProgressBackoff?: boolean;
};

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

class ChatMessageHandlerService {
  /** Guard to prevent concurrent tryDispatchNextMessage calls per session. */
  private dispatchInProgress = new Map<string, number>();
  /** Monotonic token to invalidate stale dispatch completions. */
  private nextDispatchToken = 1;
  /** Retry timers for provider-side busy responses that are not reflected locally yet. */
  private turnInProgressRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private turnInProgressRetryAttempts = new Map<string, number>();
  /**
   * Workspace notifications currently being delivered, keyed by notification id
   * with the owning session as value. Claimed synchronously before dispatch so a
   * concurrent dispatch of a duplicate copy (persist-first delivery can enqueue
   * the same notification on two sessions) drops instead of double-sending.
   * Released once the send settles, or when the owning session is reset — a hung
   * send must not block redelivery of a still-pending notification forever.
   */
  private inFlightNotificationDeliveries = new Map<string, string>();

  /** Client creator function - injected to avoid circular dependencies */
  private clientCreator: ClientCreator | null = null;
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

  private get initPolicy(): SessionInitPolicyBridge {
    if (!this.initPolicyBridge) {
      throw new Error(
        'ChatMessageHandlerService not configured: initPolicy bridge missing. Call configure() first.'
      );
    }
    return this.initPolicyBridge;
  }

  private handlerRegistry = createChatMessageHandlerRegistry({
    sessionService,
    getClientCreator: () => this.clientCreator,
    tryDispatchNextMessage: this.tryDispatchNextMessage.bind(this),
    setManualDispatchResume: this.setManualDispatchResume.bind(this),
    resetDispatchState: this.resetDispatchState.bind(this),
  });

  /**
   * Set the client creator (called during initialization).
   */
  setClientCreator(creator: ClientCreator): void {
    this.clientCreator = creator;
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
    for (const [notificationId, ownerSessionId] of this.inFlightNotificationDeliveries) {
      if (ownerSessionId === sessionId) {
        this.inFlightNotificationDeliveries.delete(notificationId);
      }
    }
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
    const stopGeneration = sessionService.getStopGeneration(dbSessionId);
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

    const claim = this.claimNotificationForDispatch(dbSessionId, peeked.id);
    if (claim.status === 'duplicate') {
      return this.dropDuplicateNotification(dbSessionId, peeked.id) ? 'continue' : 'done';
    }

    try {
      if (
        claim.status === 'claimed' &&
        (await this.isNotificationRowDelivered(claim.notificationId))
      ) {
        return this.dropDuplicateNotification(dbSessionId, peeked.id) ? 'continue' : 'done';
      }
      await this.dispatchPeekedMessage(dbSessionId, peeked, stopGeneration);
      return 'done';
    } finally {
      if (claim.status === 'claimed') {
        this.releaseNotificationClaim(dbSessionId, claim.notificationId);
      }
    }
  }

  /**
   * Release a notification claim, but only if this session still owns it — a
   * reset may have transferred the claim to another session's retry while a
   * stale dispatch was hung in send.
   */
  private releaseNotificationClaim(dbSessionId: string, notificationId: string): void {
    if (this.inFlightNotificationDeliveries.get(notificationId) === dbSessionId) {
      this.inFlightNotificationDeliveries.delete(notificationId);
    }
  }

  /**
   * Persist-first delivery can enqueue the same workspace notification twice
   * (a live send racing session-startup delivery). Claim the notification
   * synchronously — no awaits between the duplicate checks and the claim —
   * so concurrent dispatches on other sessions see it as in flight.
   */
  private claimNotificationForDispatch(
    dbSessionId: string,
    messageId: string
  ): { status: 'none' } | { status: 'duplicate' } | { status: 'claimed'; notificationId: string } {
    const notificationId = this.getWorkspaceNotificationId(messageId);
    if (!notificationId) {
      return { status: 'none' };
    }
    if (
      this.inFlightNotificationDeliveries.has(notificationId) ||
      this.isNotificationCommittedToTranscript(dbSessionId, messageId)
    ) {
      return { status: 'duplicate' };
    }
    this.inFlightNotificationDeliveries.set(notificationId, dbSessionId);
    return { status: 'claimed', notificationId };
  }

  private async dispatchPeekedMessage(
    dbSessionId: string,
    peeked: QueuedMessage,
    stopGeneration: number
  ): Promise<void> {
    const dispatchGate = await this.evaluateDispatchGateSafely(dbSessionId);
    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      return;
    }
    if (dispatchGate.policy !== 'allowed') {
      this.handleBlockedDispatchGate(dbSessionId, dispatchGate);
      return;
    }

    const clientResult = await this.resolveClientForDispatch(dbSessionId, peeked);
    if (!clientResult) {
      return;
    }

    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      return;
    }

    // NOW dequeue — client is ready, we're about to dispatch.
    const msg = sessionDomainService.dequeueNext(dbSessionId, { emitSnapshot: false });
    if (!msg) {
      return;
    }

    try {
      await this.dispatchMessage(dbSessionId, msg, clientResult.client, stopGeneration);
      this.turnInProgressRetryAttempts.delete(dbSessionId);
    } catch (error) {
      this.handleDispatchError(dbSessionId, msg, error, stopGeneration);
    }
  }

  /**
   * Handle incoming chat messages by type.
   */
  async handleMessage(
    ws: WebSocket,
    dbSessionId: string | null,
    workingDir: string,
    message: ChatMessageInput
  ): Promise<void> {
    const handler = this.handlerRegistry[message.type] as
      | ((context: {
          ws: WebSocket;
          sessionId: string;
          workingDir: string;
          message: ChatMessageInput;
        }) => Promise<void> | void)
      | undefined;

    if (!handler) {
      logger.warn('[Chat WS] No handler registered for message type', { type: message.type });
      return;
    }

    // All other operations require a session
    if (!dbSessionId) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'No session selected. Please create or select a session first.',
        })
      );
      return;
    }

    await handler({ ws, sessionId: dbSessionId, workingDir, message });
  }

  // ============================================================================
  // Private: Dispatch Helpers
  // ============================================================================

  /**
   * Handle a dispatch error. Permanent errors (e.g. unsupported image format) are
   * rejected so the user sees a clear message. Transient errors are re-queued.
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
      if (sessionService.isSessionRunning(dbSessionId)) {
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
      if (sessionService.isSessionRunning(dbSessionId)) {
        sessionDomainService.markRunning(dbSessionId);
      }
      sessionDomainService.requeueFront(dbSessionId, msg);
      this.scheduleTurnInProgressRetry(dbSessionId);
      return;
    }

    // Transient errors: dispatch can fail after we pessimistically committed the
    // user message to transcript for refresh safety. Roll it back before
    // re-queueing so clients do not see the same message as both queued and committed.
    logger.error('[Chat WS] Failed to dispatch message, re-queueing', {
      dbSessionId,
      messageId: msg.id,
      error: this.formatDispatchError(error),
    });
    sessionDomainService.removeTranscriptMessageById(dbSessionId, msg.id, {
      emitSnapshot: false,
    });
    // Avoid clobbering markProcessExit() runtime/lastExit when the process
    // has already stopped and exit handling is in flight.
    if (sessionService.isSessionRunning(dbSessionId)) {
      sessionDomainService.markIdle(dbSessionId, 'alive');
    }
    sessionDomainService.requeueFront(dbSessionId, msg);
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
  ): Promise<{ client: unknown } | null> {
    let client = sessionService.getSessionClient(dbSessionId);

    let justAutoStarted = false;
    if (!client) {
      const started = await this.autoStartClientForQueue(dbSessionId, msg);
      if (!started) {
        return null;
      }
      client = sessionService.getSessionClient(dbSessionId);
      justAutoStarted = true;
    }

    // Skip requeue check when the client was just auto-started: the "working" state
    // comes from the startup itself, not from a prior user message being processed.
    if (!justAutoStarted) {
      const reason = this.getRequeueReason(dbSessionId, client);
      if (reason) {
        return null;
      }
    }

    return { client };
  }

  /**
   * Auto-start a client for queue dispatch using settings from the provided message.
   */
  private async autoStartClientForQueue(dbSessionId: string, msg: QueuedMessage): Promise<boolean> {
    if (!this.clientCreator) {
      logger.error('[Chat WS] Client creator not set');
      const errorMessage = 'Failed to start agent: client creator not configured';
      sessionDomainService.markError(dbSessionId, errorMessage);
      sessionDomainService.emitDelta(dbSessionId, {
        type: 'error',
        message: errorMessage,
      });
      return false;
    }

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Auto-starting client for queued message', { dbSessionId });
    }

    try {
      await this.clientCreator.getOrCreate(dbSessionId, {
        thinkingEnabled: msg.settings.thinkingEnabled,
        planModeEnabled: msg.settings.planModeEnabled,
        model: msg.settings.selectedModel ?? undefined,
        reasoningEffort: msg.settings.reasoningEffort ?? undefined,
      });
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
    msg: QueuedMessage,
    client: unknown,
    stopGeneration: number
  ): Promise<void> {
    const isCompactCommand = this.isCompactCommand(msg.text);
    const compactionClient = isClaudeCompactionClient(client) ? client : null;

    // Only clients that expose thinking-budget controls support this feature.
    // Keep this before state mutation so provider errors can be safely requeued.
    if (isThinkingBudgetClient(client)) {
      const thinkingTokens = msg.settings.thinkingEnabled ? DEFAULT_THINKING_BUDGET : null;
      await sessionService.setSessionThinkingBudget(dbSessionId, thinkingTokens);
    }
    await sessionService.setSessionModel(dbSessionId, msg.settings.selectedModel ?? undefined);
    await sessionService.setSessionReasoningEffort(
      dbSessionId,
      msg.settings.reasoningEffort ?? null
    );

    // Configuration calls above yield. Re-check the lifecycle barrier before any
    // dispatch state mutation so a stop cannot be crossed by this dequeued turn.
    if (!this.isDispatchGenerationCurrent(dbSessionId, stopGeneration)) {
      return;
    }

    sessionDomainService.markRunning(dbSessionId);

    // Build content and send to Claude
    const content = this.buildMessageContent(msg);
    const order = sessionDomainService.allocateOrder(dbSessionId);
    const dispatchedUserMessage = {
      text: msg.text,
      timestamp: msg.timestamp,
      attachments: msg.attachments,
      settings: {
        ...msg.settings,
        selectedModel: resolveSelectedModel(msg.settings.selectedModel),
        reasoningEffort: msg.settings.reasoningEffort,
      },
      order,
    };

    sessionDomainService.emitDelta(dbSessionId, {
      type: 'message_state_changed',
      id: msg.id,
      newState: MessageState.DISPATCHED,
      userMessage: dispatchedUserMessage,
    });

    if (isCompactCommand && compactionClient) {
      compactionClient.startCompaction();
    }

    try {
      const sendPromise = sessionService.sendSessionMessage(dbSessionId, content);
      // Persist immediately after dispatch so refresh/replay keeps this user message
      // visible while the provider is still working on the turn.
      sessionDomainService.commitSentUserMessageAtOrder(dbSessionId, msg, order);
      await sendPromise;
      sessionDomainService.emitDelta(dbSessionId, {
        type: 'message_state_changed',
        id: msg.id,
        newState: MessageState.COMMITTED,
        userMessage: dispatchedUserMessage,
      });
      await this.markWorkspaceNotificationDeliveredIfNeeded(msg.id);
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

  private getWorkspaceNotificationId(messageId: string): string | null {
    if (!messageId.startsWith(WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX)) {
      return null;
    }
    const notificationId = messageId.slice(WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX.length);
    return notificationId || null;
  }

  private isNotificationCommittedToTranscript(dbSessionId: string, messageId: string): boolean {
    return sessionDomainService
      .getTranscriptSnapshot(dbSessionId)
      .some((entry) => entry.source === 'user' && entry.id === messageId);
  }

  private async isNotificationRowDelivered(notificationId: string): Promise<boolean> {
    try {
      const notification = await workspaceNotificationAccessor.findById(notificationId);
      return notification?.deliveredAt != null;
    } catch (error) {
      logger.warn('[Chat WS] Failed to check workspace notification delivery state', {
        notificationId,
        error: this.formatDispatchError(error),
      });
      // Fail open: a duplicate delivery is better than a lost message.
      return false;
    }
  }

  /**
   * Remove a duplicate workspace notification from the queue, emitting a queue
   * snapshot so the UI does not keep a phantom queued card. Returns false if the
   * message was unexpectedly absent (caller should stop looping).
   */
  private dropDuplicateNotification(dbSessionId: string, messageId: string): boolean {
    logger.info('[Chat WS] Dropping already-delivered workspace notification', {
      dbSessionId,
      messageId,
    });
    return sessionDomainService.removeQueuedMessage(dbSessionId, messageId);
  }

  private async markWorkspaceNotificationDeliveredIfNeeded(messageId: string): Promise<void> {
    const notificationId = this.getWorkspaceNotificationId(messageId);
    if (!notificationId) {
      return;
    }

    try {
      await workspaceNotificationAccessor.markDelivered([notificationId]);
    } catch (error) {
      logger.warn('[Chat WS] Failed to mark workspace notification delivered', {
        messageId,
        notificationId,
        error: this.formatDispatchError(error),
      });
    }
  }

  private isDispatchGenerationCurrent(dbSessionId: string, stopGeneration: number): boolean {
    return (
      !sessionService.isSessionStopping(dbSessionId) &&
      sessionService.getStopGeneration(dbSessionId) === stopGeneration
    );
  }

  private getRequeueReason(
    dbSessionId: string,
    client?: unknown
  ): 'working' | 'compacting' | 'stopped' | null {
    if (sessionService.isSessionWorking(dbSessionId)) {
      return 'working';
    }
    if (!sessionService.isSessionRunning(dbSessionId)) {
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
    return processAttachmentsAndBuildContent(msg.text, msg.attachments);
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

  // ============================================================================
  // Private: Message handlers now live in chat-message-handlers/handlers
  // ============================================================================
}

export const chatMessageHandlerService = new ChatMessageHandlerService();
