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
import { DEFAULT_THINKING_BUDGET, MessageState } from '@/lib/claude-types';
import { INTERACTIVE_RESPONSE_TOOLS } from '@/shared/pending-request-types';
import type { ClaudeClient } from '../claude/index';
import { SessionManager } from '../claude/index';
import type { ClaudeContentItem } from '../claude/types';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import type {
  ChatMessageInput,
  PermissionResponseMessage,
  QuestionResponseMessage,
  QueueMessageInput,
  RemoveQueuedMessageInput,
  SetModelMessage,
  SetThinkingBudgetMessage,
  StartMessageInput,
  UserInputMessage,
} from '../schemas/websocket';
import { chatConnectionService } from './chat-connection.service';
import { chatEventForwarderService } from './chat-event-forwarder.service';
import { configService } from './config.service';
import { eventCompressionService } from './event-compression.service';
import { createLogger } from './logger.service';
import { messageQueueService, type QueuedMessage } from './message-queue.service';
import { messageStateService } from './message-state.service';
import { sessionService } from './session.service';

const logger = createLogger('chat-message-handlers');

const DEBUG_CHAT_WS = configService.getDebugConfig().chatWebSocket;

// ============================================================================
// Types
// ============================================================================

/** Re-export ChatMessageInput as ChatMessage for backward compatibility */
export type ChatMessage = ChatMessageInput;

export interface ClientCreator {
  getOrCreate(
    dbSessionId: string,
    options: {
      thinkingEnabled?: boolean;
      planModeEnabled?: boolean;
      model?: string;
    }
  ): Promise<ClaudeClient>;
}

// ============================================================================
// Constants
// ============================================================================

const VALID_MODELS = ['sonnet', 'opus'];

// ============================================================================
// Service
// ============================================================================

class ChatMessageHandlerService {
  /** Guard to prevent concurrent tryDispatchNextMessage calls per session */
  private dispatchInProgress = new Map<string, boolean>();

  /** Client creator function - injected to avoid circular dependencies */
  private clientCreator: ClientCreator | null = null;

  /**
   * Set the client creator (called during initialization).
   */
  setClientCreator(creator: ClientCreator): void {
    this.clientCreator = creator;
  }

  /**
   * Try to dispatch the next queued message to Claude.
   * Auto-starts the client if needed.
   * Uses a guard to prevent concurrent dispatch calls for the same session.
   */
  async tryDispatchNextMessage(dbSessionId: string): Promise<void> {
    // Guard against concurrent dispatch calls for the same session
    if (this.dispatchInProgress.get(dbSessionId)) {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Dispatch already in progress, skipping', { dbSessionId });
      }
      return;
    }

    this.dispatchInProgress.set(dbSessionId, true);

    // Dequeue first to claim the message atomically before any async operations.
    const msg = messageQueueService.dequeue(dbSessionId);
    if (!msg) {
      this.dispatchInProgress.set(dbSessionId, false);
      return;
    }

    try {
      let client: ClaudeClient | undefined = sessionService.getClient(dbSessionId);

      // Auto-start: create client if needed, using the dequeued message's settings
      if (!client) {
        // Notify frontend that agent is starting BEFORE creating the client
        // This provides immediate feedback when the first message is sent
        chatConnectionService.forwardToSession(dbSessionId, { type: 'starting', dbSessionId });

        const newClient = await this.autoStartClientForQueue(dbSessionId, msg);
        if (!newClient) {
          // Re-queue the message at the front so it's not lost
          messageQueueService.requeue(dbSessionId, msg);
          // Notify frontend that starting failed so UI doesn't get stuck
          chatConnectionService.forwardToSession(dbSessionId, { type: 'stopped', dbSessionId });
          return;
        }
        client = newClient;
      }

      // Check if Claude is busy
      if (client.isWorking()) {
        if (DEBUG_CHAT_WS) {
          logger.info('[Chat WS] Claude is working, re-queueing message', { dbSessionId });
        }
        messageQueueService.requeue(dbSessionId, msg);
        return;
      }

      // Check if Claude process is still alive
      if (!client.isRunning()) {
        logger.warn('[Chat WS] Claude process has exited, re-queueing message', { dbSessionId });
        messageQueueService.requeue(dbSessionId, msg);
        return;
      }

      await this.dispatchMessage(dbSessionId, client, msg);
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
    // list_sessions doesn't require a session
    if (message.type === 'list_sessions') {
      await this.handleListSessionsMessage(ws, workingDir);
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

    switch (message.type) {
      case 'start':
        await this.handleStartMessage(ws, dbSessionId, message);
        break;
      case 'user_input':
        this.handleUserInputMessage(ws, dbSessionId, message);
        break;
      case 'queue_message':
        await this.handleQueueMessage(ws, dbSessionId, message);
        break;
      case 'remove_queued_message':
        this.handleRemoveQueuedMessage(ws, dbSessionId, message);
        break;
      case 'stop':
        await this.handleStopMessage(ws, dbSessionId);
        break;
      case 'get_history':
        await this.handleGetHistoryMessage(ws, dbSessionId, workingDir);
        break;
      case 'load_session':
        await this.handleLoadSessionMessage(ws, dbSessionId, workingDir);
        break;
      case 'get_queue':
        this.handleSnapshotRequest(dbSessionId);
        break;
      case 'question_response':
        this.handleQuestionResponseMessage(ws, dbSessionId, message);
        break;
      case 'permission_response':
        this.handlePermissionResponseMessage(ws, dbSessionId, message);
        break;
      case 'set_model':
        await this.handleSetModelMessage(ws, dbSessionId, message);
        break;
      case 'set_thinking_budget':
        await this.handleSetThinkingBudgetMessage(ws, dbSessionId, message);
        break;
    }
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
    // Update state to DISPATCHED - emits message_state_changed event
    messageStateService.updateState(dbSessionId, msg.id, MessageState.DISPATCHED);

    // Notify frontend that agent is working - this ensures the spinner shows
    // for subsequent messages when client is already running
    chatConnectionService.forwardToSession(dbSessionId, { type: 'status', running: true });

    // Set thinking budget based on message settings (must complete before sending message)
    const thinkingTokens = msg.settings.thinkingEnabled ? DEFAULT_THINKING_BUDGET : null;
    await client.setMaxThinkingTokens(thinkingTokens);

    // Build content and send to Claude
    const content = this.buildMessageContent(msg);
    client.sendMessage(content);

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Dispatched queued message to Claude', {
        dbSessionId,
        messageId: msg.id,
        remainingInQueue: messageQueueService.getQueueLength(dbSessionId),
      });
    }
  }

  /**
   * Build message content for sending to Claude.
   * Note: Thinking is now controlled via setMaxThinkingTokens, not message suffix.
   */
  private buildMessageContent(msg: QueuedMessage): string | ClaudeContentItem[] {
    // If there are attachments, send as content array
    if (msg.attachments && msg.attachments.length > 0) {
      const content: ClaudeContentItem[] = [];

      if (msg.text) {
        content.push({ type: 'text', text: msg.text });
      }

      for (const attachment of msg.attachments) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.type,
            data: attachment.data,
          },
        } as unknown as ClaudeContentItem);
      }

      return content;
    }

    return msg.text;
  }

  // ============================================================================
  // Private: Model Validation
  // ============================================================================

  private getValidModel(message: StartMessageInput): string | undefined {
    const requestedModel = message.selectedModel || message.model;
    return requestedModel && VALID_MODELS.includes(requestedModel) ? requestedModel : undefined;
  }

  // ============================================================================
  // Private: Message Handlers
  // ============================================================================

  private async handleStartMessage(
    ws: WebSocket,
    sessionId: string,
    message: StartMessageInput
  ): Promise<void> {
    if (!this.clientCreator) {
      ws.send(JSON.stringify({ type: 'error', message: 'Client creator not configured' }));
      return;
    }

    ws.send(JSON.stringify({ type: 'starting', dbSessionId: sessionId }));

    const sessionOpts = await sessionService.getSessionOptions(sessionId);
    if (!sessionOpts) {
      logger.error('[Chat WS] Failed to get session options', { sessionId });
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    await this.clientCreator.getOrCreate(sessionId, {
      thinkingEnabled: message.thinkingEnabled,
      planModeEnabled: message.planModeEnabled,
      model: this.getValidModel(message),
    });
    ws.send(JSON.stringify({ type: 'started', dbSessionId: sessionId }));
  }

  private handleUserInputMessage(
    ws: WebSocket,
    sessionId: string,
    message: UserInputMessage
  ): void {
    const rawContent = message.content || message.text;
    if (!rawContent) {
      return;
    }

    if (typeof rawContent === 'string' && !rawContent.trim()) {
      return;
    }

    // Cast content array to ClaudeContentItem[] - validation is done at WebSocket handler level
    const messageContent =
      typeof rawContent === 'string' ? rawContent : (rawContent as ClaudeContentItem[]);

    const existingClient = sessionService.getClient(sessionId);
    if (existingClient?.isRunning()) {
      existingClient.sendMessage(messageContent);
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'No active Claude session. Use queue_message to queue messages.',
      })
    );
  }

  private async handleQueueMessage(
    ws: WebSocket,
    sessionId: string,
    message: QueueMessageInput
  ): Promise<void> {
    const text = message.text?.trim();
    const hasContent = text || (message.attachments && message.attachments.length > 0);

    if (!hasContent) {
      ws.send(JSON.stringify({ type: 'error', message: 'Empty message' }));
      return;
    }

    if (!message.id) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing message id' }));
      return;
    }

    // Check if there's a pending interactive request - if so, treat this message as a response
    const messageId = message.id;
    if (text && this.tryHandleAsInteractiveResponse(ws, sessionId, messageId, text)) {
      return;
    }

    const queuedMsg = this.buildQueuedMessage(messageId, message, text ?? '');
    const result = messageQueueService.enqueue(sessionId, queuedMsg);

    if ('error' in result) {
      // Create rejected message in state service - emits message_state_changed event
      messageStateService.createRejectedMessage(sessionId, messageId, result.error, text);
      return;
    }

    this.notifyMessageAccepted(sessionId, queuedMsg);
    await this.tryDispatchNextMessage(sessionId);
  }

  /**
   * Try to handle the message as a response to a pending interactive request.
   * @returns true if handled, false otherwise
   */
  private tryHandleAsInteractiveResponse(
    ws: WebSocket,
    sessionId: string,
    messageId: string,
    text: string
  ): boolean {
    const pendingRequest = chatEventForwarderService.getPendingRequest(sessionId);
    if (!pendingRequest) {
      return false;
    }
    return this.handleMessageAsInteractiveResponse(ws, sessionId, messageId, text, pendingRequest);
  }

  /**
   * Build a QueuedMessage from a queue_message input.
   */
  private buildQueuedMessage(id: string, message: QueueMessageInput, text: string): QueuedMessage {
    const rawModel = message.settings?.selectedModel ?? null;
    const validModel = rawModel && VALID_MODELS.includes(rawModel) ? rawModel : null;

    return {
      id,
      text,
      attachments: message.attachments,
      settings: message.settings
        ? { ...message.settings, selectedModel: validModel }
        : { selectedModel: validModel, thinkingEnabled: false, planModeEnabled: false },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Notify frontend that a message was accepted.
   * Creates the message in state service which emits message_state_changed event.
   */
  private notifyMessageAccepted(sessionId: string, queuedMsg: QueuedMessage): void {
    messageStateService.createUserMessage(sessionId, queuedMsg);

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Message queued', { sessionId, messageId: queuedMsg.id });
    }
  }

  /**
   * Handle an incoming message as a response to a pending interactive request.
   * For AskUserQuestion: Answer with "Other" option using the message text.
   * For ExitPlanMode: Deny with the message text as the reason.
   *
   * @returns true if the message was handled as an interactive response, false otherwise
   */
  private handleMessageAsInteractiveResponse(
    ws: WebSocket,
    sessionId: string,
    messageId: string,
    text: string,
    pendingRequest: { requestId: string; toolName: string; input: Record<string, unknown> }
  ): boolean {
    const client = sessionService.getClient(sessionId);
    if (!client) {
      // No active client, can't respond to interactive request
      return false;
    }

    // Only handle known interactive request types
    if (
      !INTERACTIVE_RESPONSE_TOOLS.includes(
        pendingRequest.toolName as (typeof INTERACTIVE_RESPONSE_TOOLS)[number]
      )
    ) {
      return false;
    }

    // Always clear the pending request to prevent stale state, regardless of success/failure
    // This must happen before any operation that could fail
    chatEventForwarderService.clearPendingRequestIfMatches(sessionId, pendingRequest.requestId);

    // Allocate an order for this message so it sorts correctly on the frontend
    const order = messageStateService.allocateOrder(sessionId);

    // Prepare the response event - we'll send it even on error to clear frontend state
    const responseEvent = { type: 'message_used_as_response', id: messageId, text, order };

    try {
      if (pendingRequest.toolName === 'AskUserQuestion') {
        // For AskUserQuestion, answer each question with "Other" + the message text
        const input = pendingRequest.input as { questions?: Array<{ question: string }> };
        const questions = input.questions ?? [];
        const answers: Record<string, string> = {};

        for (const q of questions) {
          // Use the message text as the "Other" response for all questions
          answers[q.question] = text;
        }

        client.answerQuestion(pendingRequest.requestId, answers);
      } else {
        // ExitPlanMode: deny with the message text as feedback
        client.denyInteractiveRequest(pendingRequest.requestId, text);
      }

      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Message used as interactive response', {
          sessionId,
          messageId,
          toolName: pendingRequest.toolName,
          requestId: pendingRequest.requestId,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to handle message as interactive response', {
        sessionId,
        messageId,
        toolName: pendingRequest.toolName,
        error: errorMessage,
      });
      // Continue to send the response event to clear frontend state
      // The message will be displayed in chat even though sending to Claude failed
    }

    // Always notify frontend - clears pending state and displays the message
    // This happens outside try/catch to ensure frontend state is always updated
    try {
      ws.send(JSON.stringify(responseEvent));
      chatConnectionService.forwardToSession(sessionId, responseEvent, ws);
    } catch (sendError) {
      // WebSocket send failed - frontend will recover on reconnect
      logger.warn('[Chat WS] Failed to send message_used_as_response event', {
        sessionId,
        messageId,
        error: sendError instanceof Error ? sendError.message : String(sendError),
      });
    }

    return true;
  }

  private handleRemoveQueuedMessage(
    ws: WebSocket,
    sessionId: string,
    message: RemoveQueuedMessageInput
  ): void {
    const { messageId } = message;
    const removed = messageQueueService.remove(sessionId, messageId);

    if (removed) {
      // Transition to CANCELLED state - emits message_state_changed event to all connections
      messageStateService.updateState(sessionId, messageId, MessageState.CANCELLED);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Queued message cancelled', { sessionId, messageId });
      }
    } else {
      ws.send(JSON.stringify({ type: 'error', message: 'Message not found in queue' }));
    }
  }

  private async handleStopMessage(ws: WebSocket, sessionId: string): Promise<void> {
    await sessionService.stopClaudeSession(sessionId);
    // Only clear pending requests here - clientEventSetup cleanup happens in the exit handler
    // to avoid race conditions where a new client is created before the old one exits
    chatEventForwarderService.clearPendingRequest(sessionId);
    ws.send(JSON.stringify({ type: 'stopped', dbSessionId: sessionId }));
  }

  private async handleGetHistoryMessage(
    ws: WebSocket,
    sessionId: string,
    workingDir: string
  ): Promise<void> {
    const client = sessionService.getClient(sessionId);
    const claudeSessionId = client?.getClaudeSessionId();
    if (claudeSessionId) {
      const history = await SessionManager.getHistory(claudeSessionId, workingDir);
      ws.send(JSON.stringify({ type: 'history', dbSessionId: sessionId, messages: history }));
    } else {
      ws.send(JSON.stringify({ type: 'history', dbSessionId: sessionId, messages: [] }));
    }
  }

  private async handleListSessionsMessage(ws: WebSocket, workingDir: string): Promise<void> {
    const sessions = await SessionManager.listSessions(workingDir);
    ws.send(JSON.stringify({ type: 'sessions', sessions }));
  }

  private async handleLoadSessionMessage(
    ws: WebSocket,
    sessionId: string,
    workingDir: string
  ): Promise<void> {
    const dbSession = await claudeSessionAccessor.findById(sessionId);
    if (!dbSession) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    const existingClient = sessionService.getClient(sessionId);

    if (existingClient?.isRunning()) {
      this.replayEventsForRunningClient(ws, sessionId, existingClient);
    } else {
      await this.loadHistoryFromJSONL(sessionId, workingDir, dbSession.claudeSessionId);
    }
  }

  /**
   * Replay stored events to a reconnecting client when Claude is still running.
   * Uses event compression to reduce the number of messages sent on reconnect.
   */
  private replayEventsForRunningClient(
    ws: WebSocket,
    sessionId: string,
    client: ClaudeClient
  ): void {
    // Get stored events and compress for efficient replay
    const events = messageStateService.getStoredEvents(sessionId);
    const { compressed, stats } = eventCompressionService.compressWithStats(events);

    // Log compression stats if significant compression occurred
    if (stats.originalCount > stats.compressedCount) {
      eventCompressionService.logCompressionStats(sessionId, stats);
    }

    // Replay compressed events to this specific WebSocket
    for (const event of compressed) {
      ws.send(JSON.stringify(event));
    }

    // Send current status
    const isClientWorking = client.isWorking();
    ws.send(JSON.stringify({ type: 'status', running: isClientWorking }));

    // Send pending interactive request if any
    const pendingRequest = chatEventForwarderService.getPendingRequest(sessionId);
    if (pendingRequest) {
      this.sendPendingInteractiveRequest(ws, pendingRequest);
    }
  }

  /**
   * Send a pending interactive request to the WebSocket in the appropriate format.
   */
  private sendPendingInteractiveRequest(
    ws: WebSocket,
    pendingRequest: NonNullable<ReturnType<typeof chatEventForwarderService.getPendingRequest>>
  ): void {
    if (pendingRequest.toolName === 'AskUserQuestion') {
      const input = pendingRequest.input as { questions?: unknown[] };
      ws.send(
        JSON.stringify({
          type: 'user_question',
          requestId: pendingRequest.requestId,
          questions: input.questions ?? [],
        })
      );
      return;
    }

    if (pendingRequest.toolName === 'ExitPlanMode') {
      ws.send(
        JSON.stringify({
          type: 'permission_request',
          requestId: pendingRequest.requestId,
          toolName: pendingRequest.toolName,
          input: pendingRequest.input,
          planContent: pendingRequest.planContent,
        })
      );
      return;
    }

    // Generic interactive request fallback
    ws.send(
      JSON.stringify({
        type: 'interactive_request',
        requestId: pendingRequest.requestId,
        toolName: pendingRequest.toolName,
        toolUseId: pendingRequest.toolUseId,
        input: pendingRequest.input,
      })
    );
  }

  /**
   * Load history from JSONL file and send as a messages_snapshot.
   * Used when reconnecting to a session that is not currently running.
   * Uses the existing messageStateService.loadFromHistory and sendSnapshot
   * to properly handle user messages and Claude messages.
   */
  private async loadHistoryFromJSONL(
    sessionId: string,
    workingDir: string,
    claudeSessionId: string | null
  ): Promise<void> {
    if (claudeSessionId) {
      const history = await SessionManager.getHistory(claudeSessionId, workingDir);
      messageStateService.loadFromHistory(sessionId, history);
    }
    const sessionStatus = messageStateService.computeSessionStatus(sessionId, false);
    messageStateService.sendSnapshot(sessionId, sessionStatus, null);
  }

  /**
   * Handle snapshot request (get_queue message type) - sends a messages_snapshot with current state.
   * This is now equivalent to load_session but faster since it doesn't load from JSONL.
   */
  private handleSnapshotRequest(sessionId: string): void {
    const existingClient = sessionService.getClient(sessionId);
    const isRunning = existingClient?.isWorking() ?? false;
    const pendingInteractiveRequest =
      chatEventForwarderService.getPendingRequest(sessionId) ?? null;
    const sessionStatus = messageStateService.computeSessionStatus(sessionId, isRunning);
    messageStateService.sendSnapshot(sessionId, sessionStatus, pendingInteractiveRequest);
  }

  private handleQuestionResponseMessage(
    ws: WebSocket,
    sessionId: string,
    message: QuestionResponseMessage
  ): void {
    const { requestId, answers } = message;

    const client = sessionService.getClient(sessionId);
    if (!client) {
      chatEventForwarderService.clearPendingRequestIfMatches(sessionId, requestId);
      ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
      return;
    }

    try {
      client.answerQuestion(requestId, answers);
      chatEventForwarderService.clearPendingRequestIfMatches(sessionId, requestId);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Answered question', { sessionId, requestId });
      }
    } catch (error) {
      chatEventForwarderService.clearPendingRequestIfMatches(sessionId, requestId);
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to answer question', {
        sessionId,
        requestId,
        error: errorMessage,
      });
      ws.send(
        JSON.stringify({ type: 'error', message: `Failed to answer question: ${errorMessage}` })
      );
    }
  }

  private handlePermissionResponseMessage(
    ws: WebSocket,
    sessionId: string,
    message: PermissionResponseMessage
  ): void {
    const { requestId, allow } = message;

    const client = sessionService.getClient(sessionId);
    if (!client) {
      chatEventForwarderService.clearPendingRequestIfMatches(sessionId, requestId);
      ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
      return;
    }

    try {
      if (allow) {
        client.approveInteractiveRequest(requestId);
      } else {
        client.denyInteractiveRequest(requestId, 'User denied');
      }
      chatEventForwarderService.clearPendingRequestIfMatches(sessionId, requestId);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Responded to permission request', { sessionId, requestId, allow });
      }
    } catch (error) {
      chatEventForwarderService.clearPendingRequestIfMatches(sessionId, requestId);
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to respond to permission request', {
        sessionId,
        requestId,
        error: errorMessage,
      });
      ws.send(
        JSON.stringify({
          type: 'error',
          message: `Failed to respond to permission: ${errorMessage}`,
        })
      );
    }
  }

  private async handleSetModelMessage(
    ws: WebSocket,
    sessionId: string,
    message: SetModelMessage
  ): Promise<void> {
    const client = sessionService.getClient(sessionId);
    if (!client) {
      ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
      return;
    }

    try {
      await client.setModel(message.model);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Set model', { sessionId, model: message.model });
      }
      ws.send(JSON.stringify({ type: 'model_set', model: message.model }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to set model', {
        sessionId,
        model: message.model,
        error: errorMessage,
      });
      ws.send(JSON.stringify({ type: 'error', message: `Failed to set model: ${errorMessage}` }));
    }
  }

  private async handleSetThinkingBudgetMessage(
    ws: WebSocket,
    sessionId: string,
    message: SetThinkingBudgetMessage
  ): Promise<void> {
    const client = sessionService.getClient(sessionId);
    if (!client) {
      ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
      return;
    }

    try {
      await client.setMaxThinkingTokens(message.max_tokens);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Set thinking budget', { sessionId, maxTokens: message.max_tokens });
      }
      ws.send(JSON.stringify({ type: 'thinking_budget_set', max_tokens: message.max_tokens }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to set thinking budget', {
        sessionId,
        maxTokens: message.max_tokens,
        error: errorMessage,
      });
      ws.send(
        JSON.stringify({ type: 'error', message: `Failed to set thinking budget: ${errorMessage}` })
      );
    }
  }
}

export const chatMessageHandlerService = new ChatMessageHandlerService();
