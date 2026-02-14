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
import type { SessionInitPolicyBridge } from '@/backend/domains/session/bridges';
import { sessionDataService } from '@/backend/domains/session/data/session-data.service';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { createLogger } from '@/backend/services/logger.service';
import {
  type AgentContentItem,
  DEFAULT_THINKING_BUDGET,
  MessageState,
  type QueuedMessage,
  resolveSelectedModel,
} from '@/shared/acp-protocol';
import type { ChatMessageInput } from '@/shared/websocket';
import { processAttachmentsAndBuildContent } from './chat-message-handlers/attachment-processing';
import { DEBUG_CHAT_WS } from './chat-message-handlers/constants';
import { createChatMessageHandlerRegistry } from './chat-message-handlers/registry';
import type { ClientCreator } from './chat-message-handlers/types';

const logger = createLogger('chat-message-handlers');

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
  /** Guard to prevent concurrent tryDispatchNextMessage calls per session */
  private dispatchInProgress = new Map<string, boolean>();

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
    getClientCreator: () => this.clientCreator,
    tryDispatchNextMessage: this.tryDispatchNextMessage.bind(this),
    setManualDispatchResume: this.setManualDispatchResume.bind(this),
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

  private isDispatchInProgress(dbSessionId: string): boolean {
    if (!this.dispatchInProgress.get(dbSessionId)) {
      return false;
    }
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Dispatch already in progress, skipping', { dbSessionId });
    }
    return true;
  }

  /**
   * Try to dispatch the next queued message to Claude.
   * Auto-starts the client if needed.
   * Uses a guard to prevent concurrent dispatch calls for the same session.
   *
   * The message stays in the queue (visible in snapshots) until we're ready
   * to dispatch, so a page refresh during auto-start won't lose it.
   */
  async tryDispatchNextMessage(dbSessionId: string): Promise<void> {
    // Guard against concurrent dispatch calls for the same session
    if (this.isDispatchInProgress(dbSessionId)) {
      return;
    }

    this.dispatchInProgress.set(dbSessionId, true);

    try {
      // Peek first — message stays in queue (visible in snapshots during auto-start).
      const peeked = sessionDomainService.peekNextMessage(dbSessionId);
      if (!peeked) {
        return;
      }

      const dispatchGate = await this.evaluateDispatchGateSafely(dbSessionId);
      if (dispatchGate.policy !== 'allowed') {
        this.handleBlockedDispatchGate(dbSessionId, dispatchGate);
        return;
      }

      const client = await this.ensureClientReady(dbSessionId, peeked);
      if (!client) {
        return;
      }

      if (this.getRequeueReason(dbSessionId, client)) {
        return;
      }

      // NOW dequeue — client is ready, we're about to dispatch.
      const msg = sessionDomainService.dequeueNext(dbSessionId, { emitSnapshot: false });
      if (!msg) {
        return;
      }

      try {
        await this.dispatchMessage(dbSessionId, msg, client);
      } catch (error) {
        // If dispatch fails (e.g., setMaxThinkingTokens throws before state change),
        // the message is still in ACCEPTED state and can be safely requeued
        logger.error('[Chat WS] Failed to dispatch message, re-queueing', {
          dbSessionId,
          messageId: msg.id,
          error: error instanceof Error ? error.message : String(error),
        });
        // Avoid clobbering markProcessExit() runtime/lastExit when the process
        // has already stopped and exit handling is in flight.
        if (sessionService.isSessionRunning(dbSessionId)) {
          sessionDomainService.markIdle(dbSessionId, 'alive');
        }
        sessionDomainService.requeueFront(dbSessionId, msg);
      }
    } finally {
      this.dispatchInProgress.set(dbSessionId, false);
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
   * Ensure a session client is ready for dispatch. Auto-starts if needed.
   * Returns the client or undefined if startup failed.
   */
  private async ensureClientReady(
    dbSessionId: string,
    msg: QueuedMessage
  ): Promise<unknown | undefined> {
    let client = sessionService.getSessionClient(dbSessionId);
    if (!client) {
      const started = await this.autoStartClientForQueue(dbSessionId, msg);
      if (!started) {
        return undefined;
      }
      client = sessionService.getSessionClient(dbSessionId);
    }
    return client;
  }

  /**
   * Auto-start a client for queue dispatch using settings from the provided message.
   */
  private async autoStartClientForQueue(dbSessionId: string, msg: QueuedMessage): Promise<boolean> {
    if (!this.clientCreator) {
      logger.error('[Chat WS] Client creator not set');
      sessionDomainService.markError(dbSessionId);
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
      logger.error('[Chat WS] Failed to auto-start client for queue dispatch', {
        dbSessionId,
        error: error instanceof Error ? error.message : String(error),
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
    client?: unknown
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

    sessionDomainService.markRunning(dbSessionId);

    // Build content and send to Claude
    const content = this.buildMessageContent(msg);
    const order = sessionDomainService.allocateOrder(dbSessionId);

    sessionDomainService.emitDelta(dbSessionId, {
      type: 'message_state_changed',
      id: msg.id,
      newState: MessageState.DISPATCHED,
      userMessage: {
        text: msg.text,
        timestamp: msg.timestamp,
        attachments: msg.attachments,
        settings: {
          ...msg.settings,
          selectedModel: resolveSelectedModel(msg.settings.selectedModel),
          reasoningEffort: msg.settings.reasoningEffort,
        },
        order,
      },
    });

    if (isCompactCommand && compactionClient) {
      compactionClient.startCompaction();
    }

    try {
      await sessionService.sendSessionMessage(dbSessionId, content);
      sessionDomainService.commitSentUserMessageAtOrder(dbSessionId, msg, order);
      sessionDomainService.emitDelta(dbSessionId, {
        type: 'message_state_changed',
        id: msg.id,
        newState: MessageState.COMMITTED,
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
    if (workspace.status === 'ARCHIVED') {
      return 'Workspace is archived. Unarchive it before sending messages.';
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
