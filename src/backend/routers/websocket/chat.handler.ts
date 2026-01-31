/**
 * Chat WebSocket Handler
 *
 * Handles WebSocket connections for Claude CLI chat sessions.
 * Manages session lifecycle, message forwarding, and tool interception.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import type { PendingInteractiveRequest } from '../../../shared/pending-request-types';
import { type ClaudeClient, SessionManager } from '../../claude/index';
import type { ClaudeContentItem } from '../../claude/types';
import { WS_READY_STATE } from '../../constants';
import { interceptorRegistry } from '../../interceptors';
import { claudeSessionAccessor } from '../../resource_accessors/claude-session.accessor';
import { configService, createLogger, sessionService } from '../../services/index';
import { messageQueueService, type QueuedMessage } from '../../services/message-queue.service';
import { sessionFileLogger } from '../../services/session-file-logger.service';

const logger = createLogger('chat-handler');

// ============================================================================
// Types
// ============================================================================

export interface ConnectionInfo {
  ws: WebSocket;
  dbSessionId: string | null;
  workingDir: string;
}

// ============================================================================
// State
// ============================================================================

export const chatConnections = new Map<string, ConnectionInfo>();
export const clientEventSetup = new Set<string>();

/** Pending interactive requests by session ID (for restore on reconnect) */
export const pendingInteractiveRequests = new Map<string, PendingInteractiveRequest>();

/** Guard to prevent concurrent tryDispatchNextMessage calls per session */
const dispatchInProgress = new Map<string, boolean>();

const DEBUG_CHAT_WS = process.env.DEBUG_CHAT_WS === 'true';
let chatWsMsgCounter = 0;

// ============================================================================
// Helper Functions
// ============================================================================

function forwardToConnections(
  dbSessionId: string | null,
  data: unknown,
  exclude?: WebSocket
): void {
  // Skip if no session (connection exists but no session selected yet)
  if (!dbSessionId) {
    return;
  }
  chatWsMsgCounter++;
  const msgNum = chatWsMsgCounter;

  let connectionCount = 0;
  for (const info of chatConnections.values()) {
    if (
      info.dbSessionId === dbSessionId &&
      info.ws.readyState === WS_READY_STATE.OPEN &&
      info.ws !== exclude
    ) {
      connectionCount++;
    }
  }

  if (connectionCount === 0) {
    if (DEBUG_CHAT_WS) {
      logger.debug(`[Chat WS #${msgNum}] No connections viewing session`, { dbSessionId });
    }
    return;
  }

  if (DEBUG_CHAT_WS) {
    const dataObj = data as { type?: string; data?: { type?: string; uuid?: string } };
    logger.info(`[Chat WS #${msgNum}] Sending to ${connectionCount} connection(s)`, {
      dbSessionId,
      type: dataObj.type,
      innerType: dataObj.data?.type,
      uuid: dataObj.data?.uuid,
    });
  }

  sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', data);

  const json = JSON.stringify(data);
  for (const info of chatConnections.values()) {
    if (
      info.dbSessionId === dbSessionId &&
      info.ws.readyState === WS_READY_STATE.OPEN &&
      info.ws !== exclude
    ) {
      info.ws.send(json);
    }
  }
}

function notifyToolResultInterceptors(
  content: Array<{ type?: string }>,
  pendingToolNames: Map<string, string>,
  pendingToolInputs: Map<string, Record<string, unknown>>,
  interceptorContext: { sessionId: string; workspaceId: string; workingDir: string }
): void {
  for (const item of content) {
    const typedItem = item as {
      type: string;
      tool_use_id?: string;
      content?: string;
      is_error?: boolean;
    };
    if (typedItem.type !== 'tool_result' || !typedItem.tool_use_id) {
      continue;
    }

    const toolName = pendingToolNames.get(typedItem.tool_use_id) ?? 'unknown';
    const toolInput = pendingToolInputs.get(typedItem.tool_use_id) ?? {};

    interceptorRegistry.notifyToolComplete(
      {
        toolUseId: typedItem.tool_use_id,
        toolName,
        input: toolInput,
        output: {
          content:
            typeof typedItem.content === 'string'
              ? typedItem.content
              : JSON.stringify(typedItem.content),
          isError: typedItem.is_error ?? false,
        },
      },
      { ...interceptorContext, timestamp: new Date() }
    );

    pendingToolNames.delete(typedItem.tool_use_id);
    pendingToolInputs.delete(typedItem.tool_use_id);
  }
}

/**
 * Read plan file content for ExitPlanMode requests.
 */
function readPlanFileContent(planFile: string | undefined): string | null {
  if (!(planFile && existsSync(planFile))) {
    return null;
  }
  try {
    return readFileSync(planFile, 'utf-8');
  } catch (error) {
    logger.warn('[Chat WS] Failed to read plan file', {
      planFile,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Route interactive tool requests to the appropriate WebSocket message format.
 * Also stores the request for session restore when user navigates away and returns.
 */
function routeInteractiveRequest(
  dbSessionId: string,
  request: {
    requestId: string;
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
  }
): void {
  // Compute planContent for ExitPlanMode, null for others
  const planContent =
    request.toolName === 'ExitPlanMode'
      ? readPlanFileContent((request.input as { planFile?: string }).planFile)
      : null;

  // Store for session restore (single location for all request types)
  pendingInteractiveRequests.set(dbSessionId, {
    requestId: request.requestId,
    toolName: request.toolName,
    toolUseId: request.toolUseId,
    input: request.input,
    planContent,
    timestamp: new Date().toISOString(),
  });

  // Route to appropriate WebSocket message format
  if (request.toolName === 'AskUserQuestion') {
    const input = request.input as { questions?: unknown[] };
    forwardToConnections(dbSessionId, {
      type: 'user_question',
      requestId: request.requestId,
      questions: input.questions ?? [],
    });
    return;
  }

  if (request.toolName === 'ExitPlanMode') {
    forwardToConnections(dbSessionId, {
      type: 'permission_request',
      requestId: request.requestId,
      toolName: request.toolName,
      input: request.input,
      planContent,
    });
    return;
  }

  // Fallback: send as generic interactive_request
  forwardToConnections(dbSessionId, {
    type: 'interactive_request',
    requestId: request.requestId,
    toolName: request.toolName,
    toolUseId: request.toolUseId,
    input: request.input,
  });
}

/**
 * Thinking mode suffix appended to messages.
 */
const THINKING_SUFFIX = ' ultrathink';

/**
 * Build message content for sending to Claude.
 * Handles text with thinking suffix and attachments.
 */
function buildMessageContent(msg: QueuedMessage): string | ClaudeContentItem[] {
  const textWithThinking = msg.settings.thinkingEnabled
    ? `${msg.text}${THINKING_SUFFIX}`
    : msg.text;

  // If there are attachments, send as content array
  if (msg.attachments && msg.attachments.length > 0) {
    const content: ClaudeContentItem[] = [];

    // Add text if present
    if (textWithThinking) {
      content.push({ type: 'text', text: textWithThinking });
    }

    // Add images
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

  return textWithThinking;
}

/**
 * Auto-start a client for queue dispatch using settings from the next queued message.
 * Returns the client or null if auto-start failed.
 */
async function autoStartClientForQueue(dbSessionId: string): Promise<ClaudeClient | null> {
  const queue = messageQueueService.getQueue(dbSessionId);
  if (queue.length === 0) {
    return null;
  }

  const nextMsg = queue[0];

  if (DEBUG_CHAT_WS) {
    logger.info('[Chat WS] Auto-starting client for queued message', { dbSessionId });
  }

  try {
    return await getOrCreateChatClient(dbSessionId, {
      thinkingEnabled: nextMsg.settings.thinkingEnabled,
      planModeEnabled: nextMsg.settings.planModeEnabled,
      model: nextMsg.settings.selectedModel ?? undefined,
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
 * Dispatch a single queued message to the client.
 */
function dispatchQueuedMessage(dbSessionId: string, client: ClaudeClient): void {
  const msg = messageQueueService.dequeue(dbSessionId);
  if (!msg) {
    return;
  }

  // Notify all connections that message is being dispatched
  forwardToConnections(dbSessionId, { type: 'message_dispatched', id: msg.id });

  // Build content and send to Claude
  const content = buildMessageContent(msg);
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
 * Try to dispatch the next queued message to Claude.
 * Auto-starts the client if needed.
 * Uses a guard to prevent concurrent dispatch calls for the same session.
 */
async function tryDispatchNextMessage(dbSessionId: string): Promise<void> {
  // Guard against concurrent dispatch calls for the same session
  if (dispatchInProgress.get(dbSessionId)) {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Dispatch already in progress, skipping', { dbSessionId });
    }
    return;
  }

  dispatchInProgress.set(dbSessionId, true);

  try {
    if (!messageQueueService.hasMessages(dbSessionId)) {
      return;
    }

    let client: ClaudeClient | undefined = sessionService.getClient(dbSessionId);

    // Auto-start: create client if needed
    if (!client) {
      const newClient = await autoStartClientForQueue(dbSessionId);
      if (!newClient) {
        return;
      }
      client = newClient;
    }

    // Check if Claude is busy
    if (client.isWorking()) {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Claude is working, skipping queue dispatch', { dbSessionId });
      }
      return;
    }

    // Check if Claude process is still alive (isWorking() returns false for both idle AND exited clients)
    if (!client.isRunning()) {
      logger.warn('[Chat WS] Claude process has exited, cannot dispatch queued message', {
        dbSessionId,
      });
      return;
    }

    dispatchQueuedMessage(dbSessionId, client);
  } finally {
    dispatchInProgress.set(dbSessionId, false);
  }
}

function setupChatClientEvents(
  dbSessionId: string,
  client: ClaudeClient,
  context: { workspaceId: string; workingDir: string }
): void {
  // Idempotent: skip if already set up for this session
  if (clientEventSetup.has(dbSessionId)) {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Event forwarding already set up, skipping', { dbSessionId });
    }
    return;
  }
  clientEventSetup.add(dbSessionId);

  if (DEBUG_CHAT_WS) {
    logger.info('[Chat WS] Setting up event forwarding for session', { dbSessionId });
  }

  const pendingToolNames = new Map<string, string>();
  const pendingToolInputs = new Map<string, Record<string, unknown>>();

  client.on('tool_use', (toolUse) => {
    pendingToolNames.set(toolUse.id, toolUse.name);
    pendingToolInputs.set(toolUse.id, toolUse.input);

    interceptorRegistry.notifyToolStart(
      { toolUseId: toolUse.id, toolName: toolUse.name, input: toolUse.input },
      {
        sessionId: dbSessionId,
        workspaceId: context.workspaceId,
        workingDir: context.workingDir,
        timestamp: new Date(),
      }
    );
  });

  // Note: DB update for claudeSessionId is now handled by sessionService.setupClientDbHandlers()
  client.on('session_id', (claudeSessionId) => {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Received session_id from Claude CLI', {
        dbSessionId,
        claudeSessionId,
      });
    }

    forwardToConnections(dbSessionId, {
      type: 'status',
      running: true,
    });
  });

  // Hook into idle event to dispatch next queued message
  client.on('idle', () => {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Claude became idle, checking queue', { dbSessionId });
    }
    // Fire and forget - don't await
    tryDispatchNextMessage(dbSessionId).catch((error) => {
      logger.error('[Chat WS] Error dispatching queued message on idle', {
        dbSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  client.on('stream', (event) => {
    if (DEBUG_CHAT_WS) {
      const evt = event as { type?: string };
      logger.info('[Chat WS] Received stream event from client', {
        dbSessionId,
        eventType: evt.type,
      });
    }
    sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'stream', data: event });
    forwardToConnections(dbSessionId, { type: 'claude_message', data: event });
  });

  client.on('message', (msg) => {
    sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'message', data: msg });

    const msgWithType = msg as {
      type?: string;
      message?: { content?: Array<{ type?: string }> };
    };
    if (msgWithType.type !== 'user') {
      sessionFileLogger.log(dbSessionId, 'INFO', {
        action: 'skipped_message',
        reason: 'not_user_type',
        type: msgWithType.type,
      });
      return;
    }

    const content = msgWithType.message?.content;
    if (!Array.isArray(content)) {
      sessionFileLogger.log(dbSessionId, 'INFO', {
        action: 'skipped_message',
        reason: 'no_array_content',
      });
      return;
    }

    const hasToolResult = content.some((item) => item.type === 'tool_result');
    if (!hasToolResult) {
      sessionFileLogger.log(dbSessionId, 'INFO', {
        action: 'skipped_message',
        reason: 'no_tool_result_content',
        content_types: content.map((c) => c.type),
      });
      return;
    }

    notifyToolResultInterceptors(content, pendingToolNames, pendingToolInputs, {
      sessionId: dbSessionId,
      workspaceId: context.workspaceId,
      workingDir: context.workingDir,
    });

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Forwarding user message with tool_result', { dbSessionId });
    }
    sessionFileLogger.log(dbSessionId, 'INFO', {
      action: 'forwarding_user_message_with_tool_result',
    });
    forwardToConnections(dbSessionId, { type: 'claude_message', data: msg });
  });

  client.on('result', (result) => {
    if (DEBUG_CHAT_WS) {
      const res = result as { uuid?: string };
      logger.info('[Chat WS] Received result event from client', { dbSessionId, uuid: res.uuid });
    }
    sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'result', data: result });
    forwardToConnections(dbSessionId, { type: 'claude_message', data: result });

    forwardToConnections(dbSessionId, {
      type: 'status',
      running: false,
    });
  });

  // Forward interactive tool requests (e.g., AskUserQuestion) to frontend
  client.on('interactive_request', (request) => {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Received interactive_request from client', {
        dbSessionId,
        toolName: request.toolName,
        requestId: request.requestId,
      });
    }
    sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', {
      eventType: 'interactive_request',
      data: request,
    });

    routeInteractiveRequest(dbSessionId, request);
  });

  client.on('exit', (result) => {
    forwardToConnections(dbSessionId, {
      type: 'process_exit',
      code: result.code,
    });
    client.removeAllListeners();
    clientEventSetup.delete(dbSessionId);
    // Note: We intentionally do NOT clear the message queue on exit
    // Queue is preserved so messages can be sent when user starts next interaction
    // Clear any pending interactive requests when process exits
    pendingInteractiveRequests.delete(dbSessionId);
  });

  client.on('error', (error) => {
    forwardToConnections(dbSessionId, { type: 'error', message: error.message });
  });
}

/**
 * Get or create a ClaudeClient by delegating to sessionService.
 * Sets up event forwarding for WebSocket connections.
 */
async function getOrCreateChatClient(
  dbSessionId: string,
  options: {
    thinkingEnabled?: boolean;
    planModeEnabled?: boolean;
    model?: string;
  }
): Promise<ClaudeClient> {
  if (DEBUG_CHAT_WS) {
    logger.info('[Chat WS] Getting or creating client via sessionService', { dbSessionId });
  }

  // Delegate client lifecycle to sessionService
  const client = await sessionService.getOrCreateClient(dbSessionId, {
    thinkingEnabled: options.thinkingEnabled,
    permissionMode: options.planModeEnabled ? 'plan' : 'bypassPermissions',
    model: options.model,
  });

  // Set up event forwarding (idempotent - safe to call multiple times)
  const session = await claudeSessionAccessor.findById(dbSessionId);
  const sessionOpts = await sessionService.getSessionOptions(dbSessionId);
  setupChatClientEvents(dbSessionId, client, {
    workspaceId: session?.workspaceId ?? 'unknown',
    workingDir: sessionOpts?.workingDir ?? '',
  });

  return client;
}

// ============================================================================
// Message Type Definition
// ============================================================================

interface ChatMessage {
  type: string;
  text?: string;
  content?: string | ClaudeContentItem[];
  workingDir?: string;
  systemPrompt?: string;
  model?: string;
  thinkingEnabled?: boolean;
  planModeEnabled?: boolean;
  selectedModel?: string | null;
  // Queue message fields
  id?: string;
  attachments?: Array<{
    id: string;
    name: string;
    type: string;
    size: number;
    data: string;
  }>;
  settings?: {
    selectedModel: string | null;
    thinkingEnabled: boolean;
    planModeEnabled: boolean;
  };
  // Remove queued message fields
  messageId?: string;
}

// ============================================================================
// Message Handlers
// ============================================================================

const VALID_MODELS = ['sonnet', 'opus'];

function getValidModel(message: ChatMessage): string | undefined {
  const requestedModel = message.selectedModel || message.model;
  return requestedModel && VALID_MODELS.includes(requestedModel) ? requestedModel : undefined;
}

async function handleStartMessage(
  ws: WebSocket,
  sessionId: string,
  message: ChatMessage
): Promise<void> {
  ws.send(JSON.stringify({ type: 'starting', dbSessionId: sessionId }));

  const sessionOpts = await sessionService.getSessionOptions(sessionId);
  if (!sessionOpts) {
    logger.error('[Chat WS] Failed to get session options', { sessionId });
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
    return;
  }

  await getOrCreateChatClient(sessionId, {
    thinkingEnabled: message.thinkingEnabled,
    planModeEnabled: message.planModeEnabled,
    model: getValidModel(message),
  });
  ws.send(JSON.stringify({ type: 'started', dbSessionId: sessionId }));
}

/**
 * Handle direct user_input messages (legacy/bypass path).
 * For the new queue-based flow, use queue_message instead.
 */
function handleUserInputMessage(ws: WebSocket, sessionId: string, message: ChatMessage): void {
  const messageContent = message.content || message.text;
  if (!messageContent) {
    return;
  }

  // For text-only messages, ensure it's not empty
  if (typeof messageContent === 'string' && !messageContent.trim()) {
    return;
  }

  const existingClient = sessionService.getClient(sessionId);
  if (existingClient?.isRunning()) {
    existingClient.sendMessage(messageContent);
    return;
  }

  // If no client running, reject - frontend should use queue_message instead
  ws.send(
    JSON.stringify({
      type: 'error',
      message: 'No active Claude session. Use queue_message to queue messages.',
    })
  );
}

/**
 * Handle queue_message - the primary way to send messages.
 * Messages are queued and dispatched when Claude becomes idle.
 */
async function handleQueueMessage(
  ws: WebSocket,
  sessionId: string,
  message: ChatMessage
): Promise<void> {
  const text = message.text?.trim();
  if (!text && (!message.attachments || message.attachments.length === 0)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Empty message' }));
    return;
  }

  if (!message.id) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing message id' }));
    return;
  }

  // Build settings from message or use defaults
  const settings = message.settings ?? {
    selectedModel: message.selectedModel ?? null,
    thinkingEnabled: message.thinkingEnabled ?? false,
    planModeEnabled: message.planModeEnabled ?? false,
  };

  // Create queued message
  const queuedMsg: QueuedMessage = {
    id: message.id,
    text: text ?? '',
    attachments: message.attachments,
    settings,
    timestamp: new Date().toISOString(),
  };

  // Enqueue the message
  const result = messageQueueService.enqueue(sessionId, queuedMsg);

  // Check for queue full error
  if ('error' in result) {
    // Send message_rejected with the message ID so frontend can clean up
    ws.send(JSON.stringify({ type: 'message_rejected', id: message.id, message: result.error }));
    return;
  }

  const { position } = result;

  // Send message_accepted to the sender with full message for state update
  ws.send(
    JSON.stringify({ type: 'message_accepted', id: message.id, position, queuedMessage: queuedMsg })
  );

  // Broadcast to all other connections viewing this session (exclude sender to avoid duplicate)
  forwardToConnections(
    sessionId,
    {
      type: 'message_accepted',
      id: message.id,
      position,
      queuedMessage: queuedMsg,
    },
    ws
  );

  if (DEBUG_CHAT_WS) {
    logger.info('[Chat WS] Message queued', {
      sessionId,
      messageId: message.id,
      position,
    });
  }

  // Try to dispatch immediately if Claude is idle
  await tryDispatchNextMessage(sessionId);
}

/**
 * Handle remove_queued_message - cancel a message before it's dispatched.
 */
function handleRemoveQueuedMessage(ws: WebSocket, sessionId: string, message: ChatMessage): void {
  const messageId = message.messageId;
  if (!messageId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing messageId' }));
    return;
  }

  const removed = messageQueueService.remove(sessionId, messageId);

  if (removed) {
    // Broadcast removal to all connections
    forwardToConnections(sessionId, { type: 'message_removed', id: messageId });

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Queued message removed', { sessionId, messageId });
    }
  } else {
    ws.send(JSON.stringify({ type: 'error', message: 'Message not found in queue' }));
  }
}

async function handleStopMessage(ws: WebSocket, sessionId: string): Promise<void> {
  await sessionService.stopClaudeSession(sessionId);
  // Note: We intentionally do NOT clear the message queue on stop
  // Queue is preserved so messages can be sent when user resumes interaction
  pendingInteractiveRequests.delete(sessionId);
  ws.send(JSON.stringify({ type: 'stopped', dbSessionId: sessionId }));
}

async function handleGetHistoryMessage(
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

async function handleListSessionsMessage(ws: WebSocket, workingDir: string): Promise<void> {
  const sessions = await SessionManager.listSessions(workingDir);
  ws.send(JSON.stringify({ type: 'sessions', sessions }));
}

/**
 * Parse model string to extract model type.
 */
function parseModelType(model: string | null | undefined): string | null {
  if (!model) {
    return null;
  }
  if (model.includes('opus')) {
    return 'opus';
  }
  if (model.includes('haiku')) {
    return 'haiku';
  }
  return null;
}

async function handleLoadSessionMessage(
  ws: WebSocket,
  sessionId: string,
  workingDir: string
): Promise<void> {
  const dbSession = await claudeSessionAccessor.findById(sessionId);
  if (!dbSession) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
    return;
  }

  const targetSessionId = dbSession.claudeSessionId ?? null;
  const existingClient = sessionService.getClient(sessionId);
  const running = existingClient?.isWorking() ?? false;
  const pendingInteractiveRequest = pendingInteractiveRequests.get(sessionId) ?? null;
  const queuedMessages = messageQueueService.getQueue(sessionId);

  // Build session data - fetch from Claude session if available
  let messages: Awaited<ReturnType<typeof SessionManager.getHistory>> = [];
  let gitBranch: string | null = null;
  let selectedModel: string | null = null;
  let thinkingEnabled = false;

  if (targetSessionId) {
    const [history, model, thinking, branch] = await Promise.all([
      SessionManager.getHistory(targetSessionId, workingDir),
      SessionManager.getSessionModel(targetSessionId, workingDir),
      SessionManager.getSessionThinkingEnabled(targetSessionId, workingDir),
      SessionManager.getSessionGitBranch(targetSessionId, workingDir),
    ]);
    messages = history;
    gitBranch = branch;
    selectedModel = parseModelType(model);
    thinkingEnabled = thinking;
  }

  ws.send(
    JSON.stringify({
      type: 'session_loaded',
      messages,
      gitBranch,
      running,
      settings: {
        selectedModel,
        thinkingEnabled,
        planModeEnabled: false,
      },
      pendingInteractiveRequest,
      queuedMessages,
    })
  );
}

/**
 * Clear pending interactive request only if the requestId matches.
 * Prevents clearing a newer request when responding to a stale one.
 */
function clearPendingRequestIfMatches(sessionId: string, requestId: string): void {
  const pending = pendingInteractiveRequests.get(sessionId);
  if (pending?.requestId === requestId) {
    pendingInteractiveRequests.delete(sessionId);
  }
}

function handleQuestionResponseMessage(
  ws: WebSocket,
  sessionId: string,
  message: ChatMessage
): void {
  const { requestId, answers } = message as unknown as {
    requestId: string;
    answers: Record<string, string | string[]>;
  };

  if (!(requestId && answers)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing requestId or answers' }));
    return;
  }

  const client = sessionService.getClient(sessionId);
  if (!client) {
    // Clear pending request only if it matches (client gone, but don't clear a newer request)
    clearPendingRequestIfMatches(sessionId, requestId);
    ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
    return;
  }

  try {
    client.answerQuestion(requestId, answers);
    // Clear the pending request only if requestId matches
    clearPendingRequestIfMatches(sessionId, requestId);
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Answered question', { sessionId, requestId });
    }
  } catch (error) {
    // Clear pending request only if it matches (prevents clearing newer request on stale response)
    clearPendingRequestIfMatches(sessionId, requestId);
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

function handlePermissionResponseMessage(
  ws: WebSocket,
  sessionId: string,
  message: ChatMessage
): void {
  const { requestId, allow } = message as unknown as {
    requestId: string;
    allow: boolean;
  };

  if (!requestId || allow === undefined) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing requestId or allow' }));
    return;
  }

  const client = sessionService.getClient(sessionId);
  if (!client) {
    // Clear pending request only if it matches (client gone, but don't clear a newer request)
    clearPendingRequestIfMatches(sessionId, requestId);
    ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
    return;
  }

  try {
    if (allow) {
      client.approveInteractiveRequest(requestId);
    } else {
      client.denyInteractiveRequest(requestId, 'User denied');
    }
    // Clear the pending request only if requestId matches
    clearPendingRequestIfMatches(sessionId, requestId);
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Responded to permission request', { sessionId, requestId, allow });
    }
  } catch (error) {
    // Clear pending request only if it matches (prevents clearing newer request on stale response)
    clearPendingRequestIfMatches(sessionId, requestId);
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

// ============================================================================
// Main Message Handler
// ============================================================================

async function handleChatMessage(
  ws: WebSocket,
  _connectionId: string,
  dbSessionId: string | null,
  workingDir: string,
  message: ChatMessage
): Promise<void> {
  // list_sessions doesn't require a session
  if (message.type === 'list_sessions') {
    await handleListSessionsMessage(ws, workingDir);
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
      await handleStartMessage(ws, dbSessionId, message);
      break;
    case 'user_input':
      handleUserInputMessage(ws, dbSessionId, message);
      break;
    case 'queue_message':
      await handleQueueMessage(ws, dbSessionId, message);
      break;
    case 'remove_queued_message':
      handleRemoveQueuedMessage(ws, dbSessionId, message);
      break;
    case 'stop':
      await handleStopMessage(ws, dbSessionId);
      break;
    case 'get_history':
      await handleGetHistoryMessage(ws, dbSessionId, workingDir);
      break;
    case 'load_session':
      await handleLoadSessionMessage(ws, dbSessionId, workingDir);
      break;
    case 'question_response':
      handleQuestionResponseMessage(ws, dbSessionId, message);
      break;
    case 'permission_response':
      handlePermissionResponseMessage(ws, dbSessionId, message);
      break;
  }
}

function validateWorkingDir(workingDir: string): string | null {
  if (workingDir.includes('..')) {
    return null;
  }

  if (!workingDir.startsWith('/')) {
    return null;
  }

  const normalized = resolve(workingDir);

  if (!existsSync(normalized)) {
    return null;
  }

  let realPath: string;
  try {
    realPath = realpathSync(normalized);
  } catch {
    return null;
  }

  let worktreeBaseDir: string;
  try {
    worktreeBaseDir = realpathSync(configService.getWorktreeBaseDir());
  } catch {
    return null;
  }
  if (!realPath.startsWith(`${worktreeBaseDir}/`) && realPath !== worktreeBaseDir) {
    return null;
  }

  return realPath;
}

// ============================================================================
// Chat Upgrade Handler
// ============================================================================

export function handleChatUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  wss: WebSocketServer,
  wsAliveMap: WeakMap<WebSocket, boolean>
): void {
  const connectionId = url.searchParams.get('connectionId') || `conn-${Date.now()}`;
  const dbSessionId = url.searchParams.get('sessionId') || null;
  const rawWorkingDir = url.searchParams.get('workingDir');

  if (!rawWorkingDir) {
    logger.warn('Missing workingDir parameter', { connectionId });
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing workingDir parameter');
    socket.destroy();
    return;
  }

  const workingDir = validateWorkingDir(rawWorkingDir);
  if (!workingDir) {
    logger.warn('Invalid workingDir rejected', { rawWorkingDir, dbSessionId, connectionId });
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nInvalid workingDir');
    socket.destroy();
    return;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: WebSocket connection handler with multiple event handlers
  wss.handleUpgrade(request, socket, head, (ws) => {
    logger.info('Chat WebSocket connection established', {
      connectionId,
      dbSessionId,
    });

    wsAliveMap.set(ws, true);
    ws.on('pong', () => wsAliveMap.set(ws, true));

    // Only initialize file logging if we have a session
    if (dbSessionId) {
      sessionFileLogger.initSession(dbSessionId);
      sessionFileLogger.log(dbSessionId, 'INFO', {
        event: 'connection_established',
        connectionId,
        dbSessionId,
        workingDir,
      });
    }

    const existingConnection = chatConnections.get(connectionId);
    if (existingConnection) {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Closing existing connection', {
          connectionId,
          oldDbSessionId: existingConnection.dbSessionId,
        });
      }
      existingConnection.ws.close(1000, 'New connection replacing old one');
    }

    chatConnections.set(connectionId, {
      ws,
      dbSessionId,
      workingDir,
    });

    if (DEBUG_CHAT_WS) {
      let viewingCount = 0;
      for (const info of chatConnections.values()) {
        if (info.dbSessionId === dbSessionId) {
          viewingCount++;
        }
      }
      logger.info('[Chat WS] Connection registered', {
        connectionId,
        dbSessionId,
        totalConnectionsViewingSession: viewingCount,
      });
    }

    // Only check for running client if we have a session
    const client = dbSessionId ? sessionService.getClient(dbSessionId) : null;
    const isRunning = client?.isWorking() ?? false;

    const initialStatus = {
      type: 'status',
      dbSessionId,
      running: isRunning,
    };
    if (dbSessionId) {
      sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', initialStatus);
    }
    ws.send(JSON.stringify(initialStatus));

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (dbSessionId) {
          sessionFileLogger.log(dbSessionId, 'IN_FROM_CLIENT', message);
        }
        await handleChatMessage(ws, connectionId, dbSessionId, workingDir, message);
      } catch (error) {
        logger.error('Error handling chat message', error as Error);
        const errorResponse = { type: 'error', message: 'Invalid message format' };
        if (dbSessionId) {
          sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', errorResponse);
        }
        ws.send(JSON.stringify(errorResponse));
      }
    });

    ws.on('close', () => {
      logger.info('Chat WebSocket connection closed', { connectionId, dbSessionId });
      if (dbSessionId) {
        sessionFileLogger.log(dbSessionId, 'INFO', { event: 'connection_closed', connectionId });
        sessionFileLogger.closeSession(dbSessionId);
      }

      chatConnections.delete(connectionId);
    });

    ws.on('error', (error) => {
      logger.error('Chat WebSocket error', error);
      if (dbSessionId) {
        sessionFileLogger.log(dbSessionId, 'INFO', {
          event: 'connection_error',
          connectionId,
          error: error.message,
        });
      }
    });
  });
}
