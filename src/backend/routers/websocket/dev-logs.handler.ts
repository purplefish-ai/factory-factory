/**
 * Dev Logs WebSocket Handler
 *
 * Handles WebSocket connections for streaming dev server logs from run scripts.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { type AppContext, createAppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { getOrCreateConnectionSet, markWebSocketAlive, sendBadRequest } from './upgrade-utils';

// ============================================================================
// Types
// ============================================================================

/**
 * Map of workspace ID to set of WebSocket connections
 */
export type DevLogsConnectionsMap = Map<string, Set<WebSocket>>;

// ============================================================================
// State
// ============================================================================

export const devLogsConnections: DevLogsConnectionsMap = new Map();

const devLogsListenerCleanup = new WeakMap<WebSocket, () => void>();

// ============================================================================
// Dev Logs Upgrade Handler
// ============================================================================

export function createDevLogsUpgradeHandler(appContext: AppContext) {
  const logger = appContext.services.createLogger('dev-logs-handler');
  const runScriptService = appContext.services.runScriptService;

  return function handleDevLogsUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    wss: WebSocketServer,
    wsAliveMap: WeakMap<WebSocket, boolean>
  ): void {
    const workspaceId = url.searchParams.get('workspaceId');

    if (!workspaceId) {
      logger.warn('Dev logs WebSocket missing workspaceId');
      sendBadRequest(socket);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      logger.info('Dev logs WebSocket connection established', { workspaceId });

      markWebSocketAlive(ws, wsAliveMap);

      getOrCreateConnectionSet(devLogsConnections, workspaceId).add(ws);

      logger.debug('Dev logs WebSocket connected', { workspaceId });

      // Send existing output buffer
      const outputBuffer = runScriptService.getOutputBuffer(workspaceId);
      if (outputBuffer.length > 0) {
        logger.info('Sending existing output buffer', {
          workspaceId,
          bufferSize: outputBuffer.length,
        });
        ws.send(JSON.stringify({ type: 'output', data: outputBuffer }));
      } else {
        logger.debug('No output buffer to send', { workspaceId });
      }

      // Subscribe to new output
      const unsubscribe = runScriptService.subscribeToOutput(workspaceId, (data) => {
        if (ws.readyState === WS_READY_STATE.OPEN) {
          ws.send(JSON.stringify({ type: 'output', data }));
        }
      });
      devLogsListenerCleanup.set(ws, unsubscribe);

      ws.on('close', () => {
        logger.info('Dev logs WebSocket connection closed', { workspaceId });

        // Cleanup subscription
        const cleanup = devLogsListenerCleanup.get(ws);
        if (cleanup) {
          cleanup();
          devLogsListenerCleanup.delete(ws);
        }

        const connections = devLogsConnections.get(workspaceId);
        if (connections) {
          connections.delete(ws);
          if (connections.size === 0) {
            devLogsConnections.delete(workspaceId);
            logger.info('All dev logs WebSocket connections closed for workspace', {
              workspaceId,
            });
          }
        }
      });

      ws.on('error', (error) => {
        logger.error('Dev logs WebSocket error', error);
      });
    });
  };
}

export const handleDevLogsUpgrade = createDevLogsUpgradeHandler(createAppContext());
