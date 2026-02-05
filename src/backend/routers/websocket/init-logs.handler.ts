/**
 * Init Logs WebSocket Handler
 *
 * Handles WebSocket connections for streaming init script logs during workspace setup.
 * Similar to dev-logs.handler.ts but for startup script output.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WorkspaceStatus } from '@prisma-gen/client';
import type { WebSocket, WebSocketServer } from 'ws';
import { type AppContext, createAppContext } from '../../app-context';
import { workspaceAccessor } from '../../resource_accessors/workspace.accessor';
import type { createLogger } from '../../services/logger.service';
import type { StartupScriptService } from '../../services/startup-script.service';

// ============================================================================
// Types
// ============================================================================

/**
 * Map of workspace ID to set of WebSocket connections
 */
export type InitLogsConnectionsMap = Map<string, Set<WebSocket>>;

// ============================================================================
// State
// ============================================================================

export const initLogsConnections: InitLogsConnectionsMap = new Map();

const initLogsListenerCleanup = new WeakMap<WebSocket, (() => void)[]>();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Send initial workspace status and buffered output to a newly connected client.
 */
async function sendInitialState(
  ws: WebSocket,
  workspaceId: string,
  startupScriptService: StartupScriptService,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const workspace = await workspaceAccessor.findById(workspaceId);
  if (!workspace) {
    return;
  }

  ws.send(
    JSON.stringify({
      type: 'status',
      status: workspace.status,
      errorMessage: workspace.initErrorMessage,
    })
  );

  // Send existing output from database (for late-joining clients)
  // First check in-memory buffer (more recent), then fall back to database
  const inMemoryBuffer = startupScriptService.getOutputBuffer(workspaceId);
  const dbOutput = workspace.initOutput ?? '';

  // Use whichever is longer (in-memory should be at least as long as DB during active script)
  const existingOutput = inMemoryBuffer.length >= dbOutput.length ? inMemoryBuffer : dbOutput;

  if (existingOutput.length > 0) {
    logger.info('Sending existing init output', { workspaceId, bufferSize: existingOutput.length });
    ws.send(JSON.stringify({ type: 'output', data: existingOutput }));
  } else {
    logger.debug('No init output to send', { workspaceId });
  }
}

/**
 * Set up subscriptions for real-time output and status updates.
 */
function setupSubscriptions(
  ws: WebSocket,
  workspaceId: string,
  startupScriptService: StartupScriptService
): (() => void)[] {
  const cleanupFns: (() => void)[] = [];

  const unsubscribeOutput = startupScriptService.subscribeToOutput(workspaceId, (data: string) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });
  cleanupFns.push(unsubscribeOutput);

  const unsubscribeStatus = startupScriptService.subscribeToStatus(
    workspaceId,
    (status: WorkspaceStatus, errorMessage?: string | null) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'status', status, errorMessage }));
      }
    }
  );
  cleanupFns.push(unsubscribeStatus);

  return cleanupFns;
}

/**
 * Handle WebSocket close event - cleanup subscriptions and connection tracking.
 */
function handleClose(
  ws: WebSocket,
  workspaceId: string,
  logger: ReturnType<typeof createLogger>
): void {
  logger.info('Init logs WebSocket connection closed', { workspaceId });

  const cleanup = initLogsListenerCleanup.get(ws);
  if (cleanup) {
    for (const fn of cleanup) {
      fn();
    }
    initLogsListenerCleanup.delete(ws);
  }

  const connections = initLogsConnections.get(workspaceId);
  if (connections) {
    connections.delete(ws);
    if (connections.size === 0) {
      initLogsConnections.delete(workspaceId);
      logger.info('All init logs WebSocket connections closed for workspace', { workspaceId });
    }
  }
}

// ============================================================================
// Init Logs Upgrade Handler
// ============================================================================

export function createInitLogsUpgradeHandler(appContext: AppContext) {
  const logger = appContext.services.createLogger('init-logs-handler');
  const startupScriptService = appContext.services.startupScriptService;

  return function handleInitLogsUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    wss: WebSocketServer,
    wsAliveMap: WeakMap<WebSocket, boolean>
  ): void {
    const workspaceId = url.searchParams.get('workspaceId');

    if (!workspaceId) {
      logger.warn('Init logs WebSocket missing workspaceId');
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, async (ws) => {
      logger.info('Init logs WebSocket connection established', { workspaceId });

      wsAliveMap.set(ws, true);
      ws.on('pong', () => wsAliveMap.set(ws, true));

      // Track connection
      if (!initLogsConnections.has(workspaceId)) {
        initLogsConnections.set(workspaceId, new Set());
      }
      initLogsConnections.get(workspaceId)?.add(ws);

      // Send initial status
      ws.send(JSON.stringify({ type: 'connected', connected: true }));

      // Send current state and set up subscriptions
      try {
        await sendInitialState(ws, workspaceId, startupScriptService, logger);
      } catch (error) {
        logger.error('Failed to fetch workspace status', error as Error, { workspaceId });
      }

      const cleanupFns = setupSubscriptions(ws, workspaceId, startupScriptService);
      initLogsListenerCleanup.set(ws, cleanupFns);

      ws.on('close', () => handleClose(ws, workspaceId, logger));
      ws.on('error', (error) => logger.error('Init logs WebSocket error', error));
    });
  };
}

export const handleInitLogsUpgrade = createInitLogsUpgradeHandler(createAppContext());
