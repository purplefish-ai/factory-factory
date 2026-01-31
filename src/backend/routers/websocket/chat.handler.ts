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
import {
  claudeSessionAccessor,
  type PendingMessageData,
} from '../../resource_accessors/claude-session.accessor';
import { configService, createLogger, sessionService } from '../../services/index';
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

const MAX_PENDING_MESSAGES = 100;
const DEBUG_CHAT_WS = process.env.DEBUG_CHAT_WS === 'true';
let chatWsMsgCounter = 0;

// ============================================================================
// Helper Functions
// ============================================================================

function forwardToConnections(dbSessionId: string | null, data: unknown): void {
  // Skip if no session (connection exists but no session selected yet)
  if (!dbSessionId) {
    return;
  }
  chatWsMsgCounter++;
  const msgNum = chatWsMsgCounter;

  let connectionCount = 0;
  for (const info of chatConnections.values()) {
    if (info.dbSessionId === dbSessionId && info.ws.readyState === WS_READY_STATE.OPEN) {
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
    if (info.dbSessionId === dbSessionId && info.ws.readyState === WS_READY_STATE.OPEN) {
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

    // Drain any pending messages from database
    claudeSessionAccessor
      .popPendingMessages(dbSessionId)
      .then((pending) => {
        if (pending.length > 0) {
          logger.info('[Chat WS] Draining pending messages on session_id', {
            dbSessionId,
            count: pending.length,
          });
          for (const msg of pending) {
            // Send content if available (for images), otherwise send text
            const messageContent = msg.content ? (msg.content as ClaudeContentItem[]) : msg.text;
            client.sendMessage(messageContent);
          }
        }
      })
      .catch((err) => {
        logger.error('[Chat WS] Failed to drain pending messages', { dbSessionId, error: err });
      });

    forwardToConnections(dbSessionId, {
      type: 'status',
      running: true,
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

async function handleUserInputMessage(
  ws: WebSocket,
  sessionId: string,
  message: ChatMessage
): Promise<void> {
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

  // Check queue size from database
  const existingQueue = await claudeSessionAccessor.getPendingMessages(sessionId);
  if (existingQueue.length >= MAX_PENDING_MESSAGES) {
    logger.warn('[Chat WS] Pending message queue full, rejecting message', {
      sessionId,
      queueLength: existingQueue.length,
      maxSize: MAX_PENDING_MESSAGES,
    });
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Session is still starting. Please wait a moment and try again.',
      })
    );
    return;
  }

  // Queue message to database
  const displayText = typeof messageContent === 'string' ? messageContent : '[Image message]';
  const pendingMessage: PendingMessageData = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    text: displayText,
    timestamp: new Date().toISOString(),
    content: typeof messageContent === 'string' ? undefined : (messageContent as unknown[]),
  };
  await claudeSessionAccessor.addPendingMessage(sessionId, pendingMessage);

  logger.info('[Chat WS] Queued message for pending session', {
    sessionId,
    queueLength: existingQueue.length + 1,
  });

  ws.send(JSON.stringify({ type: 'message_queued', text: displayText, id: pendingMessage.id }));
  ws.send(JSON.stringify({ type: 'starting', dbSessionId: sessionId }));

  const newClient = await getOrCreateChatClient(sessionId, {
    thinkingEnabled: message.thinkingEnabled,
    planModeEnabled: message.planModeEnabled,
    model: getValidModel(message),
  });
  ws.send(JSON.stringify({ type: 'started', dbSessionId: sessionId }));

  // Drain pending messages from database
  const pending = await claudeSessionAccessor.popPendingMessages(sessionId);
  if (pending.length > 0) {
    logger.info('[Chat WS] Sending queued messages after client ready', {
      sessionId,
      count: pending.length,
    });
    for (const msg of pending) {
      const messageContent = msg.content ? (msg.content as ClaudeContentItem[]) : msg.text;
      newClient.sendMessage(messageContent);
    }
  }
}

async function handleStopMessage(ws: WebSocket, sessionId: string): Promise<void> {
  await sessionService.stopClaudeSession(sessionId);
  await claudeSessionAccessor.clearPendingMessages(sessionId);
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

  // Check for pending interactive request to restore modal state
  const pendingRequest = pendingInteractiveRequests.get(sessionId);

  // Get pending messages from database
  const pendingMessages = await claudeSessionAccessor.getPendingMessages(sessionId);

  if (targetSessionId) {
    const [history, model, thinkingEnabled, gitBranch] = await Promise.all([
      SessionManager.getHistory(targetSessionId, workingDir),
      SessionManager.getSessionModel(targetSessionId, workingDir),
      SessionManager.getSessionThinkingEnabled(targetSessionId, workingDir),
      SessionManager.getSessionGitBranch(targetSessionId, workingDir),
    ]);

    const selectedModel = model?.includes('opus')
      ? 'opus'
      : model?.includes('haiku')
        ? 'haiku'
        : null;

    ws.send(
      JSON.stringify({
        type: 'session_loaded',
        messages: history,
        pendingMessages,
        gitBranch,
        running,
        settings: {
          selectedModel,
          thinkingEnabled,
          planModeEnabled: false,
        },
        pendingInteractiveRequest: pendingRequest ?? null,
      })
    );
  } else {
    ws.send(
      JSON.stringify({
        type: 'session_loaded',
        messages: [],
        pendingMessages,
        gitBranch: null,
        running,
        settings: {
          selectedModel: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
        pendingInteractiveRequest: pendingRequest ?? null,
      })
    );
  }
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
      await handleUserInputMessage(ws, dbSessionId, message);
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
