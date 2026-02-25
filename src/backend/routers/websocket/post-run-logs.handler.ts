/**
 * Post-Run Logs WebSocket Handler
 *
 * Handles WebSocket connections for streaming postRun script logs (e.g., cloudflared tunnel).
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { getOrCreateConnectionSet, markWebSocketAlive, sendBadRequest } from './upgrade-utils';

// ============================================================================
// Types
// ============================================================================

/**
 * Map of workspace ID to set of WebSocket connections
 */
export type PostRunLogsConnectionsMap = Map<string, Set<WebSocket>>;

// ============================================================================
// State
// ============================================================================

export const postRunLogsConnections: PostRunLogsConnectionsMap = new Map();

const postRunLogsListenerCleanup = new WeakMap<WebSocket, () => void>();

// ============================================================================
// Post-Run Logs Upgrade Handler
// ============================================================================

export function createPostRunLogsUpgradeHandler(appContext: AppContext) {
  const logger = appContext.services.createLogger('post-run-logs-handler');
  const runScriptService = appContext.services.runScriptService;

  return function handlePostRunLogsUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    wss: WebSocketServer,
    wsAliveMap: WeakMap<WebSocket, boolean>
  ): void {
    const workspaceId = url.searchParams.get('workspaceId');

    if (!workspaceId) {
      logger.warn('Post-run logs WebSocket missing workspaceId');
      sendBadRequest(socket);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      logger.info('Post-run logs WebSocket connection established', { workspaceId });

      markWebSocketAlive(ws, wsAliveMap);

      getOrCreateConnectionSet(postRunLogsConnections, workspaceId).add(ws);

      // Send existing output buffer
      const outputBuffer = runScriptService.getPostRunOutputBuffer(workspaceId);
      if (outputBuffer.length > 0) {
        ws.send(JSON.stringify({ type: 'output', data: outputBuffer }));
      }

      // Subscribe to new output
      const unsubscribe = runScriptService.subscribeToPostRunOutput(workspaceId, (data) => {
        if (ws.readyState === WS_READY_STATE.OPEN) {
          ws.send(JSON.stringify({ type: 'output', data }));
        }
      });
      postRunLogsListenerCleanup.set(ws, unsubscribe);

      ws.on('close', () => {
        logger.info('Post-run logs WebSocket connection closed', { workspaceId });

        const cleanup = postRunLogsListenerCleanup.get(ws);
        if (cleanup) {
          cleanup();
          postRunLogsListenerCleanup.delete(ws);
        }

        const connections = postRunLogsConnections.get(workspaceId);
        if (connections) {
          connections.delete(ws);
          if (connections.size === 0) {
            postRunLogsConnections.delete(workspaceId);
          }
        }
      });

      ws.on('error', (error) => {
        logger.error('Post-run logs WebSocket error', error);
      });
    });
  };
}
