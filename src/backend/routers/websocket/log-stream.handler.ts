/**
 * Workspace Log Stream WebSocket Handlers
 *
 * The two workspace log channels — the run script's own output ("dev logs")
 * and the postRun script's output (e.g. a cloudflared tunnel) — are the same
 * push-only channel built on createPushChannelUpgradeHandler. They differ
 * only in which runScriptService buffer they read and subscribe to, so both
 * are declared here from one shared definition.
 */

import type { AppContext } from '@/backend/app-context';
import { TopicBroadcaster } from '@/backend/lib/topic-broadcaster';
import { createPushChannelUpgradeHandler } from './push-channel.handler';
import type { WebSocketUpgradeHandler } from './upgrade-utils';

type RunScriptService = AppContext['services']['runScriptService'];
type BroadcasterLogger = Pick<ReturnType<AppContext['services']['createLogger']>, 'error'>;

interface LogStreamDefinition {
  loggerName: string;
  connectionName: string;
  getOutputBuffer: (runScriptService: RunScriptService, workspaceId: string) => string;
  subscribeToOutput: (
    runScriptService: RunScriptService,
    workspaceId: string,
    onData: (data: string) => void
  ) => () => void;
}

interface LogStream {
  /** Connections for this channel, keyed by workspace ID. */
  connections: TopicBroadcaster<string>;
  createUpgradeHandler: (appContext: AppContext) => WebSocketUpgradeHandler;
}

function defineLogStream(definition: LogStreamDefinition): LogStream {
  // The broadcaster is a module-level singleton the server imports directly,
  // but the real logger only exists once the application graph is built, so
  // it is late-bound when the upgrade handler is created.
  let broadcasterLogger: BroadcasterLogger = { error: () => undefined };

  const connections = new TopicBroadcaster<string>(
    { error: (...args) => broadcasterLogger.error(...args) },
    'log output'
  );

  const createUpgradeHandler = (appContext: AppContext): WebSocketUpgradeHandler => {
    const { createLogger, runScriptService } = appContext.services;
    broadcasterLogger = createLogger(definition.loggerName);

    return createPushChannelUpgradeHandler(appContext, {
      loggerName: definition.loggerName,
      connectionName: definition.connectionName,
      connections,
      getOutputBuffer: (workspaceId) => definition.getOutputBuffer(runScriptService, workspaceId),
      subscribeToOutput: (workspaceId, onData) =>
        definition.subscribeToOutput(runScriptService, workspaceId, onData),
    });
  };

  return { connections, createUpgradeHandler };
}

const devLogs = defineLogStream({
  loggerName: 'dev-logs-handler',
  connectionName: 'dev logs WebSocket',
  getOutputBuffer: (runScriptService, workspaceId) => runScriptService.getOutputBuffer(workspaceId),
  subscribeToOutput: (runScriptService, workspaceId, onData) =>
    runScriptService.subscribeToOutput(workspaceId, onData),
});

const postRunLogs = defineLogStream({
  loggerName: 'post-run-logs-handler',
  connectionName: 'post-run logs WebSocket',
  getOutputBuffer: (runScriptService, workspaceId) =>
    runScriptService.getPostRunOutputBuffer(workspaceId),
  subscribeToOutput: (runScriptService, workspaceId, onData) =>
    runScriptService.subscribeToPostRunOutput(workspaceId, onData),
});

export const devLogsConnections = devLogs.connections;
export const createDevLogsUpgradeHandler = devLogs.createUpgradeHandler;

export const postRunLogsConnections = postRunLogs.connections;
export const createPostRunLogsUpgradeHandler = postRunLogs.createUpgradeHandler;
