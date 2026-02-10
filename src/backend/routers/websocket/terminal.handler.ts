/**
 * Terminal WebSocket Handler
 *
 * Handles WebSocket connections for terminal sessions.
 * Manages PTY terminal creation, input/output, and lifecycle.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { sessionDataService } from '@/backend/domains/session';
import { workspaceDataService } from '@/backend/domains/workspace';
import { type AppContext, createAppContext } from '../../app-context';
import { WS_READY_STATE } from '../../constants';
import { type TerminalMessageInput, TerminalMessageSchema } from '../../schemas/websocket';
import { toMessageString } from './message-utils';

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

function ensureWorkspaceConnections(workspaceId: string): Set<WebSocket> {
  if (!terminalConnections.has(workspaceId)) {
    terminalConnections.set(workspaceId, new Set());
  }
  return terminalConnections.get(workspaceId) as Set<WebSocket>;
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

  const existingConnections = terminalConnections.get(workspaceId);
  if (existingConnections) {
    for (const existingWs of existingConnections) {
      if (existingWs !== ws) {
        logger.debug('Cleaning up listeners from existing connection', { workspaceId });
        cleanupTerminalListeners(existingWs, logger);
      }
    }
  }

  const cleanupMap = terminalListenerCleanup.get(ws);
  for (const terminal of existingTerminals) {
    const unsubscribers: TerminalUnsubscribers = [];
    if (cleanupMap) {
      cleanupMap.set(terminal.id, unsubscribers);
    }

    const unsubOutput = terminalService.onOutput(terminal.id, (output) => {
      if (ws.readyState === WS_READY_STATE.OPEN) {
        ws.send(JSON.stringify({ type: 'output', terminalId: terminal.id, data: output }));
      }
    });
    unsubscribers.push(unsubOutput);

    const unsubExit = terminalService.onExit(terminal.id, (exitCode) => {
      logger.info('Terminal process exited', { terminalId: terminal.id, exitCode });
      if (ws.readyState === WS_READY_STATE.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', terminalId: terminal.id, exitCode }));
      }
      const exitCleanupMap = terminalListenerCleanup.get(ws);
      if (exitCleanupMap) {
        exitCleanupMap.delete(terminal.id);
      }
      sessionDataService.clearTerminalPid(terminal.id).catch((err) => {
        logger.warn('Failed to clear terminal PID', { terminalId: terminal.id, error: err });
      });
    });
    unsubscribers.push(unsubExit);
  }
}

function parseTerminalMessage(
  workspaceId: string,
  data: unknown,
  logger: ReturnType<AppContext['services']['createLogger']>
): TerminalMessageInput | null {
  const rawMessage: unknown = JSON.parse(toMessageString(data));
  const parseResult = TerminalMessageSchema.safeParse(rawMessage);

  if (!parseResult.success) {
    logger.warn('Invalid terminal message format', {
      workspaceId,
      errors: parseResult.error.issues,
    });
    return null;
  }

  return parseResult.data;
}

function sendSocketError(ws: WebSocket, message: string): void {
  if (ws.readyState === WS_READY_STATE.OPEN) {
    ws.send(JSON.stringify({ type: 'error', message }));
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
    cols: message.cols,
    rows: message.rows,
  });
  const workspace = await workspaceDataService.findById(workspaceId);
  if (!workspace?.worktreePath) {
    logger.warn('Workspace not found or has no worktree', { workspaceId });
    sendSocketError(ws, 'Workspace not found or has no worktree');
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

  await sessionDataService.createTerminalSession({
    workspaceId,
    name: terminalId,
    pid,
  });

  const cleanupMap = terminalListenerCleanup.get(ws);
  const unsubscribers: TerminalUnsubscribers = [];
  if (cleanupMap) {
    cleanupMap.set(terminalId, unsubscribers);
  }

  logger.debug('Setting up output forwarding', { terminalId });
  const unsubOutput = terminalService.onOutput(terminalId, (output) => {
    if (ws.readyState === WS_READY_STATE.OPEN) {
      logger.debug('Forwarding output to client', {
        terminalId,
        outputLen: output.length,
      });
      ws.send(JSON.stringify({ type: 'output', terminalId, data: output }));
    } else {
      logger.warn('Cannot forward output - WebSocket not open', {
        terminalId,
        readyState: ws.readyState,
      });
    }
  });
  unsubscribers.push(unsubOutput);

  const unsubExit = terminalService.onExit(terminalId, (exitCode) => {
    logger.info('Terminal process exited', { terminalId, exitCode });
    if (ws.readyState === WS_READY_STATE.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', terminalId, exitCode }));
    }
    const exitCleanupMap = terminalListenerCleanup.get(ws);
    if (exitCleanupMap) {
      exitCleanupMap.delete(terminalId);
    }
    sessionDataService.clearTerminalPid(terminalId).catch((err) => {
      logger.warn('Failed to clear terminal PID', { terminalId, error: err });
    });
  });
  unsubscribers.push(unsubExit);

  logger.info('Sending created message to client', { terminalId });
  ws.send(JSON.stringify({ type: 'created', terminalId }));
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

function handlePingMessage(ws: WebSocket): void {
  if (ws.readyState === WS_READY_STATE.OPEN) {
    ws.send(JSON.stringify({ type: 'pong' }));
  }
}

async function handleTerminalMessage(
  ws: WebSocket,
  workspaceId: string,
  data: unknown,
  terminalService: AppContext['services']['terminalService'],
  logger: ReturnType<AppContext['services']['createLogger']>
): Promise<void> {
  const message = parseTerminalMessage(workspaceId, data, logger);
  if (!message) {
    sendSocketError(ws, 'Invalid message format');
    return;
  }

  logger.debug('Received terminal message', {
    workspaceId,
    type: message.type,
    terminalId: 'terminalId' in message ? message.terminalId : undefined,
  });

  switch (message.type) {
    case 'create':
      await handleCreateMessage(ws, workspaceId, message, terminalService, logger);
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
    case 'ping':
      handlePingMessage(ws);
      break;
  }
}

// ============================================================================
// Terminal Upgrade Handler
// ============================================================================

export function createTerminalUpgradeHandler(appContext: AppContext) {
  const terminalService = appContext.services.terminalService;
  const logger = appContext.services.createLogger('terminal-handler');

  return function handleTerminalUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    wss: WebSocketServer,
    wsAliveMap: WeakMap<WebSocket, boolean>
  ): void {
    const workspaceId = url.searchParams.get('workspaceId');

    if (!workspaceId) {
      logger.warn('Terminal WebSocket missing workspaceId');
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      logger.info('Terminal WebSocket connection established', { workspaceId });

      wsAliveMap.set(ws, true);
      ws.on('pong', () => wsAliveMap.set(ws, true));

      ensureWorkspaceConnections(workspaceId).add(ws);
      addTerminalCleanupMap(ws);
      logConnectionEstablished(workspaceId, logger);
      sendExistingTerminals(ws, workspaceId, terminalService, logger);

      ws.on('message', async (data) => {
        try {
          await handleTerminalMessage(ws, workspaceId, data as Buffer, terminalService, logger);
        } catch (error) {
          const err = error as Error;
          const isParsError = err instanceof SyntaxError;
          const errorMessage = isParsError
            ? 'Invalid message format'
            : `Operation failed: ${err.message}`;

          logger.error('Error handling terminal message', err, {
            workspaceId,
            isParsError,
          });

          if (ws.readyState === WS_READY_STATE.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: errorMessage }));
          }
        }
      });

      ws.on('close', () => {
        logger.info('Terminal WebSocket connection closed', { workspaceId });

        cleanupTerminalListeners(ws, logger);

        const connections = terminalConnections.get(workspaceId);
        if (connections) {
          connections.delete(ws);
          if (connections.size === 0) {
            terminalConnections.delete(workspaceId);
            logger.info('All WebSocket connections closed for workspace', {
              workspaceId,
              message:
                'Terminals will persist until explicitly closed or workspace is archived/deleted',
            });
            // NOTE: Do NOT destroy terminals when navigating away from a workspace.
            // Terminals should persist across navigation and only be destroyed when:
            // 1. User explicitly closes a terminal tab
            // 2. Workspace is archived or deleted
            // 3. Server shuts down
          }
        }
      });

      ws.on('error', (error) => {
        logger.error('Terminal WebSocket error', error);
      });
    });
  };
}

export const handleTerminalUpgrade = createTerminalUpgradeHandler(createAppContext());
