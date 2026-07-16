/**
 * Terminal WebSocket Handler
 *
 * Handles WebSocket connections for terminal sessions.
 * Manages PTY terminal creation, input/output, and lifecycle.
 */

import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { toError } from '@/backend/lib/error-utils';
import { type TerminalMessageInput, TerminalMessageSchema } from '@/backend/schemas/websocket';
import { sessionDataService } from '@/backend/services/session';
import { workspaceDataService } from '@/backend/services/workspace';
import { parseWebSocketMessage, sendJsonError } from './message-utils';
import { createWebSocketUpgradeHandler, sendBadRequest, trackConnection } from './upgrade-utils';

// ============================================================================
// Types
// ============================================================================

/**
 * Map of workspace ID to set of WebSocket connections
 */
export type TerminalConnectionsMap = Map<string, Set<WebSocket>>;

// ============================================================================
// State
// ============================================================================

export const terminalConnections: TerminalConnectionsMap = new Map();

const terminalListenerCleanup = new WeakMap<WebSocket, Map<string, (() => void)[]>>();

type TerminalUnsubscribers = (() => void)[];

const TERMINAL_PID_CLEAR_RETRY_DELAYS_MS = [100, 500] as const;

// ============================================================================
// Helper Functions
// ============================================================================

function cleanupTerminalListeners(
  ws: WebSocket,
  logger: ReturnType<AppContext['services']['createLogger']>
): void {
  const cleanupMap = terminalListenerCleanup.get(ws);
  if (!cleanupMap) {
    return;
  }

  for (const [terminalId, unsubs] of cleanupMap) {
    logger.debug('Cleaning up listeners for terminal', { terminalId });
    for (const unsub of unsubs) {
      unsub();
    }
  }
  cleanupMap.clear();
}

function addTerminalCleanupMap(ws: WebSocket): Map<string, TerminalUnsubscribers> {
  const cleanupMap = new Map<string, TerminalUnsubscribers>();
  terminalListenerCleanup.set(ws, cleanupMap);
  return cleanupMap;
}

function logConnectionEstablished(
  workspaceId: string,
  logger: ReturnType<AppContext['services']['createLogger']>
): void {
  logger.debug('Terminal WebSocket connected', { workspaceId });
}

function sendExistingTerminals(
  ws: WebSocket,
  workspaceId: string,
  terminalService: AppContext['services']['terminalService'],
  logger: ReturnType<AppContext['services']['createLogger']>
): void {
  const existingTerminals = terminalService.getTerminalsForWorkspace(workspaceId);
  if (existingTerminals.length === 0) {
    return;
  }

  logger.info('Sending existing terminal list for restoration', {
    workspaceId,
    terminalCount: existingTerminals.length,
  });

  ws.send(
    JSON.stringify({
      type: 'terminal_list',
      terminals: existingTerminals.map((t) => ({
        id: t.id,
        createdAt: t.createdAt.toISOString(),
        outputBuffer: t.outputBuffer,
      })),
    })
  );

  const cleanupMap = terminalListenerCleanup.get(ws);
  for (const terminal of existingTerminals) {
    attachTerminalListeners(ws, workspaceId, terminal.id, terminalService, logger, cleanupMap);
  }
}

async function handleCreateMessage(
  ws: WebSocket,
  workspaceId: string,
  message: Extract<TerminalMessageInput, { type: 'create' }>,
  terminalService: AppContext['services']['terminalService'],
  logger: ReturnType<AppContext['services']['createLogger']>
): Promise<void> {
  logger.info('Creating terminal', {
    workspaceId,
    requestId: message.requestId,
    cols: message.cols,
    rows: message.rows,
  });
  const workspace = await workspaceDataService.findById(workspaceId);
  if (!workspace?.worktreePath) {
    logger.warn('Workspace not found or has no worktree', { workspaceId });
    sendJsonError(ws, 'Workspace not found or has no worktree', message.requestId);
    return;
  }

  logger.info('Creating terminal with worktree', {
    workspaceId,
    worktreePath: workspace.worktreePath,
  });
  const { terminalId, pid } = await terminalService.createTerminal({
    workspaceId,
    workingDir: workspace.worktreePath,
    cols: message.cols ?? 80,
    rows: message.rows ?? 24,
  });

  try {
    await sessionDataService.createTerminalSession({
      workspaceId,
      name: terminalId,
      pid,
    });
  } catch (error) {
    terminalService.destroyTerminal(workspaceId, terminalId);
    throw error;
  }

  const cleanupMap = terminalListenerCleanup.get(ws);
  // Snapshot output buffered during the DB write BEFORE attaching listeners
  // (same synchronous block), so early bytes are delivered exactly once:
  // buffered output via `created`, later output via the live listener.
  const outputBuffer = terminalService.getTerminal(workspaceId, terminalId)?.outputBuffer ?? '';
  attachTerminalListeners(ws, workspaceId, terminalId, terminalService, logger, cleanupMap);

  logger.info('Sending created message to client', { terminalId, requestId: message.requestId });
  ws.send(
    JSON.stringify({
      type: 'created',
      terminalId,
      requestId: message.requestId,
      ...(outputBuffer.length > 0 ? { outputBuffer } : {}),
    })
  );
}

function attachTerminalListeners(
  ws: WebSocket,
  workspaceId: string,
  terminalId: string,
  terminalService: AppContext['services']['terminalService'],
  logger: ReturnType<AppContext['services']['createLogger']>,
  cleanupMap: Map<string, TerminalUnsubscribers> | undefined
): void {
  const unsubscribers: TerminalUnsubscribers = [];
  cleanupMap?.set(terminalId, unsubscribers);

  const unsubOutput = terminalService.onOutput(terminalId, (output) => {
    if (ws.readyState === WS_READY_STATE.OPEN) {
      ws.send(JSON.stringify({ type: 'output', terminalId, data: output }));
    }
  });
  unsubscribers.push(unsubOutput);

  const unsubExit = terminalService.onExit(terminalId, (exitCode) => {
    logger.info('Terminal process exited', { terminalId, exitCode });
    if (ws.readyState === WS_READY_STATE.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', terminalId, exitCode }));
    }
    terminalListenerCleanup.get(ws)?.delete(terminalId);
    void clearTerminalPidWithRetry(workspaceId, terminalId, logger);
  });
  unsubscribers.push(unsubExit);
}

async function clearTerminalPidWithRetry(
  workspaceId: string,
  terminalId: string,
  logger: ReturnType<AppContext['services']['createLogger']>
): Promise<void> {
  const maxAttempts = TERMINAL_PID_CLEAR_RETRY_DELAYS_MS.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await sessionDataService.clearTerminalPid(workspaceId, terminalId);
      return;
    } catch (error) {
      const retryDelayMs = TERMINAL_PID_CLEAR_RETRY_DELAYS_MS[attempt - 1];
      if (retryDelayMs === undefined) {
        logger.warn('Failed to clear terminal PID', {
          workspaceId,
          terminalId,
          attempts: maxAttempts,
          error,
        });
        return;
      }

      logger.warn('Failed to clear terminal PID; retrying', {
        workspaceId,
        terminalId,
        attempt,
        maxAttempts,
        retryDelayMs,
        error,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

function handleInputMessage(
  workspaceId: string,
  message: Extract<TerminalMessageInput, { type: 'input' }>,
  terminalService: AppContext['services']['terminalService'],
  logger: ReturnType<AppContext['services']['createLogger']>
): void {
  if (message.terminalId && message.data) {
    logger.debug('Writing input to terminal', {
      terminalId: message.terminalId,
      dataLen: message.data.length,
    });
    const success = terminalService.writeToTerminal(workspaceId, message.terminalId, message.data);
    if (!success) {
      logger.warn('Failed to write to terminal', {
        workspaceId,
        terminalId: message.terminalId,
      });
    }
  } else {
    logger.warn('Input message missing terminalId or data', { message });
  }
}

function handleResizeMessage(
  workspaceId: string,
  message: Extract<TerminalMessageInput, { type: 'resize' }>,
  terminalService: AppContext['services']['terminalService'],
  logger: ReturnType<AppContext['services']['createLogger']>
): void {
  if (message.terminalId && message.cols && message.rows) {
    logger.debug('Resizing terminal', {
      terminalId: message.terminalId,
      cols: message.cols,
      rows: message.rows,
    });
    terminalService.resizeTerminal(workspaceId, message.terminalId, message.cols, message.rows);
  } else {
    logger.warn('Resize message missing required fields', { message });
  }
}

function handleDestroyMessage(
  ws: WebSocket,
  workspaceId: string,
  message: Extract<TerminalMessageInput, { type: 'destroy' }>,
  terminalService: AppContext['services']['terminalService'],
  logger: ReturnType<AppContext['services']['createLogger']>
): void {
  if (message.terminalId) {
    logger.info('Destroying terminal', { terminalId: message.terminalId });
    const cleanupMap = terminalListenerCleanup.get(ws);
    const unsubs = cleanupMap?.get(message.terminalId);
    if (unsubs) {
      for (const unsub of unsubs) {
        unsub();
      }
      cleanupMap?.delete(message.terminalId);
    }
    terminalService.destroyTerminal(workspaceId, message.terminalId);
  }
}

function handleSetActiveMessage(
  workspaceId: string,
  message: Extract<TerminalMessageInput, { type: 'set_active' }>,
  terminalService: AppContext['services']['terminalService'],
  logger: ReturnType<AppContext['services']['createLogger']>
): void {
  if (message.terminalId) {
    logger.debug('Setting active terminal', {
      workspaceId,
      terminalId: message.terminalId,
    });
    terminalService.setActiveTerminal(workspaceId, message.terminalId);
  }
}

async function authorizeTerminalWorkspaceUpgrade(
  workspaceId: string,
  socket: Duplex,
  logger: ReturnType<AppContext['services']['createLogger']>
): Promise<boolean> {
  const workspace = await workspaceDataService.findById(workspaceId);
  if (!workspace?.worktreePath) {
    logger.warn('Rejected terminal WebSocket for unknown workspace or missing worktree', {
      workspaceId,
    });
    sendBadRequest(socket, 'Workspace not found or has no worktree');
    return false;
  }

  return true;
}

async function handleTerminalMessage(
  ws: WebSocket,
  workspaceId: string,
  data: unknown,
  terminalService: AppContext['services']['terminalService'],
  logger: ReturnType<AppContext['services']['createLogger']>
): Promise<void> {
  const message = parseWebSocketMessage(TerminalMessageSchema, data, logger, 'terminal message', {
    workspaceId,
  });
  if (!message) {
    sendJsonError(ws, 'Invalid message format');
    return;
  }

  logger.debug('Received terminal message', {
    workspaceId,
    type: message.type,
    terminalId: 'terminalId' in message ? message.terminalId : undefined,
    requestId: 'requestId' in message ? message.requestId : undefined,
  });

  switch (message.type) {
    case 'create':
      try {
        await handleCreateMessage(ws, workspaceId, message, terminalService, logger);
      } catch (error) {
        const err = toError(error);
        logger.error('Error handling terminal create message', err, {
          workspaceId,
          requestId: message.requestId,
        });
        sendJsonError(ws, `Operation failed: ${err.message}`, message.requestId);
      }
      break;
    case 'input':
      handleInputMessage(workspaceId, message, terminalService, logger);
      break;
    case 'resize':
      handleResizeMessage(workspaceId, message, terminalService, logger);
      break;
    case 'destroy':
      handleDestroyMessage(ws, workspaceId, message, terminalService, logger);
      break;
    case 'set_active':
      handleSetActiveMessage(workspaceId, message, terminalService, logger);
      break;
  }
}

async function handleTerminalSocketMessage(
  ws: WebSocket,
  workspaceId: string,
  data: unknown,
  terminalService: AppContext['services']['terminalService'],
  logger: ReturnType<AppContext['services']['createLogger']>
): Promise<void> {
  try {
    await handleTerminalMessage(ws, workspaceId, data as Buffer, terminalService, logger);
  } catch (error) {
    const err = toError(error);
    logger.error('Error handling terminal message', err, { workspaceId });
    sendJsonError(ws, `Operation failed: ${err.message}`);
  }
}

function initializeTerminalWebSocket({
  ws,
  workspaceId,
  terminalService,
  logger,
}: {
  ws: WebSocket;
  workspaceId: string;
  terminalService: AppContext['services']['terminalService'];
  logger: ReturnType<AppContext['services']['createLogger']>;
}): void {
  logger.info('Terminal WebSocket connection established', { workspaceId });

  const untrack = trackConnection(terminalConnections, workspaceId, ws, () => {
    logger.info('All WebSocket connections closed for workspace', {
      workspaceId,
      message: 'Terminals will persist until explicitly closed or workspace is archived/deleted',
    });
  });
  addTerminalCleanupMap(ws);
  logConnectionEstablished(workspaceId, logger);
  sendExistingTerminals(ws, workspaceId, terminalService, logger);

  ws.on('message', (data) => {
    void handleTerminalSocketMessage(ws, workspaceId, data, terminalService, logger);
  });

  ws.on('close', () => {
    logger.info('Terminal WebSocket connection closed', { workspaceId });
    cleanupTerminalListeners(ws, logger);
    // NOTE: Do NOT destroy terminals when navigating away from a workspace.
    // Terminals should persist across navigation and only be destroyed when:
    // 1. User explicitly closes a terminal tab
    // 2. Workspace is archived or deleted
    // 3. Server shuts down
    untrack();
  });

  ws.on('error', (error) => {
    logger.error('Terminal WebSocket error', error);
  });
}

// ============================================================================
// Terminal Upgrade Handler
// ============================================================================

export function createTerminalUpgradeHandler(appContext: AppContext) {
  const terminalService = appContext.services.terminalService;
  const { configService } = appContext.services;
  const logger = appContext.services.createLogger('terminal-handler');

  return createWebSocketUpgradeHandler({
    connectionName: 'terminal WebSocket',
    configService,
    logger,
    requiredParams: ['workspaceId'],
    authorize: async ({ params, socket }) =>
      (await authorizeTerminalWorkspaceUpgrade(params.workspaceId, socket, logger)) ? {} : null,
    onOpen: (ws, { params }) => {
      initializeTerminalWebSocket({
        ws,
        workspaceId: params.workspaceId,
        terminalService,
        logger,
      });
    },
  });
}
