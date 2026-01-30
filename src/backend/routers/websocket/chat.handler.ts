/**
 * Chat WebSocket Handler
 *
 * Handles WebSocket connections for Claude CLI chat sessions.
 * Manages session lifecycle, message forwarding, and tool interception.
 */

import { existsSync, realpathSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { type ClaudeClient, SessionManager } from '../../claude/index';
import { interceptorRegistry } from '../../interceptors';
import { claudeSessionAccessor } from '../../resource_accessors/claude-session.accessor';
import { configService, createLogger, sessionService } from '../../services/index';
import { sessionFileLogger } from '../../services/session-file-logger.service';

const logger = createLogger('chat-handler');

// ============================================================================
// Types
// ============================================================================

export interface ConnectionInfo {
  ws: WebSocket;
  dbSessionId: string;
  workingDir: string;
}

export interface PendingMessage {
  text: string;
  sentAt: Date;
}

// ============================================================================
// State
// ============================================================================

export const chatConnections = new Map<string, ConnectionInfo>();
export const pendingMessages = new Map<string, PendingMessage[]>();
export const clientEventSetup = new Set<string>();

const MAX_PENDING_MESSAGES = 100;
const DEBUG_CHAT_WS = process.env.DEBUG_CHAT_WS === 'true';
let chatWsMsgCounter = 0;

// ============================================================================
// Helper Functions
// ============================================================================

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: WebSocket forwarding with debug logging
function forwardToConnections(dbSessionId: string, data: unknown): void {
  chatWsMsgCounter++;
  const msgNum = chatWsMsgCounter;

  let connectionCount = 0;
  for (const info of chatConnections.values()) {
    if (info.dbSessionId === dbSessionId && info.ws.readyState === 1) {
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
    if (info.dbSessionId === dbSessionId && info.ws.readyState === 1) {
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

    // Drain any pending messages
    const pending = pendingMessages.get(dbSessionId);
    pendingMessages.delete(dbSessionId);
    if (pending && pending.length > 0) {
      logger.info('[Chat WS] Draining pending messages on session_id', {
        dbSessionId,
        count: pending.length,
      });
      for (const msg of pending) {
        client.sendMessage(msg.text);
      }
    }

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

  client.on('exit', (result) => {
    forwardToConnections(dbSessionId, {
      type: 'process_exit',
      code: result.code,
    });
    client.removeAllListeners();
    clientEventSetup.delete(dbSessionId);
    pendingMessages.delete(dbSessionId);
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: handles multiple message types with settings
async function handleChatMessage(
  ws: WebSocket,
  _connectionId: string,
  dbSessionId: string,
  workingDir: string,
  message: {
    type: string;
    text?: string;
    workingDir?: string;
    systemPrompt?: string;
    model?: string;
    thinkingEnabled?: boolean;
    planModeEnabled?: boolean;
    selectedModel?: string | null;
  }
): Promise<void> {
  switch (message.type) {
    case 'start': {
      ws.send(JSON.stringify({ type: 'starting', dbSessionId }));

      // Determine model to use
      const sessionOpts = await sessionService.getSessionOptions(dbSessionId);
      if (!sessionOpts) {
        logger.error('[Chat WS] Failed to get session options', { dbSessionId });
        ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
        break;
      }

      const validModels = ['sonnet', 'opus'];
      const requestedModel = message.selectedModel || message.model;
      const model =
        requestedModel && validModels.includes(requestedModel) ? requestedModel : undefined;

      await getOrCreateChatClient(dbSessionId, {
        thinkingEnabled: message.thinkingEnabled,
        planModeEnabled: message.planModeEnabled,
        model,
      });
      ws.send(JSON.stringify({ type: 'started', dbSessionId }));
      break;
    }

    case 'user_input': {
      const text = message.text || '';
      if (!text.trim()) {
        break;
      }

      // Check if client exists and is running via sessionService
      const existingClient = sessionService.getClient(dbSessionId);
      if (existingClient?.isRunning()) {
        existingClient.sendMessage(text);
      } else {
        let queue = pendingMessages.get(dbSessionId);
        if (!queue) {
          queue = [];
          pendingMessages.set(dbSessionId, queue);
        }

        if (queue.length >= MAX_PENDING_MESSAGES) {
          logger.warn('[Chat WS] Pending message queue full, rejecting message', {
            dbSessionId,
            queueLength: queue.length,
            maxSize: MAX_PENDING_MESSAGES,
          });
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'Session is still starting. Please wait a moment and try again.',
            })
          );
          break;
        }

        queue.push({ text, sentAt: new Date() });

        logger.info('[Chat WS] Queued message for pending session', {
          dbSessionId,
          queueLength: queue.length,
        });

        ws.send(JSON.stringify({ type: 'message_queued', text }));
        ws.send(JSON.stringify({ type: 'starting', dbSessionId }));

        // Determine model to use
        const validModels = ['sonnet', 'opus'];
        const requestedModel = message.selectedModel || message.model;
        const model =
          requestedModel && validModels.includes(requestedModel) ? requestedModel : undefined;

        const newClient = await getOrCreateChatClient(dbSessionId, {
          thinkingEnabled: message.thinkingEnabled,
          planModeEnabled: message.planModeEnabled,
          model,
        });
        ws.send(JSON.stringify({ type: 'started', dbSessionId }));

        // Drain pending messages
        const pending = pendingMessages.get(dbSessionId);
        pendingMessages.delete(dbSessionId);
        if (pending && pending.length > 0) {
          logger.info('[Chat WS] Sending queued messages after client ready', {
            dbSessionId,
            count: pending.length,
          });
          for (const msg of pending) {
            newClient.sendMessage(msg.text);
          }
        }
      }
      break;
    }

    case 'stop': {
      // Delegate to sessionService for unified session lifecycle management
      await sessionService.stopClaudeSession(dbSessionId);
      pendingMessages.delete(dbSessionId);
      ws.send(JSON.stringify({ type: 'stopped', dbSessionId }));
      break;
    }

    case 'get_history': {
      const client = sessionService.getClient(dbSessionId);
      const claudeSessionId = client?.getClaudeSessionId();
      if (claudeSessionId) {
        const history = await SessionManager.getHistory(claudeSessionId, workingDir);
        ws.send(JSON.stringify({ type: 'history', dbSessionId, messages: history }));
      } else {
        ws.send(JSON.stringify({ type: 'history', dbSessionId, messages: [] }));
      }
      break;
    }

    case 'list_sessions': {
      const sessions = await SessionManager.listSessions(workingDir);
      ws.send(JSON.stringify({ type: 'sessions', sessions }));
      break;
    }

    case 'load_session': {
      const dbSession = await claudeSessionAccessor.findById(dbSessionId);
      if (!dbSession) {
        ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
        break;
      }

      const targetSessionId = dbSession.claudeSessionId ?? null;

      const existingClient = sessionService.getClient(dbSessionId);
      const running = existingClient?.isWorking() ?? false;

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
            gitBranch,
            running,
            settings: {
              selectedModel,
              thinkingEnabled,
              planModeEnabled: false,
            },
          })
        );
      } else {
        ws.send(
          JSON.stringify({
            type: 'session_loaded',
            messages: [],
            gitBranch: null,
            running,
            settings: {
              selectedModel: null,
              thinkingEnabled: false,
              planModeEnabled: false,
            },
          })
        );
      }
      break;
    }
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
  const dbSessionId = url.searchParams.get('sessionId');
  const rawWorkingDir = url.searchParams.get('workingDir');

  if (!dbSessionId) {
    logger.warn('Missing sessionId (dbSessionId) parameter', { connectionId });
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing sessionId parameter');
    socket.destroy();
    return;
  }

  if (!rawWorkingDir) {
    logger.warn('Missing workingDir parameter', { dbSessionId, connectionId });
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

    sessionFileLogger.initSession(dbSessionId);
    sessionFileLogger.log(dbSessionId, 'INFO', {
      event: 'connection_established',
      connectionId,
      dbSessionId,
      workingDir,
    });

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

    const client = sessionService.getClient(dbSessionId);
    const isRunning = client?.isWorking() ?? false;

    const initialStatus = {
      type: 'status',
      dbSessionId,
      running: isRunning,
    };
    sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', initialStatus);
    ws.send(JSON.stringify(initialStatus));

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        sessionFileLogger.log(dbSessionId, 'IN_FROM_CLIENT', message);
        await handleChatMessage(ws, connectionId, dbSessionId, workingDir, message);
      } catch (error) {
        logger.error('Error handling chat message', error as Error);
        const errorResponse = { type: 'error', message: 'Invalid message format' };
        sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', errorResponse);
        ws.send(JSON.stringify(errorResponse));
      }
    });

    ws.on('close', () => {
      logger.info('Chat WebSocket connection closed', { connectionId, dbSessionId });
      sessionFileLogger.log(dbSessionId, 'INFO', { event: 'connection_closed', connectionId });
      sessionFileLogger.closeSession(dbSessionId);

      chatConnections.delete(connectionId);
    });

    ws.on('error', (error) => {
      logger.error('Chat WebSocket error', error);
      sessionFileLogger.log(dbSessionId, 'INFO', {
        event: 'connection_error',
        connectionId,
        error: error.message,
      });
    });
  });
}
