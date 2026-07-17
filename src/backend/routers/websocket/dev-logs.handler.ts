/**
 * Dev Logs WebSocket Handler
 *
 * Handles WebSocket connections for streaming dev server logs from run scripts.
 */

import type { AppContext } from '@/backend/app-context';
import { TopicBroadcaster } from '@/backend/lib/topic-broadcaster';
import { createPushChannelUpgradeHandler } from './push-channel.handler';

let broadcasterLogger: Pick<ReturnType<AppContext['services']['createLogger']>, 'error'> = {
  error: () => undefined,
};

/** Dev-logs WebSocket connections, keyed by workspace ID. */
export const devLogsConnections = new TopicBroadcaster<string>(
  { error: (...args) => broadcasterLogger.error(...args) },
  'log output'
);

export function createDevLogsUpgradeHandler(appContext: AppContext) {
  const { createLogger, runScriptService } = appContext.services;
  broadcasterLogger = createLogger('dev-logs-handler');

  return createPushChannelUpgradeHandler(appContext, {
    loggerName: 'dev-logs-handler',
    connectionName: 'dev logs WebSocket',
    connections: devLogsConnections,
    getOutputBuffer: (workspaceId) => runScriptService.getOutputBuffer(workspaceId),
    subscribeToOutput: (workspaceId, onData) =>
      runScriptService.subscribeToOutput(workspaceId, onData),
  });
}
