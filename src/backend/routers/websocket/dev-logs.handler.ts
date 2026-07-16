/**
 * Dev Logs WebSocket Handler
 *
 * Handles WebSocket connections for streaming dev server logs from run scripts.
 */

import type { WebSocket } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { createPushChannelUpgradeHandler } from './push-channel.handler';

/**
 * Map of workspace ID to set of WebSocket connections
 */
export type DevLogsConnectionsMap = Map<string, Set<WebSocket>>;

export const devLogsConnections: DevLogsConnectionsMap = new Map();

export function createDevLogsUpgradeHandler(appContext: AppContext) {
  const { runScriptService } = appContext.services;

  return createPushChannelUpgradeHandler(appContext, {
    loggerName: 'dev-logs-handler',
    connectionName: 'dev logs WebSocket',
    connections: devLogsConnections,
    getOutputBuffer: (workspaceId) => runScriptService.getOutputBuffer(workspaceId),
    subscribeToOutput: (workspaceId, onData) =>
      runScriptService.subscribeToOutput(workspaceId, onData),
  });
}
