/**
 * Post-Run Logs WebSocket Handler
 *
 * Handles WebSocket connections for streaming postRun script logs (e.g., cloudflared tunnel).
 */

import type { WebSocket } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { createPushChannelUpgradeHandler } from './push-channel.handler';

/**
 * Map of workspace ID to set of WebSocket connections
 */
export type PostRunLogsConnectionsMap = Map<string, Set<WebSocket>>;

export const postRunLogsConnections: PostRunLogsConnectionsMap = new Map();

export function createPostRunLogsUpgradeHandler(appContext: AppContext) {
  const { runScriptService } = appContext.services;

  return createPushChannelUpgradeHandler(appContext, {
    loggerName: 'post-run-logs-handler',
    connectionName: 'post-run logs WebSocket',
    connections: postRunLogsConnections,
    getOutputBuffer: (workspaceId) => runScriptService.getPostRunOutputBuffer(workspaceId),
    subscribeToOutput: (workspaceId, onData) =>
      runScriptService.subscribeToPostRunOutput(workspaceId, onData),
  });
}
