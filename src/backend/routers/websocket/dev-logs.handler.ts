/**
 * Dev Logs WebSocket Handler
 *
 * Handles WebSocket connections for streaming dev server logs from run scripts.
 */

import type { AppContext } from '@/backend/app-context';
import { TopicBroadcaster } from '@/backend/lib/topic-broadcaster';
import { createLogger } from '@/backend/services/logger.service';
import { createPushChannelUpgradeHandler } from './push-channel.handler';

/** Dev-logs WebSocket connections, keyed by workspace ID. */
export const devLogsConnections = new TopicBroadcaster<string>(
  createLogger('dev-logs-handler'),
  'log output'
);

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
