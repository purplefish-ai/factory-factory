/**
 * Chat WebSocket Handler
 *
 * Handles WebSocket connections for Claude CLI chat sessions.
 * Manages session lifecycle, message forwarding, and tool interception.
 *
 * This is the entry point that delegates to specialized services:
 * - ChatConnectionService: Connection tracking and message forwarding
 * - ChatEventForwarderService: Client event setup and interactive request routing
 * - ChatMessageHandlerService: Message dispatch and all message type handlers
 */

import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import type { ClaudeClient } from '../../claude/index';
import { claudeSessionAccessor } from '../../resource_accessors/claude-session.accessor';
import { type ChatMessageInput, ChatMessageSchema } from '../../schemas/websocket';
import { type ConnectionInfo, chatConnectionService } from '../../services/chat-connection.service';
import { chatEventForwarderService } from '../../services/chat-event-forwarder.service';
import { chatMessageHandlerService } from '../../services/chat-message-handlers.service';
import {
  configService,
  createLogger,
  messageStateService,
  sessionService,
} from '../../services/index';
import { sessionFileLogger } from '../../services/session-file-logger.service';
import { toMessageString } from './message-utils';

const logger = createLogger('chat-handler');

const DEBUG_CHAT_WS = configService.getDebugConfig().chatWebSocket;

function sendBadRequest(socket: Duplex, message: string): void {
  socket.write(`HTTP/1.1 400 Bad Request\r\n\r\n${message}`);
  socket.destroy();
}

// ============================================================================
// Client Creation
// ============================================================================

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
  chatEventForwarderService.setupClientEvents(
    dbSessionId,
    client,
    {
      workspaceId: session?.workspaceId ?? 'unknown',
      workingDir: sessionOpts?.workingDir ?? '',
    },
    () => chatMessageHandlerService.tryDispatchNextMessage(dbSessionId)
  );

  return client;
}

// Initialize client creator for message handler service
chatMessageHandlerService.setClientCreator({
  getOrCreate: getOrCreateChatClient,
});

// Register callback for event forwarding when clients are created
// This ensures event forwarding is set up even for sessions started without WebSocket
sessionService.setOnClientCreated((sessionId, client, context) => {
  chatEventForwarderService.setupClientEvents(sessionId, client, context, () =>
    chatMessageHandlerService.tryDispatchNextMessage(sessionId)
  );
});

// ============================================================================
// Security Validation
// ============================================================================

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

function countConnectionsViewingSession(dbSessionId: string | null): number {
  if (!dbSessionId) {
    return 0;
  }

  let viewingCount = 0;
  for (const info of chatConnectionService.values()) {
    if (info.dbSessionId === dbSessionId) {
      viewingCount++;
    }
  }
  return viewingCount;
}

function getInitialStatus(dbSessionId: string | null): {
  type: 'status';
  dbSessionId: string | null;
  running: boolean;
  processAlive: boolean;
} {
  const client = dbSessionId ? sessionService.getClient(dbSessionId) : null;
  const isRunning = client?.isWorking() ?? false;
  const processAlive = client?.isRunning() ?? false;

  return {
    type: 'status',
    dbSessionId,
    running: isRunning,
    processAlive,
  };
}

function sendInitialStatus(
  ws: WebSocket,
  dbSessionId: string | null
): { type: 'status'; dbSessionId: string | null; running: boolean; processAlive: boolean } {
  const initialStatus = getInitialStatus(dbSessionId);
  if (dbSessionId) {
    sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', initialStatus);
  }
  ws.send(JSON.stringify(initialStatus));
  return initialStatus;
}

function sendSnapshotIfNeeded(dbSessionId: string | null, isRunning: boolean): void {
  if (!dbSessionId) {
    return;
  }
  const pendingRequest = chatEventForwarderService.getPendingRequest(dbSessionId);
  const sessionStatus = messageStateService.computeSessionStatus(dbSessionId, isRunning);
  messageStateService.sendSnapshot(dbSessionId, sessionStatus, pendingRequest);
}

function parseChatMessage(connectionId: string, data: unknown): ChatMessageInput | null {
  const rawMessage: unknown = JSON.parse(toMessageString(data));
  const parseResult = ChatMessageSchema.safeParse(rawMessage);

  if (!parseResult.success) {
    logger.warn('Invalid chat message format', {
      errors: parseResult.error.issues,
      connectionId,
    });
    return null;
  }

  return parseResult.data;
}

function sendChatError(ws: WebSocket, dbSessionId: string | null, message: string): void {
  const errorResponse = { type: 'error', message };
  if (dbSessionId) {
    sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', errorResponse);
  }
  ws.send(JSON.stringify(errorResponse));
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
  const connectionId = url.searchParams.get('connectionId') || `conn-${randomUUID()}`;
  const dbSessionId = url.searchParams.get('sessionId') || null;
  const rawWorkingDir = url.searchParams.get('workingDir');

  if (!rawWorkingDir) {
    logger.warn('Missing workingDir parameter', { connectionId });
    sendBadRequest(socket, 'Missing workingDir parameter');
    return;
  }

  const workingDir = validateWorkingDir(rawWorkingDir);
  if (!workingDir) {
    logger.warn('Invalid workingDir rejected', { rawWorkingDir, dbSessionId, connectionId });
    sendBadRequest(socket, 'Invalid workingDir');
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    logger.info('Chat WebSocket connection established', {
      connectionId,
      dbSessionId,
    });

    // Set up workspace notification forwarding (idempotent)
    chatEventForwarderService.setupWorkspaceNotifications();

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

    const existingConnection = chatConnectionService.get(connectionId);
    if (existingConnection) {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Closing existing connection', {
          connectionId,
          oldDbSessionId: existingConnection.dbSessionId,
        });
      }
      existingConnection.ws.close(1000, 'New connection replacing old one');
    }

    const connectionInfo: ConnectionInfo = {
      ws,
      dbSessionId,
      workingDir,
    };
    chatConnectionService.register(connectionId, connectionInfo);

    if (DEBUG_CHAT_WS) {
      const viewingCount = countConnectionsViewingSession(dbSessionId);
      logger.info('[Chat WS] Connection registered', {
        connectionId,
        dbSessionId,
        totalConnectionsViewingSession: viewingCount,
      });
    }

    const initialStatus = sendInitialStatus(ws, dbSessionId);
    sendSnapshotIfNeeded(dbSessionId, initialStatus.running);

    ws.on('message', async (data) => {
      try {
        const message = parseChatMessage(connectionId, data);
        if (!message) {
          sendChatError(ws, dbSessionId, 'Invalid message format');
          return;
        }
        if (dbSessionId) {
          sessionFileLogger.log(dbSessionId, 'IN_FROM_CLIENT', message);
        }
        await chatMessageHandlerService.handleMessage(ws, dbSessionId, workingDir, message);
      } catch (error) {
        logger.error('Error handling chat message', error as Error);
        sendChatError(ws, dbSessionId, 'Invalid message format');
      }
    });

    ws.on('close', () => {
      logger.info('Chat WebSocket connection closed', { connectionId, dbSessionId });
      if (dbSessionId) {
        sessionFileLogger.log(dbSessionId, 'INFO', { event: 'connection_closed', connectionId });
        sessionFileLogger.closeSession(dbSessionId);
      }

      chatConnectionService.unregister(connectionId);
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

// ============================================================================
// Re-exports for external usage
// ============================================================================

export type { ChatMessageInput } from '../../schemas/websocket';
export type { ConnectionInfo } from '../../services/chat-connection.service';
