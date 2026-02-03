/**
 * Dev Logs WebSocket Handler
 *
 * Handles WebSocket connections for streaming dev server logs from run scripts.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { type AppContext, createAppContext } from '../../app-context';

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
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      logger.info('Dev logs WebSocket connection established', { workspaceId });

      wsAliveMap.set(ws, true);
      ws.on('pong', () => wsAliveMap.set(ws, true));

      if (!devLogsConnections.has(workspaceId)) {
        devLogsConnections.set(workspaceId, new Set());
      }
      devLogsConnections.get(workspaceId)?.add(ws);

      logger.debug('Sending initial status message', { workspaceId });
      ws.send(JSON.stringify({ type: 'status', connected: true }));

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
        if (ws.readyState === 1) {
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
