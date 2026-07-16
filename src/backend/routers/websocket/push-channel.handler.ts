/**
 * Push-Channel WebSocket Handler Factory
 *
 * Shared implementation for push-only, workspace-scoped log channels (dev
 * logs, post-run logs): on connect, send the existing output buffer, then
 * stream new output until the socket closes.
 */

import type { AppContext } from '@/backend/app-context';
import type { TopicBroadcaster } from '@/backend/lib/topic-broadcaster';
import { safeSend, sendStreamOutput } from '@/backend/lib/websocket-send';
import { createWebSocketUpgradeHandler, type WebSocketUpgradeHandler } from './upgrade-utils';

export interface PushChannelOptions {
  loggerName: string;
  connectionName: string;
  connections: TopicBroadcaster<string>;
  getOutputBuffer: (workspaceId: string) => string;
  subscribeToOutput: (workspaceId: string, onData: (data: string) => void) => () => void;
}

export function createPushChannelUpgradeHandler(
  appContext: AppContext,
  options: PushChannelOptions
): WebSocketUpgradeHandler {
  const { connectionName, connections, getOutputBuffer, subscribeToOutput } = options;
  const logger = appContext.services.createLogger(options.loggerName);
  const { configService } = appContext.services;

  return createWebSocketUpgradeHandler({
    connectionName,
    configService,
    logger,
    requiredParams: ['workspaceId'],
    onOpen: (ws, { params }) => {
      const { workspaceId } = params;
      logger.info(`${connectionName} connection established`, { workspaceId });

      const untrack = connections.subscribe(workspaceId, ws, () => {
        logger.info(`All ${connectionName} connections closed for workspace`, { workspaceId });
      });

      const outputBuffer = getOutputBuffer(workspaceId);
      if (outputBuffer.length > 0) {
        logger.info('Sending existing output buffer', {
          workspaceId,
          bufferSize: outputBuffer.length,
        });
        safeSend(ws, JSON.stringify({ type: 'output', data: outputBuffer }), logger, 'log output');
      }

      const unsubscribe = subscribeToOutput(workspaceId, (data) => {
        sendStreamOutput(ws, JSON.stringify({ type: 'output', data }), logger, 'log output');
      });

      ws.on('close', () => {
        logger.info(`${connectionName} connection closed`, { workspaceId });
        unsubscribe();
        untrack();
      });

      ws.on('error', (error) => {
        logger.error(`${connectionName} error`, error);
      });
    },
  });
}
