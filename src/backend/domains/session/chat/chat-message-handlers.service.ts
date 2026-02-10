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
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { createLogger } from '@/backend/services/logger.service';
import {
  type ClaudeContentItem,
  DEFAULT_THINKING_BUDGET,
  MessageState,
  type QueuedMessage,
  resolveSelectedModel,
} from '@/shared/claude';
import type { ChatMessageInput } from '@/shared/websocket';
import type { SessionInitPolicyBridge } from '../bridges';
import type { ClaudeClient } from '../claude/index';
import { sessionDataService } from '../data/session-data.service';
import { sessionService } from '../lifecycle/session.service';
import { processAttachmentsAndBuildContent } from './chat-message-handlers/attachment-processing';
import { DEBUG_CHAT_WS } from './chat-message-handlers/constants';
import { createChatMessageHandlerRegistry } from './chat-message-handlers/registry';
import type { ClientCreator } from './chat-message-handlers/types';

const logger = createLogger('chat-message-handlers');

// ============================================================================
// Types
// ============================================================================

/** Re-export ChatMessageInput as ChatMessage for backward compatibility */
export type ChatMessage = ChatMessageInput;
export type { ClientCreator } from './chat-message-handlers/types';

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
   */
  async tryDispatchNextMessage(dbSessionId: string): Promise<void> {
    // Guard against concurrent dispatch calls for the same session
    if (this.isDispatchInProgress(dbSessionId)) {
      return;
    }

    this.dispatchInProgress.set(dbSessionId, true);

    // Dequeue first to claim the message atomically before any async operations.
    const msg = sessionDomainService.dequeueNext(dbSessionId, { emitSnapshot: false });
    if (!msg) {
      this.dispatchInProgress.set(dbSessionId, false);
      return;
    }

    try {
      const dispatchGate = await this.getDispatchGateSafely(dbSessionId, msg);
      if (dispatchGate === 'blocked' || dispatchGate === 'manual_resume') {
        return;
      }

      let client: ClaudeClient | undefined = sessionService.getClient(dbSessionId);

      // Auto-start: create client if needed, using the dequeued message's settings
      if (!client) {
        const newClient = await this.autoStartClientForQueue(dbSessionId, msg);
        if (!newClient) {
          // Re-queue the message at the front so it's not lost
          sessionDomainService.requeueFront(dbSessionId, msg);
          return;
        }
        client = newClient;
      }

      const shouldRequeueReason = this.getRequeueReason(client);
      if (shouldRequeueReason) {
        this.requeueWithReason(dbSessionId, msg, shouldRequeueReason);
        return;
      }

      try {
        await this.dispatchMessage(dbSessionId, client, msg);
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
        if (client.isRunning()) {
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
    message: ChatMessage
  ): Promise<void> {
    const handler = this.handlerRegistry[message.type] as
      | ((context: {
          ws: WebSocket;
          sessionId: string;
          workingDir: string;
          message: ChatMessage;
        }) => Promise<void> | void)
      | undefined;

    if (!handler) {
      logger.warn('[Chat WS] No handler registered for message type', { type: message.type });
      return;
    }

    // list_sessions doesn't require a session
    if (message.type === 'list_sessions') {
      await handler({ ws, sessionId: dbSessionId ?? '', workingDir, message });
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
   * Auto-start a client for queue dispatch using settings from the provided message.
   */
  private async autoStartClientForQueue(
    dbSessionId: string,
    msg: QueuedMessage
  ): Promise<ClaudeClient | null> {
    if (!this.clientCreator) {
      logger.error('[Chat WS] Client creator not set');
      sessionDomainService.markError(dbSessionId);
      return null;
    }

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Auto-starting client for queued message', { dbSessionId });
    }

    try {
      return await this.clientCreator.getOrCreate(dbSessionId, {
        thinkingEnabled: msg.settings.thinkingEnabled,
        planModeEnabled: msg.settings.planModeEnabled,
        model: msg.settings.selectedModel ?? undefined,
      });
    } catch (error) {
      logger.error('[Chat WS] Failed to auto-start client for queue dispatch', {
        dbSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Dispatch a message to the client.
   */
  private async dispatchMessage(
    dbSessionId: string,
    client: ClaudeClient,
    msg: QueuedMessage
  ): Promise<void> {
    const isCompactCommand = this.isCompactCommand(msg.text);

    // Set thinking budget first - this can throw and must complete before we
    // change any state. If it fails, the message remains in ACCEPTED state
    // and can be safely requeued by the caller.
    const thinkingTokens = msg.settings.thinkingEnabled ? DEFAULT_THINKING_BUDGET : null;
    await client.setMaxThinkingTokens(thinkingTokens);

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
        },
        order,
      },
    });

    if (isCompactCommand) {
      client.startCompaction();
    }

    try {
      await client.sendMessage(content);
      sessionDomainService.commitSentUserMessageAtOrder(dbSessionId, msg, order);
      sessionDomainService.emitDelta(dbSessionId, {
        type: 'message_state_changed',
        id: msg.id,
        newState: MessageState.COMMITTED,
      });
    } catch (error) {
      if (isCompactCommand) {
        client.endCompaction();
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

  private getRequeueReason(client: ClaudeClient): 'working' | 'compacting' | 'stopped' | null {
    if (client.isWorking()) {
      return 'working';
    }
    if (!client.isRunning()) {
      return 'stopped';
    }
    if (client.isCompactingActive()) {
      return 'compacting';
    }
    return null;
  }

  private requeueWithReason(
    dbSessionId: string,
    msg: QueuedMessage,
    reason: 'working' | 'compacting' | 'stopped'
  ): void {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Re-queueing message', { dbSessionId, reason });
    } else if (reason === 'stopped') {
      logger.warn('[Chat WS] Claude process has exited, re-queueing message', { dbSessionId });
    }
    sessionDomainService.requeueFront(dbSessionId, msg);
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
  private buildMessageContent(msg: QueuedMessage): string | ClaudeContentItem[] {
    return processAttachmentsAndBuildContent(msg.text, msg.attachments);
  }

  private async evaluateDispatchGate(
    dbSessionId: string
  ): Promise<'allowed' | 'blocked' | 'manual_resume'> {
    const session = await sessionDataService.findClaudeSessionById(dbSessionId);
    if (!session) {
      return 'blocked';
    }

    const dispatchPolicy = this.initPolicy.getWorkspaceInitPolicy(session.workspace).dispatchPolicy;
    if (dispatchPolicy !== 'manual_resume') {
      this.manualDispatchResumed.delete(dbSessionId);
      return dispatchPolicy;
    }

    return this.manualDispatchResumed.get(dbSessionId) ? 'allowed' : 'manual_resume';
  }

  private async getDispatchGateSafely(
    dbSessionId: string,
    msg: QueuedMessage
  ): Promise<'allowed' | 'blocked' | 'manual_resume'> {
    try {
      const dispatchGate = await this.evaluateDispatchGate(dbSessionId);
      if (dispatchGate === 'blocked' || dispatchGate === 'manual_resume') {
        sessionDomainService.requeueFront(dbSessionId, msg);
      }
      return dispatchGate;
    } catch (error) {
      logger.error('[Chat WS] Failed to evaluate dispatch gate, re-queueing message', {
        dbSessionId,
        messageId: msg.id,
        error: error instanceof Error ? error.message : String(error),
      });
      sessionDomainService.requeueFront(dbSessionId, msg);
      return 'blocked';
    }
  }

  // ============================================================================
  // Private: Message handlers now live in chat-message-handlers/handlers
  // ============================================================================
}

export const chatMessageHandlerService = new ChatMessageHandlerService();
