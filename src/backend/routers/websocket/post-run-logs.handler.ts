/**
 * Post-Run Logs WebSocket Handler
 *
 * Handles WebSocket connections for streaming postRun script logs (e.g., cloudflared tunnel).
 */

import type { AppContext } from '@/backend/app-context';
import { TopicBroadcaster } from '@/backend/lib/topic-broadcaster';
import { createLogger } from '@/backend/services/logger.service';
import { createPushChannelUpgradeHandler } from './push-channel.handler';

/** Post-run logs WebSocket connections, keyed by workspace ID. */
export const postRunLogsConnections = new TopicBroadcaster<string>(
  createLogger('post-run-logs-handler'),
  'log output'
);

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
